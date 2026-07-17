import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  query,
  tool,
  createSdkMcpServer,
  type AgentDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { getStore } from "../shared/store.js";
import type { Draft } from "../shared/types.js";
import { buildHooks } from "../hooks/guardrails.js";
import { sendDraftForApproval } from "./telegram.js";
import { research } from "../tools/grok.js";
import { resolveDataSourceId, queryDataSource } from "../tools/notion.js";
import { generateImage } from "../tools/zero.js";

type QueryOptions = NonNullable<Parameters<typeof query>[0]["options"]>;

const WRITEGUARD_URL = process.env.WRITEGUARD_URL ?? "http://localhost:8787/mcp";
const READ_TOOLS = [
  "mcp__reads__grok_research",
  "mcp__reads__notion_query",
  "mcp__reads__zero_generate_image",
];

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function loadPersistentRules(): string {
  try {
    return fs.readFileSync("config/persistent-rules.md", "utf8");
  } catch {
    return "";
  }
}

// Subagents receive only their prompt string, so the tone skill must be read
// Node-side and injected as prompt text. Without this the "your voice" wedge
// has no voice source at generation time.
function loadToneSkill(): string {
  try {
    return fs.readFileSync("skills/tone/SKILL.md", "utf8");
  } catch {
    return "";
  }
}

function systemPrompt(): QueryOptions["systemPrompt"] {
  return { type: "preset", preset: "claude_code", append: loadPersistentRules() };
}

