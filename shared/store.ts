import fs from "node:fs";
import path from "node:path";
import type {
  ApprovalRecord,
  Checkpoint,
  ContentType,
  Draft,
  DraftStatus,
  Flag,
  ImpactJob,
  Learning,
  LoopEvent,
  Post,
  SignalAccount,
  Store,
} from "./types.js";

interface Shape {
  drafts: Record<string, Draft>;
  approvals: Record<string, ApprovalRecord>;
  posts: Record<string, Post>;
  signalAccounts: Record<string, SignalAccount>;
  learnings: Learning[];
  counters: Record<string, number>;
  flags: Partial<Record<Flag, boolean>>;
  postedTexts: { text: string; at: string }[];
  impactJobs: ImpactJob[];
  events: LoopEvent[];
}

const empty: Shape = {
  drafts: {},
  approvals: {},
  posts: {},
  signalAccounts: {},
  learnings: [],
  counters: {},
  flags: {},
  postedTexts: [],
  impactJobs: [],
  events: [],
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// Single-file JSON store. Authoritative for approvals, draft state, counters,
// flags, dedup corpus, signal accounts and impact jobs. The runner, the
// mcp-write-server and the web UI run as separate processes, so every method
// reloads from disk first: a write in one process is visible to the others on
// their next call (last-writer-wins, which is fine at demo write rates). Swap
// for hosted libSQL when stronger concurrency guarantees are needed.
export class JsonStore implements Store {
  private data: Shape;

  constructor(private file = "data/store.json") {
    this.data = this.read();
  }

  private read(): Shape {
    try {
      return { ...empty, ...(JSON.parse(fs.readFileSync(this.file, "utf8")) as Shape) };
    } catch {
      return structuredClone(empty);
    }
  }

  reload(): void {
    this.data = this.read();
  }

  private flush(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  putDraft(d: Draft): void {
    this.reload();
    this.data.drafts[d.id] = d;
    this.flush();
  }

  getDraft(id: string): Draft | undefined {
    this.reload();
    return this.data.drafts[id];
  }

  listDrafts(status?: DraftStatus): Draft[] {
    this.reload();
    const all = Object.values(this.data.drafts);
    return status ? all.filter((d) => d.status === status) : all;
  }

  setDraftStatus(id: string, status: DraftStatus): void {
    this.reload();
    const d = this.data.drafts[id];
    if (!d) return;
    d.status = status;
    d.updatedAt = new Date().toISOString();
    this.flush();
  }

  putSignalAccount(a: SignalAccount): void {
    this.reload();
    this.data.signalAccounts[a.handle] = a;
    this.flush();
  }

  listSignalAccounts(): SignalAccount[] {
    this.reload();
    return Object.values(this.data.signalAccounts);
  }

  clearSignalAccounts(): void {
    this.reload();
    this.data.signalAccounts = {};
    this.flush();
  }

  putApproval(a: ApprovalRecord): void {
    this.reload();
    this.data.approvals[a.draftId] = a;
    this.flush();
  }

  getApproval(draftId: string): ApprovalRecord | undefined {
    this.reload();
    return this.data.approvals[draftId];
  }

  incDailyCount(type: ContentType): number {
    this.reload();
    const key = `${today()}:${type}`;
    this.data.counters[key] = (this.data.counters[key] ?? 0) + 1;
    this.flush();
    return this.data.counters[key];
  }

  getDailyCount(type: ContentType): number {
    this.reload();
    return this.data.counters[`${today()}:${type}`] ?? 0;
  }

  getFlag(name: Flag): boolean {
    this.reload();
    return this.data.flags[name] ?? false;
  }

  setFlag(name: Flag, value: boolean): void {
    this.reload();
    this.data.flags[name] = value;
    this.flush();
  }

  addPostedText(text: string): void {
    this.reload();
    this.data.postedTexts.push({ text, at: new Date().toISOString() });
    this.flush();
  }

  recentPostedTexts(days: number): string[] {
    this.reload();
    const cutoff = Date.now() - days * 86400000;
    return this.data.postedTexts
      .filter((p) => Date.parse(p.at) >= cutoff)
      .map((p) => p.text);
  }

  putPost(p: Post): void {
    this.reload();
    this.data.posts[p.id] = p;
    this.flush();
  }

  getPost(id: string): Post | undefined {
    this.reload();
    return this.data.posts[id];
  }

  getPostByDraft(draftId: string): Post | undefined {
    this.reload();
    return Object.values(this.data.posts).find((p) => p.draftId === draftId);
  }

  listPosts(): Post[] {
    this.reload();
    return Object.values(this.data.posts);
  }

  putLearning(l: Learning): void {
    this.reload();
    this.data.learnings.push(l);
    this.flush();
  }

  recentLearnings(limit: number): Learning[] {
    this.reload();
    return this.data.learnings.slice(-limit).reverse();
  }

  addImpactJob(j: ImpactJob): void {
    this.reload();
    this.data.impactJobs.push(j);
    this.flush();
  }

  dueImpactJobs(nowIso: string): ImpactJob[] {
    this.reload();
    const now = Date.parse(nowIso);
    return this.data.impactJobs.filter((j) => !j.done && Date.parse(j.dueAt) <= now);
  }

  completeImpactJob(postId: string, checkpoint: Checkpoint): void {
    this.reload();
    for (const j of this.data.impactJobs) {
      if (j.postId === postId && j.checkpoint === checkpoint) j.done = true;
    }
    this.flush();
  }

  appendEvent(e: Omit<LoopEvent, "id" | "ts">): void {
    this.reload();
    const ev: LoopEvent = {
      ...e,
      id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      ts: new Date().toISOString(),
    };
    this.data.events.push(ev);
    if (this.data.events.length > 300) {
      this.data.events = this.data.events.slice(-300);
    }
    this.flush();
  }

  recentEvents(limit: number): LoopEvent[] {
    this.reload();
    return this.data.events.slice(-limit).reverse();
  }
}

let singleton: JsonStore | undefined;

export function getStore(): JsonStore {
  if (!singleton) singleton = new JsonStore();
  return singleton;
}
