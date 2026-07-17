import { getStore } from "./store.js";

// Records every outbound sponsor/API call as a loop event so the dashboard can
// show the requests as they happen. Best effort: never throws into the caller.

let ctxLoop = "system";
let ctxAgent = "orchestrator";

export function setContext(loop: string, agent: string): void {
  ctxLoop = loop;
  ctxAgent = agent;
}

export function logCall(p: {
  provider: string;
  endpoint: string;
  method: string;
  ms: number;
  status: number | string;
  model?: string;
  detail?: string;
}): void {
  try {
    getStore().appendEvent({
      loop: ctxLoop,
      agent: ctxAgent,
      phase: "call",
      kind: "tool",
      detail: p.detail ?? `${p.method} ${p.endpoint}`,
      provider: p.provider,
      endpoint: p.endpoint,
      method: p.method,
      model: p.model,
      ms: Math.round(p.ms),
      status: String(p.status),
    });
  } catch {
    /* telemetry is best effort */
  }
}
