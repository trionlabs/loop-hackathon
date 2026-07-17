import { fetch } from "undici";
import { getStore } from "../shared/store.js";
import type { Draft } from "../shared/types.js";
import { runContentPost } from "./orchestrator.js";

interface TgChat {
  id?: number;
}
interface TgFrom {
  id?: number;
}
interface TgMessage {
  message_id?: number;
  text?: string;
  chat?: TgChat;
  from?: TgFrom;
}
interface TgCallbackQuery {
  id: string;
  data?: string;
  from?: TgFrom;
  message?: TgMessage;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tg(token: string, method: string, body: unknown): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function sendDraftForApproval(draft: Draft): Promise<void> {
  const token = process.env.TG_BOT_TOKEN;
  const chatId = process.env.TG_CHAT_ID;
  if (!token || !chatId) {
    console.error("[telegram] TG_BOT_TOKEN or TG_CHAT_ID missing; cannot send draft");
    return;
  }
  const image = draft.mediaUrl ? `\nImage: ${draft.mediaUrl}` : "";
  const text = [
    `Draft ${draft.id} (${draft.type})`,
    "",
    draft.text,
    image,
    "",
    `Edit with: edit:${draft.id} <new text>`,
  ].join("\n");
  await tg(token, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Approve", callback_data: `approve:${draft.id}` },
          { text: "Reject", callback_data: `reject:${draft.id}` },
        ],
      ],
    },
  });
}

let polling = false;

export function startTelegramPoller(): void {
  if (polling) return;
  const token = process.env.TG_BOT_TOKEN;
  const chatId = process.env.TG_CHAT_ID;
  if (!token || !chatId) {
    console.error("[telegram] poller not started: TG_BOT_TOKEN or TG_CHAT_ID missing");
    return;
  }
  polling = true;
  void pollLoop(token, chatId);
}

// Single long-polling loop. deleteWebhook first so getUpdates is allowed.
async function pollLoop(token: string, chatId: string): Promise<void> {
  try {
    await tg(token, "deleteWebhook", { drop_pending_updates: false });
  } catch (e) {
    console.error("[telegram] deleteWebhook failed:", String(e));
  }
  let offset = 0;
  for (;;) {
    try {
      const resp = (await tg(token, "getUpdates", { offset, timeout: 30 })) as {
        ok?: boolean;
        result?: TgUpdate[];
      };
      for (const u of resp?.result ?? []) {
        offset = Math.max(offset, u.update_id + 1);
        try {
          await handleUpdate(token, chatId, u);
        } catch (e) {
          console.error("[telegram] handleUpdate error:", String(e));
        }
      }
    } catch (e) {
      console.error("[telegram] getUpdates error:", String(e));
      await sleep(3000);
    }
  }
}

async function handleUpdate(token: string, chatId: string, u: TgUpdate): Promise<void> {
  if (u.callback_query) return handleCallback(token, chatId, u.callback_query);
  if (u.message?.text) return handleMessage(token, chatId, u.message);
}

async function ack(token: string, id: string, text?: string): Promise<void> {
  await tg(token, "answerCallbackQuery", text ? { callback_query_id: id, text } : { callback_query_id: id });
}

// A forged Update otherwise defeats the single approval gate, so both the caller
// and the source chat must equal the configured principal chat.
async function handleCallback(
  token: string,
  chatId: string,
  cbq: TgCallbackQuery,
): Promise<void> {
  const from = cbq.from?.id !== undefined ? String(cbq.from.id) : "";
  const chat = cbq.message?.chat?.id !== undefined ? String(cbq.message.chat.id) : from;
  if (from !== chatId || chat !== chatId) {
    await ack(token, cbq.id, "unauthorized");
    return;
  }

  const [action, draftId] = (cbq.data ?? "").split(":");
  if (!draftId) {
    await ack(token, cbq.id);
    return;
  }

  const store = getStore();
  const draft = store.getDraft(draftId);
  if (!draft || draft.status !== "pending_approval" || store.getApproval(draftId)) {
    await ack(token, cbq.id, "already handled");
    return;
  }

  const decidedAt = new Date().toISOString();
  if (action === "approve") {
    store.putApproval({ draftId, decision: "approved", decidedAt, decidedBy: from });
    store.setDraftStatus(draftId, "approved");
    await ack(token, cbq.id, "approved, posting");
    try {
      await runContentPost(draftId);
    } catch (e) {
      console.error("[telegram] runContentPost failed:", String(e));
    }
    return;
  }
  if (action === "reject") {
    store.putApproval({ draftId, decision: "rejected", decidedAt, decidedBy: from });
    store.setDraftStatus(draftId, "rejected");
    await ack(token, cbq.id, "rejected");
    return;
  }
  await ack(token, cbq.id);
}

async function handleMessage(token: string, chatId: string, msg: TgMessage): Promise<void> {
  const chat = msg.chat?.id !== undefined ? String(msg.chat.id) : "";
  const from = msg.from?.id !== undefined ? String(msg.from.id) : chat;
  if (chat !== chatId || from !== chatId) return;

  const m = (msg.text ?? "").match(/^edit:(\S+)\s+([\s\S]+)$/);
  if (!m) return;
  const draftId = m[1];
  const newText = m[2].trim();

  const store = getStore();
  const draft = store.getDraft(draftId);
  if (!draft || draft.status !== "pending_approval" || store.getApproval(draftId)) {
    await tg(token, "sendMessage", { chat_id: chatId, text: `cannot edit ${draftId}` });
    return;
  }

  store.putDraft({ ...draft, text: newText, status: "edited", updatedAt: new Date().toISOString() });
  store.putApproval({
    draftId,
    decision: "edited",
    editedText: newText,
    decidedAt: new Date().toISOString(),
    decidedBy: from,
  });
  await tg(token, "sendMessage", { chat_id: chatId, text: `edited ${draftId}, posting` });
  try {
    await runContentPost(draftId);
  } catch (e) {
    console.error("[telegram] runContentPost failed:", String(e));
  }
}
