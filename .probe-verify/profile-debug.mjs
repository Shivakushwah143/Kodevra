import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromeExecutable, openBrowserSession } from "../lib/verification-runtime.js";

const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("kodevra-browser-")));
const session = await openBrowserSession({ chromePath: chromeExecutable() });
await session.navigate("data:text/html,<p>x</p>");
await session.close();
await new Promise((resolve) => setTimeout(resolve, 500));

const after = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("kodevra-browser-") && !before.has(name));
console.log("leftover dirs:", after.length);
for (const name of after) {
  const dir = path.join(os.tmpdir(), name);
  const entries = fs.readdirSync(dir);
  console.log("  entries:", entries.slice(0, 12).join(", "), "count:", entries.length);
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    console.log("  manual removal: ok");
  } catch (error) {
    console.log("  manual removal failed:", error.code, error.message.slice(0, 160));
    for (const entry of entries.slice(0, 20)) {
      try {
        fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
      } catch (inner) {
        console.log("    locked:", entry, inner.code);
      }
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log("  after per-entry removal: ok");
    } catch (error) {
      console.log("  still present:", error.code);
    }
  }
}
