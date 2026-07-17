// De-risking test for the X API v2 write path.
// Does REAL calls only when the four X_* keys are present, otherwise skips.
//
//   pnpm exec tsx scripts/smoke-x.ts
//
// Posts a real tweet to the connected account, reads its metrics, then attempts
// a v2 media upload to confirm that endpoint works. Exits nonzero on failure.
import { getMetrics, postTweet, uploadMedia, verifyCredentials } from "../tools/x.js";

const required = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.log(`skip: ${missing.join(", ")} not set`);
  process.exit(0);
}

// 1x1 transparent PNG, used to probe the v2 media upload endpoint.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function main(): Promise<void> {
  const who = await verifyCredentials();
  console.log(`  auth ok, @${who.username}`);

  const marker = Date.now().toString(36);
  const posted = await postTweet({
    text: `SignalCMO smoke test ${marker} - please ignore.`,
  });
  console.log(`  posted tweet ${posted.id}`);

  const metrics = await getMetrics(posted.id);
  console.log(`  metrics ${JSON.stringify(metrics)}`);

  const media = await uploadMedia({ bytes: PNG_1X1, mime: "image/png" });
  console.log(`  media upload ok, media_id ${media.mediaId}`);

  console.log(`PASS x  tweet=${posted.id} media=${media.mediaId}`);
}

main().catch((e) => {
  console.log(`FAIL x  ${(e as Error).message}`);
  process.exit(1);
});
