import { requireEnv, XAI_BASE } from "../shared/env.js";

type SearchTool = "x_search" | "web_search";

interface ResponsesOutputContent {
  type?: string;
  text?: string;
  annotations?: { type?: string; url?: string; url_citation?: { url?: string } }[];
}

interface ResponsesOutputItem {
  type?: string;
  content?: ResponsesOutputContent[];
}

interface ResponsesBody {
  output_text?: string;
  output?: ResponsesOutputItem[];
}

export async function research(input: {
  brief: string;
  model?: string;
  searchTools?: SearchTool[];
}): Promise<{ answer: string; citations: string[] }> {
  const tools = (input.searchTools ?? ["x_search"]).map((t) => ({
    type: t,
  }));
  // Hard timeout so a slow or hung search can never stall the demo loop.
  const res = await fetch(`${XAI_BASE}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("XAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model ?? "grok-4-1-fast",
      input: [{ role: "user", content: input.brief }],
      tools,
    }),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`grok research ${res.status}`);
  const body = (await res.json()) as ResponsesBody;
  return { answer: extractAnswer(body), citations: extractCitations(body) };
}

function extractAnswer(body: ResponsesBody): string {
  if (typeof body.output_text === "string") return body.output_text;
  const parts: string[] = [];
  for (const item of body.output ?? []) {
    for (const c of item.content ?? []) {
      if (typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("\n");
}

function extractCitations(body: ResponsesBody): string[] {
  const urls = new Set<string>();
  for (const item of body.output ?? []) {
    for (const c of item.content ?? []) {
      for (const a of c.annotations ?? []) {
        const url = a.url ?? a.url_citation?.url;
        if (url) urls.add(url);
      }
    }
  }
  return [...urls];
}
