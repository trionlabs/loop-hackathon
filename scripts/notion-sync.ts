// Push the current local store into the Notion visible-brain databases.
// Run after seeding (or any time) to populate Signal Accounts, Learnings and
// Posts for the demo. Throttled to stay under Notion's ~3 req/sec limit.
//
//   pnpm exec tsx scripts/notion-sync.ts
import { getStore } from "../shared/store.js";
import { syncLearning, syncPost, syncSignalAccount } from "../shared/notion-sync.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const store = getStore();
let n = 0;

for (const a of store.listSignalAccounts()) {
  await syncSignalAccount(a);
  n++;
  await sleep(350);
}
for (const l of [...store.recentLearnings(1000)].reverse()) {
  await syncLearning(l);
  n++;
  await sleep(350);
}
for (const p of store.listPosts()) {
  await syncPost(p);
  n++;
  await sleep(350);
}

console.log(`synced ${n} rows to notion`);
