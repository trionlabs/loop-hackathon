import dotenv from "dotenv";
import crypto from "node:crypto";
import OAuth from "oauth-1.0a";

dotenv.config({ path: "config/.env" });

type Check = { name: string; run: () => Promise<string> };

function env(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error("not set");
  return v;
}

async function anthropic(): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/models", {
    headers: {
      "x-api-key": env("ANTHROPIC_API_KEY"),
      "anthropic-version": "2023-06-01",
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return "auth ok";
}

async function xai(): Promise<string> {
  const res = await fetch("https://api.x.ai/v1/models", {
    headers: { authorization: `Bearer ${env("XAI_API_KEY")}` },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const data = (await res.json()) as { data?: unknown[] };
  return `auth ok, ${data.data?.length ?? 0} models`;
}

async function notion(): Promise<string> {
  const res = await fetch("https://api.notion.com/v1/users/me", {
    headers: {
      authorization: `Bearer ${env("NOTION_TOKEN")}`,
      "Notion-Version": "2026-03-11",
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const data = (await res.json()) as { name?: string; id?: string };
  return `auth ok, bot ${data.name ?? data.id ?? "unknown"}`;
}

async function telegram(): Promise<string> {
  const res = await fetch(
    `https://api.telegram.org/bot${env("TG_BOT_TOKEN")}/getMe`,
  );
  const data = (await res.json()) as {
    ok?: boolean;
    result?: { username?: string };
  };
  if (!data.ok) throw new Error(JSON.stringify(data));
  return `bot @${data.result?.username ?? "unknown"}`;
}

async function x(): Promise<string> {
  const oauth = new OAuth({
    consumer: { key: env("X_API_KEY"), secret: env("X_API_SECRET") },
    signature_method: "HMAC-SHA1",
    hash_function: (base, key) =>
      crypto.createHmac("sha1", key).update(base).digest("base64"),
  });
  const token = { key: env("X_ACCESS_TOKEN"), secret: env("X_ACCESS_SECRET") };
  const request = { url: "https://api.twitter.com/2/users/me", method: "GET" };
  const header = oauth.toHeader(oauth.authorize(request, token));
  const res = await fetch(request.url, {
    headers: header as unknown as Record<string, string>,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const data = (await res.json()) as { data?: { username?: string } };
  return `auth ok, @${data.data?.username ?? "unknown"}`;
}

const checks: Check[] = [
  { name: "anthropic", run: anthropic },
  { name: "xai", run: xai },
  { name: "notion", run: notion },
  { name: "telegram", run: telegram },
  { name: "x", run: x },
];

let failed = 0;
for (const c of checks) {
  try {
    const detail = await c.run();
    console.log(`PASS ${c.name.padEnd(10)} ${detail}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${c.name.padEnd(10)} ${(e as Error).message}`);
  }
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
