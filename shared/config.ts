import fs from "node:fs";
import { parse as parseYaml } from "yaml";
import type { ApprovalRecord, ContentType, Draft } from "./types.js";

export type Autonomy = Partial<Record<ContentType, boolean>>;

export interface EmbargoConfig {
  topics: string[];
  crisis: string[];
}

// Single source of truth for earned autopilot. The hook and the write-server
// both read this same file so they cannot disagree.
export function loadAutonomy(): Autonomy {
  try {
    return JSON.parse(fs.readFileSync("config/autonomy.json", "utf8")) as Autonomy;
  } catch {
    return {};
  }
}

function toStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// Returns null when the config is missing or unparseable, so callers can fail
// closed. An empty-but-present config returns empty arrays, not null.
export function loadEmbargo(): EmbargoConfig | null {
  try {
    const doc = parseYaml(fs.readFileSync("config/embargo.yaml", "utf8")) as
      | Record<string, unknown>
      | null;
    return {
      topics: toStringArray(doc?.["topics"]),
      crisis: toStringArray(doc?.["crisis_keywords"] ?? doc?.["crisis"]),
    };
  } catch {
    return null;
  }
}

export function matchEmbargo(text: string, cfg: EmbargoConfig): string | null {
  const hay = text.toLowerCase();
  for (const term of [...cfg.topics, ...cfg.crisis]) {
    const t = term.toLowerCase().trim();
    if (t && hay.includes(t)) return term;
  }
  return null;
}

function trigrams(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const grams = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) {
    grams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  if (words.length > 0 && words.length < 3) grams.add(words.join(" "));
  return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function isDuplicate(text: string, recent: string[]): boolean {
  const cand = trigrams(text);
  for (const r of recent) {
    if (jaccard(cand, trigrams(r)) >= 0.5) return true;
  }
  return false;
}

// The text that will actually be posted. An edited approval carries the human
// rewrite; both the guard and the write-server must screen and post this exact
// string so an edit cannot bypass the dup/embargo checks.
export function effectiveText(draft: Draft, approval?: ApprovalRecord): string {
  if (approval?.decision === "edited" && approval.editedText) {
    return approval.editedText;
  }
  return draft.text;
}
