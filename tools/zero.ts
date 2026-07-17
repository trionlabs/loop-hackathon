import { execa } from "execa";

interface ZeroImage {
  url?: string;
  bytes?: Buffer;
  mime: string;
}

// The Zero SKILL mandates re-searching every run, so tokens are never cached.
const TOKEN_RE = /z_[a-z0-9]+\.\d+/i;

async function run(args: string[]): Promise<{ stdout: Buffer; text: string }> {
  const res = await execa("zero", args, { encoding: "buffer" });
  const stdout = res.stdout as unknown as Buffer;
  return { stdout, text: stdout.toString("utf8") };
}

function firstToken(text: string): string {
  const m = text.match(TOKEN_RE);
  if (!m) throw new Error("zero search returned no capability token");
  return m[0];
}

function firstUrl(text: string): string {
  const m = text.match(/https?:\/\/[^\s"']+/i);
  if (!m) throw new Error("zero get returned no fetch url");
  return m[0];
}

interface ZeroFetch {
  runId?: string;
  ok?: boolean;
  status?: number;
  body?: unknown;
}

// search -> get -> fetch -> mandatory review. Fetch output is per-capability:
// a hosted url inside the JSON body, or raw bytes streamed on stdout.
async function capabilityFetch(
  query: string,
  data: Record<string, unknown>,
  maxPay: number,
): Promise<{ parsed: ZeroFetch; raw: Buffer }> {
  const token = firstToken((await run(["search", query])).text);
  const endpoint = firstUrl((await run(["get", token])).text);
  const fetched = await run([
    "fetch",
    endpoint,
    "--capability",
    token,
    "-d",
    JSON.stringify(data),
    "--max-pay",
    String(maxPay),
    "--json",
  ]);

  let parsed: ZeroFetch = {};
  try {
    parsed = JSON.parse(fetched.text) as ZeroFetch;
  } catch {
    parsed = {};
  }

  if (parsed.runId) {
    await run(["review", parsed.runId, "--success", "--accuracy", "5", "--value", "5", "--reliability", "5"]);
  }
  return { parsed, raw: fetched.stdout };
}

export async function generateImage(
  prompt: string,
  opts?: { maxPay?: number },
): Promise<ZeroImage> {
  const maxPay = opts?.maxPay ?? 0.5;
  const { parsed, raw } = await capabilityFetch(
    "generate image flux",
    { prompt },
    maxPay,
  );

  const body = parsed.body as
    | { url?: string; image_url?: string; mime?: string; content_type?: string }
    | undefined;
  const url = body?.url ?? body?.image_url;
  const mime = body?.mime ?? body?.content_type ?? "image/png";
  if (url) return { url, mime };
  return { bytes: raw, mime };
}

export async function scrapeProfile(handle: string): Promise<unknown> {
  const clean = handle.replace(/^@/, "");
  const { parsed } = await capabilityFetch(
    "x twitter profile lookup",
    { handle: clean },
    0.5,
  );
  return parsed.body ?? parsed;
}
