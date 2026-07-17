import path from "node:path";
import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { getStore } from "../shared/store.js";
import { limits } from "../shared/env.js";
import {
  effectiveText,
  isDuplicate,
  loadAutonomy,
  loadEmbargo,
  matchEmbargo,
} from "../shared/config.js";
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
// re-derives every check from the local store and the on-disk config. Screens
// the text that will actually post (the human edit when present).
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
    if (approval?.decision === "rejected") return deny("draft was rejected by a human");

    const approved =
      approval?.decision === "approved" || approval?.decision === "edited";
    const autopilot = loadAutonomy()[draft.type] === true;
    if (!approved && !autopilot) {
      return deny("no human approval and autopilot is off for this type");
    }

    const limit = dailyLimit(draft.type);
    if (store.getDailyCount(draft.type) >= limit) {
      return deny(`daily max reached for ${draft.type} (${limit})`);
    }

    const text = effectiveText(draft, approval);
    if (isDuplicate(text, store.recentPostedTexts(90))) {
      return deny("draft too similar to a post from the last 90 days");
    }

    const emb = loadEmbargo();
    if (!emb) return deny("embargo config unavailable, failing closed");
    const hit = matchEmbargo(text, emb);
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
