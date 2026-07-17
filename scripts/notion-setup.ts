// Create the demo Notion databases under NOTION_PARENT_PAGE_ID and print each
// database id and its data_source_id, ready to paste into config/.env.
//
//   pnpm exec tsx scripts/notion-setup.ts
//
// Guards on NOTION_TOKEN and NOTION_PARENT_PAGE_ID. tools/notion has no
// createDatabase helper, so the database create is a direct REST call; the
// data_source_id is read back via tools/notion.resolveDataSourceId.
import { NOTION_VERSION, requireEnv } from "../shared/env.js";
import { resolveDataSourceId } from "../tools/notion.js";

for (const k of ["NOTION_TOKEN", "NOTION_PARENT_PAGE_ID"]) {
  if (!process.env[k]) {
    console.log(`skip: ${k} not set`);
    process.exit(0);
  }
}

const NOTION_BASE = "https://api.notion.com/v1";

async function createDatabase(
  parentPageId: string,
  title: string,
  properties: Record<string, unknown>,
): Promise<{ databaseId: string; dataSourceId?: string }> {
  const res = await fetch(`${NOTION_BASE}/databases`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("NOTION_TOKEN")}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { type: "page_id", page_id: parentPageId },
      title: [{ type: "text", text: { content: title } }],
      initial_data_source: { properties },
    }),
  });
  if (!res.ok) throw new Error(`createDatabase ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    id?: string;
    data_sources?: { id: string }[];
  };
  if (!body.id) throw new Error("createDatabase missing database id");
  return { databaseId: body.id, dataSourceId: body.data_sources?.[0]?.id };
}

const sel = (...names: string[]) => ({ select: { options: names.map((name) => ({ name })) } });

// Schemas mirror the shared types so the demo data round-trips cleanly.
const databases: { name: string; properties: Record<string, unknown> }[] = [
  {
    name: "Signal Accounts",
    properties: {
      Handle: { title: {} },
      Tier: sel("signal", "watchlist", "noise"),
      Goal: { rich_text: {} },
      Score: { number: {} },
      Relevance: { number: {} },
      EngagementQuality: { number: {} },
      Authority: { number: {} },
      UserVote: { number: {} },
      Tempo: { number: {} },
      Rationale: { rich_text: {} },
      LastScored: { date: {} },
    },
  },
  {
    name: "Learnings",
    properties: {
      Observed: { title: {} },
      Date: { date: {} },
      Loop: { rich_text: {} },
      What: sel("hook", "format", "topic", "timing"),
      Hypothesis: { rich_text: {} },
      Confidence: { number: {} },
      ActionTaken: { rich_text: {} },
    },
  },
  {
    name: "Posts",
    properties: {
      PostId: { title: {} },
      DraftId: { rich_text: {} },
      Text: { rich_text: {} },
      Type: sel("post", "reply", "thread"),
      PostedAt: { date: {} },
      Impressions: { number: {} },
      Likes: { number: {} },
      Replies: { number: {} },
      Reposts: { number: {} },
      Quotes: { number: {} },
      Bookmarks: { number: {} },
      IcpReplies: { number: {} },
      PostScore: { number: {} },
    },
  },
  {
    name: "Content Calendar",
    properties: {
      Title: { title: {} },
      Type: sel("post", "reply", "thread"),
      Status: sel(
        "draft",
        "pending_approval",
        "approved",
        "edited",
        "rejected",
        "scheduled",
        "posted",
        "measuring",
        "learned",
      ),
      Slot: { rich_text: {} },
      Text: { rich_text: {} },
      AppliedLearning: { rich_text: {} },
      PredictedDriver: { rich_text: {} },
    },
  },
];

async function main(): Promise<void> {
  const parent = requireEnv("NOTION_PARENT_PAGE_ID");
  const results: { name: string; databaseId: string; dataSourceId: string }[] = [];

  for (const db of databases) {
    const created = await createDatabase(parent, db.name, db.properties);
    const dataSourceId = created.dataSourceId ?? (await resolveDataSourceId(created.databaseId));
    results.push({ name: db.name, databaseId: created.databaseId, dataSourceId });
    console.log(`created ${db.name}`);
  }

  console.log("");
  console.log("paste into config/.env:");
  for (const r of results) {
    const key = r.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    console.log(`  # ${r.name}`);
    console.log(`  NOTION_DB_${key}=${r.databaseId}`);
    console.log(`  NOTION_DS_${key}=${r.dataSourceId}`);
  }
}

main().catch((e) => {
  console.log(`FAIL notion-setup  ${(e as Error).message}`);
  process.exit(1);
});
