// De-risking test for the Grok sensing path.
// Does a REAL call only when XAI_API_KEY is present, otherwise skips.
//
//   pnpm exec tsx scripts/smoke-grok.ts
//
// Runs a trivial x_search brief through tools/grok and prints the answer and
// citation count. Exits nonzero on failure.
import { research } from "../tools/grok.js";

if (!process.env.XAI_API_KEY) {
  console.log("skip: XAI_API_KEY not set");
  process.exit(0);
}

async function main(): Promise<void> {
  const out = await research({
    brief:
      "In one sentence, what is one thing founders on X are talking about today? Keep it short.",
    searchTools: ["x_search"],
  });
  const snippet = out.answer.replace(/\s+/g, " ").trim().slice(0, 200);
  console.log(`  answer: ${snippet}`);
  console.log(`  citations: ${out.citations.length}`);
  if (out.answer.trim().length === 0) throw new Error("empty answer from grok");
  console.log("PASS grok");
}

main().catch((e) => {
  console.log(`FAIL grok  ${(e as Error).message}`);
  process.exit(1);
});
