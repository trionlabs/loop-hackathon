import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { getStore } from "../shared/store.js";
import { limits } from "../shared/env.js";
import type { ContentType } from "../shared/types.js";

// The write path the agent can reach is the remote MCP write-server registered
// under the key "writeguard", so the real tool name is mcp__writeguard__post_tweet.
// A matcher containing "." is treated as an unanchored regex and never matches
// that name, which would fail open. Anchor on the real mcp__ name instead.
const POST_TWEET_MATCHER = "^mcp__writeguard__post_tweet";
const FILE_WRITE_MATCHER = "Write|Edit";
const TONE_WRITE_ROOT = path.resolve("skills/tone");

function deny(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  };
}

function allow(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "allow" as const,
      permissionDecisionReason: reason,
    },
  };
}

function trigrams(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const grams = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) {
    grams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  if (words.length > 0 && words.length < 3) grams.add(words.join(" "));
  return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Duplicate when any recent post shares a 3-gram Jaccard of 0.5 or more.
function isDuplicate(text: string, recent: string[]): boolean {
  const cand = trigrams(text);
  for (const r of recent) {
    if (jaccard(cand, trigrams(r)) >= 0.5) return true;
  }
  return false;
}

interface EmbargoConfig {
  topics: string[];
  crisis: string[];
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function loadEmbargo(): EmbargoConfig {
  try {
    const raw = fs.readFileSync("config/embargo.yaml", "utf8");
    const doc = parseYaml(raw) as Record<string, unknown> | null;
    return {
      topics: toStringArray(doc?.["topics"]),
      crisis: toStringArray(doc?.["crisis_keywords"] ?? doc?.["crisis"]),
    };
  } catch {
    return { topics: [], crisis: [] };
  }
}

function matchEmbargo(text: string, cfg: EmbargoConfig): string | null {
  const hay = text.toLowerCase();
  for (const term of [...cfg.topics, ...cfg.crisis]) {
    const t = term.toLowerCase().trim();
    if (t && hay.includes(t)) return term;
  }
  return null;
}

function loadAutonomy(): Partial<Record<ContentType, boolean>> {
  try {
    const raw = fs.readFileSync("config/autonomy.json", "utf8");
    return JSON.parse(raw) as Partial<Record<ContentType, boolean>>;
  } catch {
    return {};
  }
}

function dailyLimit(type: ContentType): number {
  return type === "reply" ? limits.maxRepliesPerDay : limits.maxPostsPerDay;
}

// Logs every tool call so the real mcp__ names can be confirmed at runtime.
const logTool: HookCallback = async (input) => {
  if (input.hook_event_name === "PreToolUse") {
    console.log("[hook] PreToolUse tool:", (input as PreToolUseHookInput).tool_name);
  }
  return {};
};

// Fail closed: any throw denies. Trusts only draftId from the tool input and
// re-derives every check from the local store and the on-disk config.
const guardPostTweet: HookCallback = async (input) => {
  try {
    if (input.hook_event_name !== "PreToolUse") return {};
    const pre = input as PreToolUseHookInput;
    const rawInput = pre.tool_input as { draftId?: unknown } | null | undefined;
    const draftId = typeof rawInput?.draftId === "string" ? rawInput.draftId : "";
    if (!draftId) return deny("missing draftId");

    const store = getStore();
    if (store.getFlag("killswitch")) return deny("killswitch engaged");
    if (store.getFlag("paused")) return deny("posting is paused");
    if (store.getFlag("crisis")) return deny("crisis flag set");

    const draft = store.getDraft(draftId);
    if (!draft) return deny(`unknown draft ${draftId}`);

    const approval = store.getApproval(draftId);
    const approved =
      approval?.decision === "approved" || approval?.decision === "edited";
    const autonomy = loadAutonomy();
    const autopilot = autonomy[draft.type] === true;
    if (!approved && !autopilot) {
      return deny("no human approval and autopilot is off for this type");
    }

    const limit = dailyLimit(draft.type);
    if (store.getDailyCount(draft.type) >= limit) {
      return deny(`daily max reached for ${draft.type} (${limit})`);
    }

    if (isDuplicate(draft.text, store.recentPostedTexts(90))) {
      return deny("draft too similar to a post from the last 90 days");
    }

    const hit = matchEmbargo(draft.text, loadEmbargo());
    if (hit) return deny(`embargoed topic present: ${hit}`);

    return allow("all server-side guards passed");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return deny(`guard error, failing closed: ${msg}`);
  }
};

// Built-in file writes are limited to the tone skill directory. config/ holds
// autonomy.json, embargo.yaml and .env, so allowing writes there would let the
// agent flip its own autopilot or empty its embargo list.
const guardFileWrite: HookCallback = async (input) => {
  try {
    if (input.hook_event_name !== "PreToolUse") return {};
    const pre = input as PreToolUseHookInput;
    const fp = (pre.tool_input as { file_path?: unknown } | null | undefined)?.file_path;
    if (typeof fp !== "string" || fp.length === 0) return deny("missing file_path");
    const abs = path.resolve(fp);
    if (abs === TONE_WRITE_ROOT || abs.startsWith(TONE_WRITE_ROOT + path.sep)) {
      return allow("path under skills/tone");
    }
    return deny("file writes are limited to skills/tone/");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return deny(`file guard error, failing closed: ${msg}`);
  }
};

export function buildHooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PreToolUse: [
      { hooks: [logTool] },
      { matcher: POST_TWEET_MATCHER, hooks: [guardPostTweet] },
      { matcher: FILE_WRITE_MATCHER, hooks: [guardFileWrite] },
    ],
  };
}
