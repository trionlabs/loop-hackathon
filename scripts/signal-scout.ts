// Real signal detection: Grok x_search finds and scores live X accounts for the
// principal's audience, replacing the generic seed in both the store and Notion.
//
//   pnpm exec tsx scripts/signal-scout.ts "your audience description"
import { getStore } from "../shared/store.js";
import { research } from "../tools/grok.js";
import { clearNotionSignalAccounts, syncSignalAccount } from "../shared/notion-sync.js";
import type { SignalAccount } from "../shared/types.js";

const goal =
  process.argv[2] ??
  process.env.SIGNAL_GOAL ??
  "founders, builders and operators shipping AI agents, developer tools, and onchain infrastructure";

const brief = [
  `Use x_search on real X/Twitter data to find 10 real, currently active X accounts that are high-signal for this audience: ${goal}.`,
  "For each account pick a tier: signal (highly relevant and high quality), watchlist (partially relevant), or noise (adjacent but off-topic).",
  "Return ONLY a JSON array (no prose, no code fences) of 10 objects with keys:",
  '{"handle": string without @, "tier": "signal"|"watchlist"|"noise", "score": 0-100, "relevance": 0-40, "engagement": 0-20, "authority": 0-15, "tempo": 0-10, "rationale": one specific sentence naming what they actually post}.',
  "Use only real handles that exist. Prefer specific relevant accounts over famous generalists.",
].join(" ");

interface Row {
  handle: string;
  tier: string;
  score?: number;
  relevance?: number;
  engagement?: number;
  authority?: number;
  tempo?: number;
  rationale?: string;
}

getStore().appendEvent({
  loop: "signal",
  agent: "signal-scout",
  phase: "tool",
  kind: "tool",
  detail: "Grok x_search: scoring accounts for the audience",
});
const { answer } = await research({ brief });
const match = answer.match(/\[[\s\S]*\]/);
if (!match) {
  console.error("no JSON array in grok answer:\n", answer.slice(0, 600));
  process.exit(1);
}
let rows: Row[];
try {
  rows = JSON.parse(match[0]) as Row[];
} catch (e) {
  console.error("json parse failed:", e instanceof Error ? e.message : String(e));
  console.error(match[0].slice(0, 600));
  process.exit(1);
}

const now = new Date().toISOString();
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const accounts: SignalAccount[] = rows.map((row) => {
  const tier = (["signal", "watchlist", "noise"].includes(row.tier)
    ? row.tier
    : "watchlist") as SignalAccount["tier"];
  return {
    handle: row.handle.replace(/^@/, ""),
    tier,
    goal,
    score: Math.round(row.score ?? 0),
    r: Math.round(row.relevance ?? 0),
    q: Math.round(row.engagement ?? 0),
    a: Math.round(row.authority ?? 0),
    v: Math.round(row.tempo ?? 0),
    f: 7,
    rationale: row.rationale ?? "",
    lastScored: now,
  };
});

// Store first so it is always correct, even if Notion mirroring fails.
const store = getStore();
store.clearSignalAccounts();
for (const acc of accounts) store.putSignalAccount(acc);
store.appendEvent({
  loop: "signal",
  agent: "signal-scout",
  phase: "done",
  kind: "signal",
  detail: `scored ${accounts.length} accounts (signal/watchlist/noise)`,
});

// Notion mirror is best effort.
try {
  await clearNotionSignalAccounts();
  for (const acc of accounts) {
    await syncSignalAccount(acc);
    await sleep(300);
  }
} catch (e) {
  console.error("notion mirror skipped:", e instanceof Error ? e.message : String(e));
}

for (const acc of accounts) {
  console.log(`${acc.tier.padEnd(9)} @${acc.handle.padEnd(20)} ${String(acc.score).padStart(3)}  ${acc.rationale.slice(0, 68)}`);
}
console.log(`\nscored ${accounts.length} real accounts for goal: ${goal}`);
