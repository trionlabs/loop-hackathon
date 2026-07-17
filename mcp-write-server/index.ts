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
import type { Checkpoint, ImpactJob, Post } from "../shared/types.js";
import { getStore } from "../shared/store.js";
import { optionalEnv } from "../shared/env.js";
import { effectiveText, loadAutonomy } from "../shared/config.js";
import { postTweet, uploadMedia } from "../tools/x.js";
import { createRow } from "../tools/notion.js";

// tools/x.ts and tools/notion.ts are imported here as internal functions.
// They are never registered as agent tools anywhere, so this server is the
// sole holder of write capability. Approval, kill switch and idempotency are
// re-derived here from the durable store, independent of any proxy or hook.

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

const CHECKPOINTS: { checkpoint: Checkpoint; ms: number }[] = [
  { checkpoint: "1h", ms: 3600000 },
  { checkpoint: "24h", ms: 86400000 },
  { checkpoint: "72h", ms: 259200000 },
];

async function postTweetTool(draftId: string): Promise<CallToolResult> {
  const store = getStore();
  const draft = store.getDraft(draftId);
  if (!draft) return fail(`unknown draft ${draftId}`);

  // Idempotency: never post the same draft twice.
  const existing = store.getPostByDraft(draftId);
  if (draft.status === "posted" || existing) {
    return ok(`already posted${existing ? ` ${existing.id}` : ""}`);
  }

  if (store.getFlag("killswitch")) return fail("killswitch engaged");
  if (store.getFlag("paused")) return fail("posting is paused");
  if (store.getFlag("crisis")) return fail("crisis flag set");

  const approval = store.getApproval(draftId);
  if (approval?.decision === "rejected") {
    return fail(`draft ${draftId} was rejected; refusing to post`);
  }
  const approved =
    approval?.decision === "approved" || approval?.decision === "edited";
  const autopilot = loadAutonomy()[draft.type] === true;
  if (!approved && !autopilot) {
    return fail(`draft ${draftId} has no approval; refusing to post`);
  }

  const text = effectiveText(draft, approval);

  let mediaIds: string[] | undefined;
  if (draft.mediaUrl) {
    const media = await uploadMedia({
      url: draft.mediaUrl,
      mime: mimeFromUrl(draft.mediaUrl),
    });
    mediaIds = [media.mediaId];
  }

  const posted = await postTweet({ text, mediaIds });
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const post: Post = {
    id: posted.id,
    draftId,
    text,
    type: draft.type,
    postedAt: nowIso,
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

  return ok(`posted tweet ${posted.id}`);
}

async function notionWriteTool(
  dataSourceId: string,
  properties: Record<string, unknown>,
): Promise<CallToolResult> {
  if (getStore().getFlag("killswitch")) return fail("killswitch engaged");
  const row = await createRow(dataSourceId, properties);
  return ok(`created notion row ${row.id}`);
}

function buildServer(): Server {
  const server = new Server(
    { name: "signalcmo-write", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "post_tweet",
        description:
          "Post an approved draft to X. Refuses drafts without approval.",
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
        return await postTweetTool(String(input.draftId ?? ""));
      }
      if (name === "notion_write") {
        return await notionWriteTool(
          String(input.dataSourceId ?? ""),
          (input.properties ?? {}) as Record<string, unknown>,
        );
      }
      if (name === "admin_reset") {
        return fail("not permitted");
      }
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

  // Stateless streamable-HTTP: a fresh server and transport per request. Every
  // request must carry the shared bearer token; the server binds loopback so it
  // is only reachable via localhost or the proxy in front of it.
  app.post("/mcp", async (req, res) => {
    if (!bearerOk(req.headers.authorization, token)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[writeguard] request failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "internal error" });
    }
  });

  const port = Number(optionalEnv("WRITE_SERVER_PORT") ?? 8787);
  await new Promise<void>((resolve) => {
    app.listen(port, "127.0.0.1", () => resolve());
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startWriteServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
