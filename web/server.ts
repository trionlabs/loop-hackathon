import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { getStore } from "../shared/store.js";
import type {
  ApprovalDecision,
  ApprovalRecord,
  Draft,
  Learning,
  LoopEvent,
  Post,
  SignalAccount,
} from "../shared/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const startedAt = new Date().toISOString();

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface StatePayload {
  health: { ok: true; startedAt: string };
  signalAccounts: SignalAccount[];
  drafts: Draft[];
  learnings: Learning[];
  posts: Post[];
  events: LoopEvent[];
}

function readState(): StatePayload {
  const base: StatePayload = {
    health: { ok: true, startedAt },
    signalAccounts: [],
    drafts: [],
    learnings: [],
    posts: [],
    events: [],
  };
  try {
    const store = getStore();
    base.drafts = store.listDrafts();
    base.learnings = store.recentLearnings(50);
    base.signalAccounts = store.listSignalAccounts();
    base.posts = store.listPosts();
    base.events = store.recentEvents(60);
  } catch (e) {
    console.error("[web] readState failed:", errMsg(e));
  }
  return base;
}

export function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(express.static(here));

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/state", (_req, res) => {
    res.json(readState());
  });

  app.post("/api/decision", async (req, res) => {
    const body = (req.body ?? {}) as {
      draftId?: string;
      decision?: string;
      editedText?: string;
    };
    const draftId = String(body.draftId ?? "");
    const decision = String(body.decision ?? "") as ApprovalDecision;
    if (!draftId || !["approved", "rejected", "edited"].includes(decision)) {
      res.status(400).json({ ok: false, error: "bad request" });
      return;
    }

    const store = getStore();
    const draft = store.getDraft(draftId);
    if (!draft) {
      res.status(404).json({ ok: false, error: "unknown draft" });
      return;
    }
    // A UI approval is a Telegram approval on another transport: act only on a
    // still-pending draft with no prior decision, so a double-click cannot
    // double-post.
    if (draft.status !== "pending_approval" || store.getApproval(draftId)) {
      res.status(409).json({ ok: false, error: "already decided" });
      return;
    }

    const record: ApprovalRecord = {
      draftId,
      decision,
      editedText: body.editedText,
      decidedAt: new Date().toISOString(),
      decidedBy: "web-ui",
    };
    try {
      store.putApproval(record);
    } catch (e) {
      console.error("[web] putApproval failed:", errMsg(e));
      res.status(500).json({ ok: false, error: "store write failed" });
      return;
    }
    store.appendEvent({
      loop: "approval",
      agent: "principal",
      phase: decision,
      kind: "approval",
      detail: `draft ${decision} in the dashboard`,
    });

    if (decision === "approved") {
      // The post result is returned so the dashboard can show success + link or
      // the real failure reason (a missing-credentials throw is caught too).
      try {
        const mod = await import("../runner/orchestrator.js");
        const r = await mod.runContentPost(draftId);
        if (r.postId) {
          res.json({ ok: true, posted: true, postId: r.postId, url: `https://x.com/i/status/${r.postId}` });
        } else {
          res.json({ ok: true, posted: false, error: r.error ?? "post failed" });
        }
      } catch (e) {
        res.json({ ok: true, posted: false, error: errMsg(e) });
      }
      return;
    }

    res.json({ ok: true });
  });

  // Trigger the content loop from the dashboard. Fire-and-forget so the HTTP
  // response returns immediately; the loop emits events the UI polls.
  app.post("/api/run-content", async (_req, res) => {
    try {
      const mod = await import("../runner/orchestrator.js");
      void mod
        .runContentDraft()
        .catch((e) => console.error("[web] runContentDraft failed:", errMsg(e)));
      res.json({ ok: true, started: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: errMsg(e) });
    }
  });

  return app;
}

export async function startUiServer(): Promise<void> {
  const app = createApp();
  const port = Number(process.env.UI_PORT ?? 4000);
  await new Promise<void>((resolve) => {
    app.listen(port, "127.0.0.1", () => {
      console.log(`[web] dashboard listening on :${port}`);
      resolve();
    });
  });
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  startUiServer().catch((e) => {
    console.error("[web] failed to start:", errMsg(e));
    process.exit(1);
  });
}
