// Seed the local JSON store with realistic demo data so the dashboard and the
// Content -> Approval -> Post -> Impact demo run with NO credentials.
//
// Runnable via: pnpm exec tsx scripts/seed.ts
//
// Note: the Store has no putter (and no backing field) for SignalAccount, so
// signal rows cannot be persisted through the Store API. They are printed here
// for the demo narrative and to document the gap; see the report.
import { getStore } from "../shared/store.js";
import type { Draft, Learning, Post, SignalAccount } from "../shared/types.js";

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString();
}

const store = getStore();

// Learnings first: later drafts reference these ids via appliedLearningId. The
// re-injection of Learnings into new prompts is the self-improvement mechanism.
const learnings: Learning[] = [
  {
    id: "lrn_hook_number",
    date: daysAgo(6),
    loop: "impact",
    what: "hook",
    observed:
      "Posts opening with a concrete number in the first line drew 2.1x the profile visits of posts opening with a rhetorical question over the last 12 posts.",
    hypothesis:
      "Lead with a specific metric, not a question. Numbers signal a real result and stop the scroll.",
    confidence: 0.72,
    actionTaken: "Applied to draft drf_posted_warm as the opening line.",
  },
  {
    id: "lrn_single_image",
    date: daysAgo(4),
    loop: "impact",
    what: "format",
    observed:
      "Single-image posts outperformed text-only posts by 40 percent on bookmarks across the last 8 educational posts.",
    hypothesis:
      "Attach one visual to teaching posts. Bookmarks track save-for-later intent, which correlates with ICP replies.",
    confidence: 0.6,
    actionTaken: "Media slot added to the pending draft drf_pending.",
  },
  {
    id: "lrn_morning_slot",
    date: daysAgo(2),
    loop: "impact",
    what: "timing",
    observed:
      "The 9am PT slot beat the 1pm PT slot on 24h impressions in 5 of the last 6 founder-audience posts.",
    hypothesis:
      "Prefer the morning slot for founder-audience posts. Afternoon competes with peak US noise.",
    confidence: 0.55,
  },
];

// putLearning appends, so guard against duplicates when seed is re-run.
const existingLearningIds = new Set(
  store.recentLearnings(10000).map((l) => l.id),
);
let learningsAdded = 0;
for (const l of learnings) {
  if (existingLearningIds.has(l.id)) continue;
  store.putLearning(l);
  learningsAdded++;
}

// Drafts: one already posted (carries appliedLearningId for the A/B view), one
// older learned draft that a cooler post points at, and one pending approval.
const drafts: Draft[] = [
  {
    id: "drf_posted_warm",
    type: "post",
    text: "Shipped the onboarding rewrite last week. Time-to-first-value dropped from 11 minutes to 4. The unlock was killing the product tour and dropping people straight into a pre-filled workspace. Defaults beat guidance.",
    status: "posted",
    sessionId: "sess_content_0918",
    rationale:
      "Concrete before/after number in the opener, per the hook learning. Founder audience, morning slot.",
    predictedDriver: "concrete-number-hook",
    appliedLearningId: "lrn_hook_number",
    slot: "09:00",
    createdAt: daysAgo(3),
    updatedAt: daysAgo(3),
  },
  {
    id: "drf_posted_cold",
    type: "post",
    text: "AI does not replace your strategy. It replaces the parts of your strategy you never wrote down. Write down the boring decisions first.",
    status: "learned",
    sessionId: "sess_content_0731",
    rationale: "Abstract aphorism, no concrete proof point. Kept as a contrast case.",
    predictedDriver: "aphorism-open",
    slot: "13:00",
    createdAt: daysAgo(7),
    updatedAt: daysAgo(6),
  },
  {
    id: "drf_pending",
    type: "post",
    text: "Most 'AI strategy' decks are a list of tools. The teams pulling ahead wrote down one boring thing first: which decision the model is allowed to make without a human. Pick that decision, then buy tools.",
    mediaUrl: "https://placehold.co/1200x675/png?text=SignalCMO+demo+visual",
    status: "pending_approval",
    sessionId: "sess_content_1042",
    rationale:
      "Contrarian open plus a single visual, per the single-image learning. Pulls the concrete-number habit forward into the body.",
    predictedDriver: "contrarian-open",
    appliedLearningId: "lrn_single_image",
    slot: "09:00",
    createdAt: daysAgo(0),
    updatedAt: daysAgo(0),
  },
];

for (const d of drafts) store.putDraft(d);

// An approval record for the posted draft so the approval history is populated.
store.putApproval({
  draftId: "drf_posted_warm",
  decision: "approved",
  decidedAt: daysAgo(3),
  decidedBy: "principal",
});

