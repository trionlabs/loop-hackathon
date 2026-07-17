import express from "express";
import { startTelegramPoller } from "./telegram.js";
import { startScheduler } from "./scheduler.js";

const app = express();

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`[runner] health server listening on :${port}`);
});

startTelegramPoller();
startScheduler();
