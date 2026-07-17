import { NOTION_VERSION, requireEnv } from "../shared/env.js";

const NOTION_BASE = "https://api.notion.com/v1";

function headers(json = true): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${requireEnv("NOTION_TOKEN")}`,
    "Notion-Version": NOTION_VERSION,
  };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

async function ok(res: Response, label: string): Promise<Response> {
  if (!res.ok) throw new Error(`notion ${label} ${res.status}`);
  return res;
}

export async function resolveDataSourceId(databaseId: string): Promise<string> {
  const res = await ok(
    await fetch(`${NOTION_BASE}/databases/${databaseId}`, {
      headers: headers(false),
    }),
    "resolveDataSourceId",
  );
  const body = (await res.json()) as {
    data_sources?: { id: string }[];
  };
  const id = body.data_sources?.[0]?.id;
  if (!id) throw new Error("notion database has no data_sources");
  return id;
}

// 2025-09-03 and later query off the data source, not the database.
export async function queryDataSource(
  dataSourceId: string,
  filter?: unknown,
): Promise<any[]> {
  const res = await ok(
    await fetch(`${NOTION_BASE}/data_sources/${dataSourceId}/query`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(filter ? { filter } : {}),
    }),
    "queryDataSource",
  );
  const body = (await res.json()) as { results?: any[] };
  return body.results ?? [];
}

export async function archivePage(pageId: string): Promise<void> {
  await ok(
    await fetch(`${NOTION_BASE}/pages/${pageId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ in_trash: true }),
    }),
    "archivePage",
  );
}

export async function createRow(
  dataSourceId: string,
  properties: Record<string, unknown>,
): Promise<{ id: string }> {
  const res = await ok(
    await fetch(`${NOTION_BASE}/pages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        parent: { type: "data_source_id", data_source_id: dataSourceId },
        properties,
      }),
    }),
    "createRow",
  );
  const body = (await res.json()) as { id?: string };
  if (!body.id) throw new Error("notion createRow missing id");
  return { id: body.id };
}

export async function readPageMarkdown(pageId: string): Promise<string> {
  const res = await ok(
    await fetch(`${NOTION_BASE}/pages/${pageId}/markdown`, {
      headers: headers(false),
    }),
    "readPageMarkdown",
  );
  const body = (await res.json()) as {
    markdown?: string;
    content?: string;
    results?: { markdown?: string };
  };
  return body.markdown ?? body.content ?? body.results?.markdown ?? "";
}

export async function writePageMarkdown(
  pageId: string,
  markdown: string,
): Promise<void> {
  await ok(
    await fetch(`${NOTION_BASE}/pages/${pageId}/markdown`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ type: "replace_content", replace_content: { new_str: markdown } }),
    }),
    "writePageMarkdown",
  );
}
