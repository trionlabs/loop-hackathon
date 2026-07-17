export type ContentType = "post" | "reply" | "thread";

export type DraftStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "edited"
  | "rejected"
  | "scheduled"
  | "posted"
  | "measuring"
  | "learned";

export interface Draft {
  id: string;
  type: ContentType;
  text: string;
  linkReply?: string;
  mediaUrl?: string;
  mediaId?: string;
  slot?: string;
  status: DraftStatus;
  sessionId?: string;
  rationale?: string;
  predictedDriver?: string;
  appliedLearningId?: string;
  createdAt: string;
  updatedAt: string;
}

export type ApprovalDecision = "approved" | "edited" | "rejected";

export interface ApprovalRecord {
  draftId: string;
  decision: ApprovalDecision;
  editedText?: string;
  reason?: string;
  decidedAt: string;
  decidedBy: string;
}

export interface PostMetrics {
  impressions?: number;
  likes?: number;
  replies?: number;
  reposts?: number;
  quotes?: number;
  bookmarks?: number;
  icpReplies?: number;
  postScore?: number;
  checkpoint?: Checkpoint;
}

export interface Post {
  id: string;
  draftId: string;
  text: string;
  type: ContentType;
  postedAt: string;
  metrics?: PostMetrics;
}

export interface Learning {
  id: string;
  date: string;
  loop: string;
  what: "hook" | "format" | "topic" | "timing";
  observed: string;
  hypothesis: string;
  confidence: number;
  actionTaken?: string;
}

export interface SignalAccount {
  handle: string;
  tier: "signal" | "watchlist" | "noise";
  goal: string;
  score: number;
  r: number;
  q: number;
  a: number;
  v: number;
  f: number;
  rationale: string;
  lastScored: string;
  hysteresisHold?: boolean;
}

export type Checkpoint = "1h" | "24h" | "72h";

export interface ImpactJob {
  postId: string;
  dueAt: string;
  checkpoint: Checkpoint;
  done: boolean;
}

export type Flag = "crisis" | "paused" | "killswitch";

export type EventKind =
  | "tool"
  | "draft"
  | "approval"
  | "post"
  | "impact"
  | "learning"
  | "signal"
  | "info";

export interface LoopEvent {
  id: string;
  ts: string;
  loop: string;
  agent?: string;
  phase: string;
  detail: string;
  kind: EventKind;
}

export interface Store {
  reload(): void;

  putDraft(d: Draft): void;
  getDraft(id: string): Draft | undefined;
  listDrafts(status?: DraftStatus): Draft[];
  setDraftStatus(id: string, status: DraftStatus): void;

  putSignalAccount(a: SignalAccount): void;
  listSignalAccounts(): SignalAccount[];
  clearSignalAccounts(): void;

  putApproval(a: ApprovalRecord): void;
  getApproval(draftId: string): ApprovalRecord | undefined;

  incDailyCount(type: ContentType): number;
  getDailyCount(type: ContentType): number;

  getFlag(name: Flag): boolean;
  setFlag(name: Flag, value: boolean): void;

  addPostedText(text: string): void;
  recentPostedTexts(days: number): string[];

  putPost(p: Post): void;
  getPost(id: string): Post | undefined;
  getPostByDraft(draftId: string): Post | undefined;
  listPosts(): Post[];

  putLearning(l: Learning): void;
  recentLearnings(limit: number): Learning[];

  addImpactJob(j: ImpactJob): void;
  dueImpactJobs(nowIso: string): ImpactJob[];
  completeImpactJob(postId: string, checkpoint: Checkpoint): void;

  appendEvent(e: Omit<LoopEvent, "id" | "ts">): void;
  recentEvents(limit: number): LoopEvent[];
}
