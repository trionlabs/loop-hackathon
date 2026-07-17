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
  Post,
  Store,
} from "./types.js";

interface Shape {
  drafts: Record<string, Draft>;
  approvals: Record<string, ApprovalRecord>;
  posts: Record<string, Post>;
  learnings: Learning[];
  counters: Record<string, number>;
  flags: Partial<Record<Flag, boolean>>;
  postedTexts: { text: string; at: string }[];
  impactJobs: ImpactJob[];
}

const empty: Shape = {
  drafts: {},
  approvals: {},
  posts: {},
  learnings: [],
  counters: {},
  flags: {},
  postedTexts: [],
  impactJobs: [],
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// Single-process JSON store. Authoritative for approvals, draft state,
// counters, flags, dedup corpus, impact jobs. Swap for hosted libSQL when the
// runner needs to survive a container restart.
export class JsonStore implements Store {
  private data: Shape;

  constructor(private file = "data/store.json") {
    this.data = this.load();
  }

  private load(): Shape {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      return { ...empty, ...(JSON.parse(raw) as Shape) };
    } catch {
      return structuredClone(empty);
    }
  }

  private flush(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  putDraft(d: Draft): void {
    this.data.drafts[d.id] = d;
    this.flush();
  }

  getDraft(id: string): Draft | undefined {
    return this.data.drafts[id];
  }

  listDrafts(status?: DraftStatus): Draft[] {
    const all = Object.values(this.data.drafts);
    return status ? all.filter((d) => d.status === status) : all;
  }

  setDraftStatus(id: string, status: DraftStatus): void {
    const d = this.data.drafts[id];
    if (!d) return;
    d.status = status;
    d.updatedAt = new Date().toISOString();
    this.flush();
  }

  putApproval(a: ApprovalRecord): void {
    this.data.approvals[a.draftId] = a;
    this.flush();
  }

  getApproval(draftId: string): ApprovalRecord | undefined {
    return this.data.approvals[draftId];
  }

  incDailyCount(type: ContentType): number {
    const key = `${today()}:${type}`;
    this.data.counters[key] = (this.data.counters[key] ?? 0) + 1;
    this.flush();
    return this.data.counters[key];
  }

  getDailyCount(type: ContentType): number {
    return this.data.counters[`${today()}:${type}`] ?? 0;
  }

  getFlag(name: Flag): boolean {
    return this.data.flags[name] ?? false;
  }

  setFlag(name: Flag, value: boolean): void {
    this.data.flags[name] = value;
    this.flush();
  }

  addPostedText(text: string): void {
    this.data.postedTexts.push({ text, at: new Date().toISOString() });
    this.flush();
  }

  recentPostedTexts(days: number): string[] {
    const cutoff = Date.now() - days * 86400000;
    return this.data.postedTexts
      .filter((p) => Date.parse(p.at) >= cutoff)
      .map((p) => p.text);
  }

  putPost(p: Post): void {
    this.data.posts[p.id] = p;
    this.flush();
  }

  getPost(id: string): Post | undefined {
    return this.data.posts[id];
  }

  putLearning(l: Learning): void {
    this.data.learnings.push(l);
    this.flush();
  }

  recentLearnings(limit: number): Learning[] {
    return this.data.learnings.slice(-limit).reverse();
  }

  addImpactJob(j: ImpactJob): void {
    this.data.impactJobs.push(j);
    this.flush();
  }

  dueImpactJobs(nowIso: string): ImpactJob[] {
    const now = Date.parse(nowIso);
    return this.data.impactJobs.filter(
      (j) => !j.done && Date.parse(j.dueAt) <= now,
    );
  }

  completeImpactJob(postId: string, checkpoint: Checkpoint): void {
    for (const j of this.data.impactJobs) {
      if (j.postId === postId && j.checkpoint === checkpoint) j.done = true;
    }
    this.flush();
  }
}

let singleton: JsonStore | undefined;

export function getStore(): JsonStore {
  if (!singleton) singleton = new JsonStore();
  return singleton;
}
