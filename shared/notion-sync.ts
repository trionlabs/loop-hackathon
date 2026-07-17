import fs from "node:fs";
import { archivePage, createRow, queryDataSource } from "../tools/notion.js";
import type { Learning, Post, SignalAccount } from "./types.js";

// Mirrors the local store into the Notion "visible brain" databases. The
// data-source ids are written by scripts/notion-setup.ts into config/notion.json.
// If that file is absent (offline demo) every sync is a no-op.

interface NotionIds {
  signalAccounts: { dataSource: string };
  learnings: { dataSource: string };
  posts: { dataSource: string };
  contentCalendar: { dataSource: string };
}

function ids(): NotionIds | null {
  try {
    return JSON.parse(fs.readFileSync("config/notion.json", "utf8")) as NotionIds;
  } catch {
    return null;
  }
}

const title = (s: string) => ({ title: [{ text: { content: s.slice(0, 1900) } }] });
const rich = (s?: string) => ({ rich_text: s ? [{ text: { content: s.slice(0, 1900) } }] : [] });
const num = (n?: number) => ({ number: n ?? null });
const select = (s?: string) => (s ? { select: { name: s } } : { select: null });
const date = (s?: string) => (s ? { date: { start: s } } : { date: null });

export async function syncSignalAccount(a: SignalAccount): Promise<void> {
  const id = ids()?.signalAccounts.dataSource;
  if (!id) return;
  await createRow(id, {
    Handle: title(a.handle),
    Tier: select(a.tier),
    Goal: rich(a.goal),
    Score: num(a.score),
    Relevance: num(a.r),
    EngagementQuality: num(a.q),
    Authority: num(a.a),
    UserVote: num(a.f),
    Tempo: num(a.v),
    Rationale: rich(a.rationale),
    LastScored: date(a.lastScored),
  });
}

// Archive every existing Signal Accounts row so a fresh scout run replaces the
// generic seed rather than piling on top of it.
export async function clearNotionSignalAccounts(): Promise<void> {
  const id = ids()?.signalAccounts.dataSource;
  if (!id) return;
  const rows = await queryDataSource(id);
  for (const r of rows) {
    const pageId = (r as { id?: string })?.id;
    if (pageId) {
      await archivePage(pageId);
      await new Promise((res) => setTimeout(res, 250));
    }
  }
}

export async function syncLearning(l: Learning): Promise<void> {
  const id = ids()?.learnings.dataSource;
  if (!id) return;
  await createRow(id, {
    Observed: title(l.observed),
    Date: date(l.date),
    Loop: rich(l.loop),
    What: select(l.what),
    Hypothesis: rich(l.hypothesis),
    Confidence: num(l.confidence),
    ActionTaken: rich(l.actionTaken),
  });
}

export async function syncPost(p: Post): Promise<void> {
  const id = ids()?.posts.dataSource;
  if (!id) return;
  const m = p.metrics ?? {};
  await createRow(id, {
    PostId: title(p.id),
    DraftId: rich(p.draftId),
    Text: rich(p.text),
    Type: select(p.type),
    PostedAt: date(p.postedAt),
    Impressions: num(m.impressions),
    Likes: num(m.likes),
    Replies: num(m.replies),
    Reposts: num(m.reposts),
    Quotes: num(m.quotes),
    Bookmarks: num(m.bookmarks),
    IcpReplies: num(m.icpReplies),
    PostScore: num(m.postScore),
  });
}
