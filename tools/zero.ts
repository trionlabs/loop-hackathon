import { execa } from "execa";

interface ZeroImage {
  url?: string;
  bytes?: Buffer;
  mime: string;
}

interface Cap {
  token?: string;
  url?: string;
  cost?: number;
  success?: number;
}

async function run(args: string[]): Promise<{ stdout: Buffer; text: string }> {
  // reject:false so a non-zero exit (some capabilities exit 1 while still
  // returning a usable JSON body) does not throw before we can parse it.
  const res = await execa("zero", args, { encoding: "buffer", reject: false });
  const stdout = res.stdout as unknown as Buffer;
  return { stdout, text: stdout.toString("utf8") };
}

// `zero search --json` returns clean JSON with the token AND endpoint url for
// each capability, ranked. Returns the usable ones so a flaky top pick can be
// retried.
async function searchCaps(query: string): Promise<Cap[]> {
  const res = await execa("zero", ["search", query, "--json"], { encoding: "utf8" });
  const j = JSON.parse(res.stdout) as {
    capabilities?: {
      token?: string;
      url?: string;
      cost?: { amount?: string };
      rating?: { successRate?: string };
    }[];
  };
  return (j.capabilities ?? [])
    .filter((c) => c.token && c.url)
    .map((c) => ({
      token: c.token,
      url: c.url,
      cost: Number(c.cost?.amount ?? 0),
      success: Number(c.rating?.successRate ?? 0),
    }));
}

// `zero fetch --json` prints progress lines before the JSON object, so extract
// the last balanced JSON object rather than parsing the whole stream.
function extractJson(text: string): Record<string, unknown> {
  const m = text.match(/\{[\s\S]*\}\s*$/);
  if (m) {
    try {
      return JSON.parse(m[0]) as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function fetchCap(
  cap: Cap,
  data: Record<string, unknown>,
  maxPay: number,
): Promise<Record<string, unknown>> {
  const fetched = await run([
    "fetch",
    cap.url as string,
    "--capability",
    cap.token as string,
    "-d",
    JSON.stringify(data),
    "--max-pay",
    String(maxPay),
    "--json",
  ]);
  const parsed = extractJson(fetched.text);
  const runId = parsed["runId"];
  if (typeof runId === "string") {
    try {
      await run(["review", runId, "--success", "--accuracy", "5", "--value", "5", "--reliability", "5"]);
    } catch {
      /* review is best effort */
    }
  }
  return parsed;
}

function pickImage(body: unknown): ZeroImage | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const images = b["images"];
  if (Array.isArray(images) && images.length) {
    const first = images[0] as Record<string, unknown>;
    const url = first["url"];
    if (typeof url === "string") {
      const ct = first["content_type"];
      return { url, mime: typeof ct === "string" ? ct : "image/jpeg" };
    }
  }
  const direct = b["url"] ?? b["image_url"] ?? b["imageUrl"];
  if (typeof direct === "string" && /^https?:\/\//.test(direct)) {
    const ct = b["content_type"];
    return { url: direct, mime: typeof ct === "string" ? ct : "image/png" };
  }
  return undefined;
}

export async function generateImage(
  prompt: string,
  opts?: { maxPay?: number },
): Promise<ZeroImage> {
  const maxPay = opts?.maxPay ?? 0.5;
  // Prefer the most reliable capabilities. The Zero-native image.withzero.xyz
  // caps return images directly; the tempo/fal caps often return a payment
  // challenge for this wallet, which pickImage skips so the loop moves on.
  const caps = (await searchCaps("fast image generation from a text prompt")).sort(
    (a, b) => (b.success ?? 0) - (a.success ?? 0),
  );
  let lastErr = "no image capability found";
  for (const cap of caps.slice(0, 8)) {
    try {
      const parsed = await fetchCap(cap, { prompt }, maxPay);
      const img = pickImage(parsed["body"] ?? parsed);
      if (img) return img;
      lastErr = "capability returned no image";
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`zero image failed: ${lastErr}`);
}

export async function scrapeProfile(handle: string): Promise<unknown> {
  const clean = handle.replace(/^@/, "");
  const caps = await searchCaps("x twitter profile lookup by username");
  for (const cap of caps.slice(0, 3)) {
    try {
      const parsed = await fetchCap(cap, { handle: clean }, 0.5);
      return parsed["body"] ?? parsed;
    } catch {
      /* try next */
    }
  }
  throw new Error("zero scrape failed");
}
