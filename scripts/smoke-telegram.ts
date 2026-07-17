// De-risking test for the Telegram interface.
// Does a REAL call only when TG_BOT_TOKEN is present, otherwise skips.
//
//   pnpm exec tsx scripts/smoke-telegram.ts
//
// Runs one getUpdates poll and prints any chat ids seen. This is how the
// principal's chat id is discovered for TG_CHAT_ID. Exits nonzero on failure.

// Imported for its side effect: loads config/.env so TG_BOT_TOKEN is picked up
// the same way the other smoke scripts get their keys.
import "../shared/env.js";

const token = process.env.TG_BOT_TOKEN;
if (!token) {
  console.log("skip: TG_BOT_TOKEN not set");
  process.exit(0);
}

interface Update {
  message?: { chat?: { id?: number; type?: string; username?: string } };
}

async function main(): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  const body = (await res.json()) as {
    ok?: boolean;
    description?: string;
    result?: Update[];
  };
  if (!body.ok) throw new Error(body.description ?? "getUpdates not ok");

  const updates = body.result ?? [];
  console.log(`  ${updates.length} update(s)`);
  const chats = new Map<number, string>();
  for (const u of updates) {
    const chat = u.message?.chat;
    if (chat?.id !== undefined) {
      chats.set(chat.id, `${chat.type ?? "?"} ${chat.username ? "@" + chat.username : ""}`.trim());
    }
  }
  if (chats.size === 0) {
    console.log("  no chats yet - send a message to the bot, then re-run");
  } else {
    for (const [id, label] of chats) {
      console.log(`  chat id ${id}  (${label})  <- set TG_CHAT_ID to this`);
    }
  }
  console.log("PASS telegram");
}

main().catch((e) => {
  console.log(`FAIL telegram  ${(e as Error).message}`);
  process.exit(1);
});
