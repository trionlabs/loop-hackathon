import crypto from "node:crypto";
import OAuth from "oauth-1.0a";
import type { PostMetrics } from "../shared/types.js";
import { requireEnv, X_API_BASE } from "../shared/env.js";

interface Token {
  key: string;
  secret: string;
}

function client(): { oauth: OAuth; token: Token } {
  const oauth = new OAuth({
    consumer: {
      key: requireEnv("X_API_KEY"),
      secret: requireEnv("X_API_SECRET"),
    },
    signature_method: "HMAC-SHA1",
    hash_function(base, key) {
      return crypto.createHmac("sha1", key).update(base).digest("base64");
    },
  });
  const token: Token = {
    key: requireEnv("X_ACCESS_TOKEN"),
    secret: requireEnv("X_ACCESS_SECRET"),
  };
  return { oauth, token };
}

// oauth-1.0a folds `data` into the signature base string but does not parse a
// query string out of the url, so query params are passed separately and then
// appended to the request url by hand.
function authHeader(
  method: string,
  url: string,
  params?: Record<string, string>,
): Record<string, string> {
  const { oauth, token } = client();
  const header = oauth.toHeader(
    oauth.authorize({ url, method, data: params }, token),
  );
  return { Authorization: header.Authorization };
}

function buildUrl(base: string, params?: Record<string, string>): string {
  if (!params) return base;
  const qs = new URLSearchParams(params).toString();
  return qs ? `${base}?${qs}` : base;
}

export async function verifyCredentials(): Promise<{ username: string }> {
  const url = `${X_API_BASE}/users/me`;
  const res = await fetch(url, { headers: authHeader("GET", url) });
  if (!res.ok) throw new Error(`x verifyCredentials ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { data?: { username?: string } };
  return { username: body.data?.username ?? "" };
}

export async function uploadMedia(src: {
  url?: string;
  bytes?: Buffer;
  mime: string;
}): Promise<{ mediaId: string }> {
  let bytes = src.bytes;
  if (!bytes && src.url) {
    const dl = await fetch(src.url);
    if (!dl.ok) throw new Error(`x media download ${dl.status}`);
    bytes = Buffer.from(await dl.arrayBuffer());
  }
  if (!bytes) throw new Error("uploadMedia needs url or bytes");

  // v2 media upload. v1.1 media/upload was sunset 2025-06-09, do not use it.
  // OAuth 1.0a on the media leg is contested (2026 reports of 403 after a few
  // posts); if that shows up, move ONLY this leg to OAuth2 media.write.
  const url = `${X_API_BASE}/media/upload`;
  const form = new FormData();
  form.append("media", new Blob([new Uint8Array(bytes)], { type: src.mime }));
  form.append("media_category", "tweet_image");

  const res = await fetch(url, {
    method: "POST",
    headers: authHeader("POST", url),
    body: form,
  });
  if (!res.ok) throw new Error(`x uploadMedia ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    data?: { id?: string; media_id?: string; media_id_string?: string };
  };
  const id =
    body.data?.id ?? body.data?.media_id ?? body.data?.media_id_string;
  if (!id) throw new Error("x uploadMedia missing media id");
  return { mediaId: id };
}

export async function postTweet(input: {
  text: string;
  replyToId?: string;
  mediaIds?: string[];
}): Promise<{ id: string }> {
  const url = `${X_API_BASE}/tweets`;
  const payload: Record<string, unknown> = { text: input.text };
  if (input.replyToId) {
    payload.reply = { in_reply_to_tweet_id: input.replyToId };
  }
  if (input.mediaIds && input.mediaIds.length > 0) {
    payload.media = { media_ids: input.mediaIds };
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...authHeader("POST", url),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`x postTweet ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { data?: { id?: string } };
  if (!body.data?.id) throw new Error("x postTweet missing id");
  return { id: body.data.id };
}

export async function getMetrics(tweetId: string): Promise<PostMetrics> {
  const base = `${X_API_BASE}/tweets/${tweetId}`;
  const params = { "tweet.fields": "public_metrics,non_public_metrics" };
  const res = await fetch(buildUrl(base, params), {
    headers: authHeader("GET", base, params),
  });
  if (!res.ok) throw new Error(`x getMetrics ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    data?: {
      public_metrics?: Record<string, number>;
      non_public_metrics?: Record<string, number>;
    };
  };
  const pub = body.data?.public_metrics ?? {};
  const nonpub = body.data?.non_public_metrics ?? {};
  const metrics: PostMetrics = {
    likes: pub.like_count,
    replies: pub.reply_count,
    reposts: pub.retweet_count,
    quotes: pub.quote_count,
    bookmarks: pub.bookmark_count,
    impressions: pub.impression_count ?? nonpub.impression_count,
  };
  return metrics;
}