// Dedup corpus. Guard so re-running seed does not duplicate entries.
const postedCorpus = new Set(store.recentPostedTexts(3650));
for (const d of drafts) {
  if (d.status === "posted" && !postedCorpus.has(d.text)) {
    store.addPostedText(d.text);
  }
}

// Posts with metrics. The warm post gives the Impact beat something real to
// reason over; the cooler post is the contrast case for the A/B view.
const posts: Post[] = [
  {
    id: "1810000000000000001",
    draftId: "drf_posted_warm",
    text: drafts[0].text,
    type: "post",
    postedAt: daysAgo(3),
    metrics: {
      impressions: 18420,
      likes: 214,
      replies: 34,
      reposts: 22,
      quotes: 5,
      bookmarks: 61,
      icpReplies: 12,
      postScore: 74,
      checkpoint: "72h",
    },
  },
  {
    id: "1809000000000000002",
    draftId: "drf_posted_cold",
    text: drafts[1].text,
    type: "post",
    postedAt: daysAgo(6),
    metrics: {
      impressions: 6110,
      likes: 41,
      replies: 3,
      reposts: 2,
      quotes: 0,
      bookmarks: 8,
      icpReplies: 1,
      postScore: 38,
      checkpoint: "72h",
    },
  },
];

for (const p of posts) store.putPost(p);

// SignalAccount rows across all three tiers, persisted so the dashboard tier
// board renders the Signal wedge.
const signalAccounts: SignalAccount[] = [
  {
    handle: "naval",
    tier: "signal",
    goal: "founder-audience-growth",
    score: 88,
    r: 37,
    q: 18,
    a: 15,
    v: 9,
    f: 9,
    rationale:
      "High topical overlap on leverage and startups, dense original threads, top-tier authority. User thumbs-up twice.",
    lastScored: daysAgo(1),
  },
  {
    handle: "paulg",
    tier: "signal",
    goal: "founder-audience-growth",
    score: 82,
    r: 35,
    q: 17,
    a: 15,
    v: 8,
    f: 7,
    rationale:
      "Essays land squarely on the ICP, steady tempo, foundational authority in the startup space.",
    lastScored: daysAgo(1),
  },
  {
    handle: "levelsio",
    tier: "signal",
    goal: "founder-audience-growth",
    score: 71,
    r: 30,
    q: 16,
    a: 11,
    v: 8,
    f: 6,
    rationale:
      "Ship-in-public builder content matches the tone, strong engagement quality, moderate authority.",
    lastScored: daysAgo(1),
  },
  {
    handle: "Jason",
    tier: "watchlist",
    goal: "founder-audience-growth",
    score: 58,
    r: 24,
    q: 13,
    a: 12,
    v: 5,
    f: 4,
    rationale:
      "Relevant but noisy: a lot of podcast promo dilutes the signal. Holding on the watchlist to confirm the trend.",
    lastScored: daysAgo(1),
    hysteresisHold: true,
  },
  {
    handle: "garyvee",
    tier: "watchlist",
    goal: "founder-audience-growth",
    score: 49,
    r: 18,
    q: 11,
    a: 12,
    v: 4,
    f: 4,
    rationale:
      "Broad motivational content, only partial ICP overlap and high volume. On the edge of noise.",
    lastScored: daysAgo(1),
  },
  {
    handle: "cryptomoonboy",
    tier: "noise",
    goal: "founder-audience-growth",
    score: 22,
    r: 6,
    q: 5,
    a: 4,
    v: 4,
    f: 3,
    rationale:
      "Off-topic token shilling, low original signal, no authority in the target space. Muted from the digest.",
    lastScored: daysAgo(1),
  },
];

for (const s of signalAccounts) store.putSignalAccount(s);

// Summary.
console.log("seed complete");
console.log(`  learnings:        ${learningsAdded} added (${learnings.length} defined)`);
console.log(`  drafts:           ${drafts.length} upserted`);
console.log(`    pending:        ${store.listDrafts("pending_approval").length}`);
console.log(`    posted:         ${store.listDrafts("posted").length}`);
console.log(`  posts:            ${posts.length} upserted (warm + cold)`);
console.log(`  approvals:        1 (drf_posted_warm)`);
console.log(`  signalAccounts:   ${signalAccounts.length} upserted`);
console.log("");
console.log("signal accounts:");
for (const s of signalAccounts) {
  console.log(
    `  ${s.tier.padEnd(9)} @${s.handle.padEnd(16)} score ${String(s.score).padStart(3)}  ${s.rationale.slice(0, 60)}`,
  );
}