// Each pack agent file is loaded as a programmatic subagent. Subagents get read
// tools only so the write path stays with the orchestrator run.
function loadAgents(): Record<string, AgentDefinition> | undefined {
  try {
    const files = fs.readdirSync("agents").filter((f) => f.endsWith(".md"));
    const out: Record<string, AgentDefinition> = {};
    for (const f of files) {
      const name = f.replace(/\.md$/, "");
      const base = fs.readFileSync(path.join("agents", f), "utf8");
      const prompt =
        name === "content-writer"
          ? `${base}\n\n## Tone skill (obey exactly)\n${loadToneSkill()}`
          : base;
      out[name] = {
        description: `SignalCMO ${name} subagent`,
        prompt,
        tools: ["mcp__reads__grok_research", "mcp__reads__notion_query"],
      };
    }
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

function loadLoopBudget(loop: string): { maxTurns: number; maxBudgetUsd: number } {
  const def = { maxTurns: 25, maxBudgetUsd: 1.5 };
  try {
    const raw = fs.readFileSync("config/schedule.yaml", "utf8");
    const doc = parseYaml(raw) as
      | { loops?: Record<string, { max_turns?: number; budget_usd?: number }> }
      | null;
    const l = doc?.loops?.[loop];
    if (l) {
      return {
        maxTurns: l.max_turns ?? def.maxTurns,
        maxBudgetUsd: l.budget_usd ?? def.maxBudgetUsd,
      };
    }
  } catch {
    // fall through to defaults
  }
  return def;
}

// In-process read tools with real zod schemas so the model reliably passes
// named args (an empty schema strips every key at validation time). These are
// read-only; the only write path is the remote write-server.
function buildReadServer(imageHolder: { url: string }) {
  const grokTool = tool(
    "grok_research",
    "Research X/Twitter and the web via Grok.",
    { brief: z.string() },
    async (args) => {
      const res = await research({ brief: args.brief });
      return { content: [{ type: "text" as const, text: JSON.stringify(res) }] };
    },
  );

  const notionTool = tool(
    "notion_query",
    "Read a Notion data source by name (for example Learnings).",
    { dataSource: z.string(), filter: z.record(z.string(), z.unknown()).optional() },
    async (args) => {
      const dsId = await resolveDataSourceId(args.dataSource);
      const rows = await queryDataSource(dsId, args.filter);
      return { content: [{ type: "text" as const, text: JSON.stringify(rows) }] };
    },
  );

  const imageTool = tool(
    "zero_generate_image",
    "Generate a post image via Zero. Returns the hosted URL.",
    { prompt: z.string() },
    async (args) => {
      const out = (await generateImage(args.prompt)) as unknown;
      const url =
        typeof out === "string"
          ? out
          : String(
              (out as { url?: string; mediaUrl?: string }).url ??
                (out as { url?: string; mediaUrl?: string }).mediaUrl ??
                "",
            );
      imageHolder.url = url;
      return { content: [{ type: "text" as const, text: url || "image generation failed" }] };
    },
  );

  return createSdkMcpServer({
    name: "reads",
    version: "1.0.0",
    tools: [grokTool, notionTool, imageTool],
  });
}

function baseOptions(
  readServer: ReturnType<typeof buildReadServer>,
  allowedTools: string[],
  loop: string,
  resume?: string,
): QueryOptions {
  const budget = loadLoopBudget(loop);
  const options: QueryOptions = {
    systemPrompt: systemPrompt(),
    mcpServers: {
      reads: readServer,
      writeguard: {
        type: "http",
        url: WRITEGUARD_URL,
        alwaysLoad: true,
        headers: process.env.WRITEGUARD_TOKEN
          ? { Authorization: `Bearer ${process.env.WRITEGUARD_TOKEN}` }
          : {},
      },
    },
    hooks: buildHooks(),
    allowedTools,
    maxTurns: budget.maxTurns,
    maxBudgetUsd: budget.maxBudgetUsd,
  };
  const agents = loadAgents();
  if (agents) options.agents = agents;
  if (resume) options.resume = resume;
  return options;
}

// The SDK yields a terminal result message (type "result") that may carry an
// error subtype instead of throwing, so success is derived from that message.
// Genuine throws are also caught and reported as failure.
async function drive(
  prompt: string,
  options: QueryOptions,
): Promise<{ text: string; sessionId?: string; ok: boolean }> {
  let text = "";
  let sessionId: string | undefined;
  let ok = false;
  try {
    for await (const m of query({ prompt, options })) {
      const msg = m as unknown as {
        session_id?: string;
        type?: string;
        subtype?: string;
        is_error?: boolean;
        result?: string;
      };
      if (msg.session_id) sessionId = msg.session_id;
      if (msg.type === "result") {
        ok = msg.subtype === "success" && msg.is_error !== true;
        if (typeof msg.result === "string") text = msg.result;
      }
    }
  } catch (e) {
    console.error("[orchestrator] query run failed:", errMsg(e));
    ok = false;
  }
  return { text, sessionId, ok };
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// RUN 1: draft only. Reads recent Learnings and injects them, generates an image
// through the read tool, persists a pending draft, and hands it to Telegram. It
// never posts; posting happens in a separate run after human approval.
export async function runContentDraft(input?: {
  slot?: string;
  goal?: string;
}): Promise<{ draftId: string; sessionId?: string }> {
  const store = getStore();
  const learnings = store.recentLearnings(10);
  const learningsText = learnings.length
    ? learnings
        .map((l) => `- [${l.id}] (${l.what}) ${l.observed} -> ${l.hypothesis}`)
        .join("\n")
    : "none yet";

  const imageHolder = { url: "" };
  const readServer = buildReadServer(imageHolder);
  const tone = loadToneSkill();
  const prompt = [
    "Draft one original X post in the principal voice for today.",
    tone ? `Tone skill (obey exactly):\n${tone}` : "",
    input?.slot ? `Target slot: ${input.slot}.` : "",
    input?.goal ? `Primary goal: ${input.goal}.` : "",
    "Recent Learnings to apply (name the Learning id you used):",
    learningsText,
    "Use grok_research for a fresh signal brief and notion_query for extra context if useful.",
    "Call zero_generate_image once with a prompt for a matching image.",
    "Do not post. Return only the final post text as your last message.",
  ]
    .filter(Boolean)
    .join("\n");

  const { text, sessionId, ok } = await drive(
    prompt,
    baseOptions(readServer, [...READ_TOOLS, "Task"], "content"),
  );
  if (!ok || !text.trim()) {
    console.error("[orchestrator] draft run failed or empty; not sending for approval");
    return { draftId: "", sessionId };
  }

  const now = new Date().toISOString();
  const draftId = newId("d");
  const draft: Draft = {
    id: draftId,
    type: "post",
    text: text.trim(),
    mediaUrl: imageHolder.url || undefined,
    slot: input?.slot,
    status: "pending_approval",
    sessionId,
    appliedLearningId: learnings[0]?.id,
    createdAt: now,
    updatedAt: now,
  };
  store.putDraft(draft);

  try {
    await sendDraftForApproval(draft);
  } catch (e) {
    console.error("[orchestrator] telegram send failed:", errMsg(e));
  }
  return { draftId, sessionId };
}

function extractPostId(text: string): string | undefined {
  const keyed = text.match(/"?(?:postId|id|tweet_id)"?\s*[:=]\s*"?(\d{5,25})"?/i);
  if (keyed) return keyed[1];
  const bare = text.match(/\b(\d{15,25})\b/);
  return bare ? bare[1] : undefined;
}

// RUN 2: post an approved draft. Resumes the draft session when one exists. The
// only posting path is the mcp__writeguard__post_tweet tool. The write-server
// uploads media, records the Post row, bumps the daily counter, and enqueues the
// impact jobs, so this run does not touch the store; it only reports the id.
export async function runContentPost(draftId: string): Promise<{ postId?: string }> {
  const store = getStore();
  const draft = store.getDraft(draftId);
  if (!draft) {
    console.error(`[orchestrator] runContentPost: unknown draft ${draftId}`);
    return {};
  }

  const imageHolder = { url: draft.mediaUrl ?? "" };
  const readServer = buildReadServer(imageHolder);
  const prompt = [
    `Publish the approved draft ${draftId}.`,
    `Call mcp__writeguard__post_tweet with {"draftId":"${draftId}"} exactly once.`,
    "Do not change the approved text. Report the returned tweet id.",
  ].join("\n");

  const { text } = await drive(
    prompt,
    baseOptions(
      readServer,
      ["mcp__writeguard__post_tweet", "Task"],
      "tg_webhook",
      draft.sessionId,
    ),
  );

  const postId = extractPostId(text);
  if (!postId) {
    console.error(`[orchestrator] runContentPost: no tweet id returned for ${draftId}`);
  }
  return { postId };
}
