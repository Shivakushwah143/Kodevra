import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromeExecutable, openBrowserSession } from "../lib/verification-runtime.js";

const count = () => (spawnSync("tasklist", ["/FI", "IMAGENAME eq chrome.exe", "/NH"], { encoding: "utf8" }).stdout.match(/chrome\.exe/gi) ?? []).length;
const profiles = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("kodevra-browser-")).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("chrome path:", chromeExecutable());
console.log("before: chrome", count(), "profiles", profiles());
let session = null;
try {
  session = await openBrowserSession({ chromePath: chromeExecutable() });
  console.log("session opened");
  const nav = await session.navigate("data:text/html,<h1>hi</h1>");
  console.log("navigate:", nav);
  const state = await session.pageState();
  console.log("state:", state);
} catch (error) {
  console.log("session error:", error.code ?? "", error.message);
} finally {
  await session?.close();
}
await sleep(1200);
console.log("after close: chrome", count(), "profiles", profiles());
