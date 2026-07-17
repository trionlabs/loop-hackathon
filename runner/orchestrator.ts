import fs from "node:fs";
import { chat, type ChatMessage, type ToolSpec } from "../tools/akashml.js";
import { getStore } from "../shared/store.js";
import { requireEnv } from "../shared/env.js";
import type { Draft } from "../shared/types.js";
import { sendDraftForApproval } from "./telegram.js";
import { research } from "../tools/grok.js";
import { resolveDataSourceId, queryDataSource } from "../tools/notion.js";
import { generateImage } from "../tools/zero.js";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function readFileSafe(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

// Read-only tools the drafting model may call. The write path is never exposed
// here; posting goes through the write-server after human approval.
const READ_TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "grok_research",
      description: "Research X/Twitter and the web via Grok. Returns findings and citations.",
      parameters: {
        type: "object",
        properties: { brief: { type: "string", description: "what to research" } },
        required: ["brief"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "notion_query",
      description: "Read a Notion data source by name, for example Learnings.",
      parameters: {
        type: "object",
        properties: { dataSource: { type: "string" } },
        required: ["dataSource"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "zero_generate_image",
      description: "Generate a post image via Zero. Returns the hosted image URL.",
      parameters: {
        type: "object",
        properties: { prompt: { type: "string", description: "image description" } },
        required: ["prompt"],
      },
    },
  },
];

async function execTool(
  name: string,
  args: Record<string, unknown>,
  imageHolder: { url: string },
): Promise<string> {
  try {
    if (name === "grok_research") {
      return JSON.stringify(await research({ brief: String(args.brief ?? "") }));
    }
    if (name === "notion_query") {
      const ds = await resolveDataSourceId(String(args.dataSource ?? ""));
      return JSON.stringify(await queryDataSource(ds));
    }
    if (name === "zero_generate_image") {
      const out = (await generateImage(String(args.prompt ?? ""))) as {
        url?: string;
        mediaUrl?: string;
      };
      imageHolder.url = out.url ?? out.mediaUrl ?? "";
      return imageHolder.url || "image generation failed";
    }
    return `unknown tool ${name}`;
  } catch (e) {
    return `tool ${name} error: ${errMsg(e)}`;
  }
}

function toolLabel(name: string): string {
  if (name === "grok_research") return "Grok x_search: reading live X";
  if (name === "notion_query") return "Notion: reading memory";
  if (name === "zero_generate_image") return "Zero: generating image";
  return name;
}

// Manual OpenAI-style tool-calling loop against AkashML (open model). Replaces
// the Claude Agent SDK: the model may call read tools; each result is fed back
// until it returns a final text message with no tool calls.
async function draftLoop(
  system: string,
  user: string,
  imageHolder: { url: string },
  maxTurns = 4,
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  for (let turn = 0; turn < maxTurns; turn++) {
    const msg = await chat({ messages, tools: READ_TOOLS });
    messages.push(msg);
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          args = {};
        }
        getStore().appendEvent({
          loop: "content",
          agent: "content-writer",
          phase: "tool",
          kind: "tool",
          detail: toolLabel(tc.function.name),
        });
        const result = await execTool(tc.function.name, args, imageHolder);
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.function.name,
          content: result,
        });
      }
      continue;
    }
    return (msg.content ?? "").trim();
  }
  const last = [...messages].reverse().find((m) => m.role === "assistant" && m.content);
  return (last?.content ?? "").trim();
}

// RUN 1: draft only. Builds the drafting system prompt from the persistent
// rules, the content-writer role, and the tone skill (injected as text since
// there are no SDK subagents). Reads recent Learnings and injects them. Never
// posts.
export async function runContentDraft(input?: {
  slot?: string;
  goal?: string;
}): Promise<{ draftId: string }> {
  const store = getStore();
  store.appendEvent({
    loop: "content",
    agent: "content-writer",
    phase: "start",
    kind: "info",
    detail: "content loop started: drafting today's post",
  });
  const learnings = store.recentLearnings(10);
  const learningsText = learnings.length
    ? learnings.map((l) => `- [${l.id}] (${l.what}) ${l.observed} -> ${l.hypothesis}`).join("\n")
    : "none yet";

  const system = [
    readFileSafe("config/persistent-rules.md"),
    readFileSafe("agents/content-writer.md"),
    "## Tone skill (obey exactly)",
    readFileSafe("skills/tone/SKILL.md"),
  ]
    .filter(Boolean)
    .join("\n\n");

  const user = [
    "Draft one original X post in the principal voice for today.",
    input?.slot ? `Target slot: ${input.slot}.` : "",
    input?.goal ? `Primary goal: ${input.goal}.` : "",
    "Recent Learnings to apply (name the Learning id you used):",
    learningsText,
    "Call grok_research at most once for a fresh signal brief (skip if not needed).",
    "Call zero_generate_image at most once for a matching image.",
    "Then reply with ONLY the final post text, no preamble. Do not call more tools after drafting.",
  ]
    .filter(Boolean)
    .join("\n");

  const imageHolder = { url: "" };
  let text = "";
  try {
    text = await draftLoop(system, user, imageHolder);
  } catch (e) {
    console.error("[orchestrator] draft run failed:", errMsg(e));
  }
  if (!text) {
    console.error("[orchestrator] empty draft; not sending for approval");
    return { draftId: "" };
  }

  const now = new Date().toISOString();
  const draftId = `d_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const draft: Draft = {
    id: draftId,
    type: "post",
    text,
    mediaUrl: imageHolder.url || undefined,
    slot: input?.slot,
    status: "pending_approval",
    appliedLearningId: learnings[0]?.id,
    createdAt: now,
    updatedAt: now,
  };
  store.putDraft(draft);
  store.appendEvent({
    loop: "content",
    agent: "content-writer",
    phase: "draft",
    kind: "draft",
    detail: `draft ready for approval${learnings[0] ? ` (applied learning ${learnings[0].id})` : ""}`,
  });

  try {
    await sendDraftForApproval(draft);
  } catch (e) {
    console.error("[orchestrator] telegram send failed:", errMsg(e));
  }
  return { draftId };
}

// RUN 2: publish an approved draft. The human already approved, so posting is
// mechanical: call the write-server, which holds the credentials and enforces
// every guard. No model turn is needed.
export async function runContentPost(draftId: string): Promise<{ postId?: string }> {
  const url = process.env.WRITEGUARD_URL ?? "http://localhost:8787/post";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${requireEnv("WRITEGUARD_TOKEN")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ draftId }),
    });
    const data = (await res.json().catch(() => ({}))) as { postId?: string; error?: string };
    if (!res.ok) {
      console.error(`[orchestrator] post failed ${res.status}:`, data.error ?? "");
      return {};
    }
    return { postId: data.postId };
  } catch (e) {
    console.error("[orchestrator] runContentPost failed:", errMsg(e));
    return {};
  }
}
