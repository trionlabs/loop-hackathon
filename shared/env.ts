import dotenv from "dotenv";

dotenv.config({ path: "config/.env" });

export function optionalEnv(key: string): string | undefined {
  return process.env[key];
}

export function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`missing env ${key}`);
  return v;
}

export const limits = {
  maxPostsPerDay: Number(process.env.MAX_POSTS_PER_DAY ?? 4),
  maxRepliesPerDay: Number(process.env.MAX_REPLIES_PER_DAY ?? 6),
};

export const NOTION_VERSION = "2026-03-11";
export const XAI_BASE = "https://api.x.ai/v1";
export const X_API_BASE = "https://api.twitter.com/2";
