import { runContentDraft } from "./orchestrator.js";
import { runImpactTick } from "./scheduler.js";

async function main(): Promise<number> {
  const loop = process.argv[2];
  switch (loop) {
    case "content": {
      const r = await runContentDraft();
      console.log(`[run-loop] content drafted ${r.draftId}`);
      return 0;
    }
    case "impact": {
      await runImpactTick();
      console.log("[run-loop] impact tick complete");
      return 0;
    }
    case "signal": {
      console.log("[run-loop] signal loop runs in signal-scout, not the runner slice");
      return 0;
    }
    default: {
      console.error(`[run-loop] unknown loop ${loop ?? "(none)"}; use content|signal|impact`);
      return 1;
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("[run-loop] failed:", e);
    process.exit(1);
  });
