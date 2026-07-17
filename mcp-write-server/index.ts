import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Checkpoint, ContentType, ImpactJob, Post } from "../shared/types.js";
import { getStore } from "../shared/store.js";
import { limits, optionalEnv } from "../shared/env.js";
import {
  effectiveText,
  isDuplicate,
  loadAutonomy,
  loadEmbargo,
  matchEmbargo,
} from "../shared/config.js";
import { postTweet, uploadMedia } from "../tools/x.js";
import { createRow } from "../tools/notion.js";
import { syncPost } from "../shared/notion-sync.js";

// The write-server is the SOLE holder of write capability and the SINGLE
// enforcement point for every guardrail. tools/x.ts and tools/notion.ts are
// imported here as internal functions and are never exposed to the agent. Since
// the Claude Agent SDK (and its PreToolUse hooks) is gone, all guards
// (approval, reject, kill switch, daily max, duplicate, embargo, idempotency)
// are re-derived here from the durable store and the on-disk config.

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function fail(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function mimeFromUrl(url: string): string {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/png";
}

function dailyLimit(type: ContentType): number {
  return type === "reply" ? limits.maxRepliesPerDay : limits.maxPostsPerDay;
}

const CHECKPOINTS: { checkpoint: Checkpoint; ms: number }[] = [
  { checkpoint: "1h", ms: 3600000 },
  { checkpoint: "24h", ms: 86400000 },
  { checkpoint: "72h", ms: 259200000 },
];

// The one function that can publish. Fails closed: any guard that cannot be
// satisfied refuses the post. Idempotent on already-posted drafts.
async function postDraft(draftId: string): Promise<{ ok: boolean; postId?: string; error?: string }> {
  const store = getStore();
  const draft = store.getDraft(draftId);
  if (!draft) return { ok: false, error: `unknown draft ${draftId}` };

  const existing = store.getPostByDraft(draftId);
  if (draft.status === "posted" || existing) {
    return { ok: true, postId: existing?.id };
  }

  if (store.getFlag("killswitch")) return { ok: false, error: "killswitch engaged" };
  if (store.getFlag("paused")) return { ok: false, error: "posting is paused" };
  if (store.getFlag("crisis")) return { ok: false, error: "crisis flag set" };

  const approval = store.getApproval(draftId);
  if (approval?.decision === "rejected") return { ok: false, error: "draft was rejected" };
  const approved = approval?.decision === "approved" || approval?.decision === "edited";
  const autopilot = loadAutonomy()[draft.type] === true;
  if (!approved && !autopilot) return { ok: false, error: "no human approval" };

  const text = effectiveText(draft, approval);

  if (store.getDailyCount(draft.type) >= dailyLimit(draft.type)) {
    return { ok: false, error: `daily max reached for ${draft.type}` };
  }
  if (isDuplicate(text, store.recentPostedTexts(90))) {
    return { ok: false, error: "duplicate of a recent post" };
  }
  const emb = loadEmbargo();
  if (!emb) return { ok: false, error: "embargo config unavailable, failing closed" };
  const hit = matchEmbargo(text, emb);
  if (hit) return { ok: false, error: `embargoed topic: ${hit}` };

  let mediaIds: string[] | undefined;
  if (draft.mediaUrl) {
    try {
      const media = await uploadMedia({ url: draft.mediaUrl, mime: mimeFromUrl(draft.mediaUrl) });
      mediaIds = [media.mediaId];
    } catch (e) {
      console.error(
        "[writeguard] media upload failed, posting text-only:",
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  let posted: { id: string };
  try {
    posted = await postTweet({ text, mediaIds });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes(" 403")) {
      return {
        ok: false,
        error: "X rejected this post (rate limit or duplicate). Wait a few minutes or edit the text.",
      };
    }
    return { ok: false, error: `X post failed: ${msg.slice(0, 140)}` };
  }
  const now = Date.now();
  const post: Post = {
    id: posted.id,
    draftId,
    text,
    type: draft.type,
    postedAt: new Date(now).toISOString(),
  };
  store.putPost(post);
  store.addPostedText(text);
  store.incDailyCount(draft.type);
  store.setDraftStatus(draftId, "posted");
  for (const c of CHECKPOINTS) {
    const job: ImpactJob = {
      postId: posted.id,
      dueAt: new Date(now + c.ms).toISOString(),
      checkpoint: c.checkpoint,
      done: false,
    };
    store.addImpactJob(job);
  }
  store.appendEvent({
    loop: "post",
    agent: "orchestrator",
    phase: "posted",
    kind: "post",
    detail: `posted to X (${posted.id}); impact jobs queued T+1h/24h/72h`,
  });
  // Mirror to the Notion visible brain, best effort (never blocks the post).
  void syncPost(post).catch((e) => console.error("[writeguard] notion sync failed:", e));
  return { ok: true, postId: posted.id };
}

async function notionWrite(
  dataSourceId: string,
  properties: Record<string, unknown>,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (getStore().getFlag("killswitch")) return { ok: false, error: "killswitch engaged" };
  const row = await createRow(dataSourceId, properties);
  return { ok: true, id: row.id };
}

// MCP surface, kept so Pomerium can gate tool calls by name (the admin_reset
// deny demo). The agent posts via the REST route below, not through here.
function buildServer(): Server {
  const server = new Server(
    { name: "signalcmo-write", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "post_tweet",
        description: "Post an approved draft to X. Refuses drafts without approval.",
        inputSchema: {
          type: "object",
          properties: { draftId: { type: "string" } },
          required: ["draftId"],
        },
      },
      {
        name: "notion_write",
        description: "Create a row in a Notion data source.",
        inputSchema: {
          type: "object",
          properties: {
            dataSourceId: { type: "string" },
            properties: { type: "object" },
          },
          required: ["dataSourceId", "properties"],
        },
      },
      {
        name: "admin_reset",
        description: "Reserved administrative reset. Always denied.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const input = (args ?? {}) as Record<string, unknown>;
    try {
      if (name === "post_tweet") {
        const r = await postDraft(String(input.draftId ?? ""));
        return r.ok ? ok(`posted ${r.postId ?? ""}`) : fail(r.error ?? "post failed");
      }
      if (name === "notion_write") {
        const r = await notionWrite(
          String(input.dataSourceId ?? ""),
          (input.properties ?? {}) as Record<string, unknown>,
        );
        return r.ok ? ok(`created notion row ${r.id ?? ""}`) : fail(r.error ?? "write failed");
      }
      if (name === "admin_reset") return fail("not permitted");
      return fail(`unknown tool ${name}`);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  return server;
}

function bearerOk(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const expected = `Bearer ${token}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function startWriteServer(): Promise<void> {
  const token = optionalEnv("WRITEGUARD_TOKEN");
  if (!token) throw new Error("WRITEGUARD_TOKEN must be set to start the write server");

  const app = express();
  app.use(express.json());

  const requireBearer: express.RequestHandler = (req, res, next) => {
    if (!bearerOk(req.headers.authorization, token)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };

  // REST route the orchestrator calls to publish an approved draft.
  app.post("/post", requireBearer, async (req, res) => {
    try {
      const r = await postDraft(String((req.body as { draftId?: unknown })?.draftId ?? ""));
      res.status(r.ok ? 200 : 400).json(r);
    } catch (err) {
      console.error("[writeguard] /post failed:", err);
      res.status(500).json({ ok: false, error: "internal error" });
    }
  });

  // MCP route (stateless streamable-HTTP), fronted by Pomerium for the
  // tool-name deny demo.
  app.post("/mcp", requireBearer, async (req, res) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[writeguard] /mcp failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "internal error" });
    }
  });

  // Loopback by default. Set WRITE_SERVER_HOST=0.0.0.0 when Pomerium runs in
  // Docker and must reach this process via host.docker.internal; the bearer
  // token and the proxy remain the gate.
  const host = optionalEnv("WRITE_SERVER_HOST") ?? "127.0.0.1";
  const port = Number(optionalEnv("WRITE_SERVER_PORT") ?? 8787);
  await new Promise<void>((resolve) => {
    app.listen(port, host, () => resolve());
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startWriteServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
