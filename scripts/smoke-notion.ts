// De-risking test for the Notion path.
// Does REAL calls only when NOTION_TOKEN and NOTION_PARENT_PAGE_ID are present.
//
//   pnpm exec tsx scripts/smoke-notion.ts
//
// Creates a database (its initial data source) under the parent page, writes one
// row through tools/notion, then queries it back. Exits nonzero on failure.
import { NOTION_VERSION, requireEnv } from "../shared/env.js";
import { createRow, queryDataSource, resolveDataSourceId } from "../tools/notion.js";

for (const k of ["NOTION_TOKEN", "NOTION_PARENT_PAGE_ID"]) {
  if (!process.env[k]) {
    console.log(`skip: ${k} not set`);
    process.exit(0);
  }
}

const NOTION_BASE = "https://api.notion.com/v1";

// tools/notion has no createDatabase, so create the database (and thus its first
// data source) with a direct REST call. 2025-09-03 and later put the schema on
// initial_data_source and return a data_sources array on the database object.
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

async function main(): Promise<void> {
  const parent = requireEnv("NOTION_PARENT_PAGE_ID");
  const marker = Date.now().toString(36);

  const db = await createDatabase(parent, `SignalCMO smoke ${marker}`, {
    Name: { title: {} },
    Note: { rich_text: {} },
  });
  console.log(`  created database ${db.databaseId}`);

  // Prefer the id the create call returned; otherwise resolve it off the db.
  const dataSourceId = db.dataSourceId ?? (await resolveDataSourceId(db.databaseId));
  console.log(`  data source ${dataSourceId}`);

  const row = await createRow(dataSourceId, {
    Name: { title: [{ text: { content: `probe ${marker}` } }] },
    Note: { rich_text: [{ text: { content: "written by smoke-notion" } }] },
  });
  console.log(`  wrote row ${row.id}`);

  const rows = await queryDataSource(dataSourceId);
  if (rows.length < 1) throw new Error("query returned no rows after write");
  console.log(`  queried back ${rows.length} row(s)`);

  console.log(`PASS notion  db=${db.databaseId} ds=${dataSourceId}`);
}

main().catch((e) => {
  console.log(`FAIL notion  ${(e as Error).message}`);
  process.exit(1);
});
