import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { getStore } from "../shared/store.js";
import type {
  ApprovalDecision,
  ApprovalRecord,
  Draft,
  Learning,
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
}

function readState(): StatePayload {
  const base: StatePayload = {
    health: { ok: true, startedAt },
    signalAccounts: [],
    drafts: [],
    learnings: [],
    posts: [],
  };
  try {
    const store = getStore();
    base.drafts = store.listDrafts();
    base.learnings = store.recentLearnings(50);
    base.signalAccounts = store.listSignalAccounts();
    base.posts = store.listPosts();
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

    if (decision === "approved") {
      // A missing-credentials throw here must not lose the recorded approval, so
      // the import and the call are both guarded.
      try {
        const mod = await import("../runner/orchestrator.js");
        await mod.runContentPost(draftId);
      } catch (e) {
        console.error("[web] runContentPost failed:", errMsg(e));
      }
    }

    res.json({ ok: true });
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
