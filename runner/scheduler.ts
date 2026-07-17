import fs from "node:fs";
import cron from "node-cron";
import { parse as parseYaml } from "yaml";
import { getStore } from "../shared/store.js";
import type { Checkpoint, Learning, PostMetrics } from "../shared/types.js";
import { getMetrics } from "../tools/x.js";
import { runContentDraft } from "./orchestrator.js";

function loadCron(loop: string, def: string): string {
  try {
    const raw = fs.readFileSync("config/schedule.yaml", "utf8");
    const doc = parseYaml(raw) as { loops?: Record<string, { cron?: string }> } | null;
    return doc?.loops?.[loop]?.cron ?? def;
  } catch {
    return def;
  }
}

export function startScheduler(): void {
  const contentCron = loadCron("content", "0 7 * * *");
  cron.schedule(contentCron, () => {
    void safeContentTick();
  });
  // node-cron cannot fire per-post one-shots at T+1h/24h/72h, so a recurring
  // tick drains the impact_jobs queue instead.
  cron.schedule("*/5 * * * *", () => {
    void runImpactTick();
  });
  console.log(`[scheduler] content cron ${contentCron}, impact tick every 5m`);
}

async function safeContentTick(): Promise<void> {
  try {
    await runContentDraft();
  } catch (e) {
    console.error("[scheduler] content tick failed:", String(e));
  }
}

function buildImpactLearning(
  postId: string,
  checkpoint: Checkpoint,
  m: PostMetrics,
): Learning {
  const impressions = m.impressions ?? 0;
  const likes = m.likes ?? 0;
  const replies = m.replies ?? 0;
  return {
    id: `l_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    date: new Date().toISOString(),
    loop: "impact",
    what: "format",
    observed: `post ${postId} at ${checkpoint}: ${impressions} impressions, ${likes} likes, ${replies} replies`,
    hypothesis: replies > 0 ? "hook drove replies" : "hook did not drive conversation",
    confidence: 0.5,
    actionTaken: "feed into the next content draft",
  };
}

export async function runImpactTick(): Promise<void> {
  const store = getStore();
  const due = store.dueImpactJobs(new Date().toISOString());
  for (const job of due) {
    try {
      const metrics = (await getMetrics(job.postId)) as PostMetrics;
      const post = store.getPost(job.postId);
      if (post) {
        store.putPost({ ...post, metrics: { ...metrics, checkpoint: job.checkpoint } });
      }
      store.putLearning(buildImpactLearning(job.postId, job.checkpoint, metrics));
      store.completeImpactJob(job.postId, job.checkpoint);
    } catch (e) {
      console.error(`[scheduler] impact job ${job.postId} ${job.checkpoint} failed:`, String(e));
    }
  }
}
