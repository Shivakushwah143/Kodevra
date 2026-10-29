import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

import { chromeExecutable, openBrowserSession } from "../lib/verification-runtime.js";

const count = () => (spawnSync("tasklist", ["/FI", "IMAGENAME eq chrome.exe", "/NH"], { encoding: "utf8" }).stdout.match(/chrome\.exe/gi) ?? []).length;
const profiles = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("kodevra-browser-")).length;

console.log("start: chrome", count(), "profiles", profiles());
for (let index = 0; index < 3; index += 1) {
  const session = await openBrowserSession({ chromePath: chromeExecutable() });
  await session.navigate("data:text/html,<p>run</p>");
  const state = await session.pageState();
  await session.close();
  console.log(`run ${index + 1}: text=${JSON.stringify(state.text)} chrome=${count()} profiles=${profiles()}`);
}
