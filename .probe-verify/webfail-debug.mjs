import fs from "node:fs";
import path from "node:path";

import { deriveContract } from "../lib/verification-contract.js";
import { runContractVerification } from "../lib/verification-runner.js";
import { resolveExecutor } from "../lib/executors.js";

const root = path.resolve(".probe-verify/webfail2");
fs.rmSync(root, { recursive: true, force: true });
const write = (rel, text) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};
write("package.json", JSON.stringify({ name: "w", scripts: { build: "node -e 0" }, dependencies: { vite: "^5" } }));
write("dist/index.html", '<!doctype html><div id="root"></div><script src="./app.js"></script>');
write("dist/app.js", "missingFn();");

const contract = deriveContract({ workspace: root, verifyCommand: "node -e 0" });
console.log("project:", contract.project, "runtime:", contract.runtime);
const result = await runContractVerification({ contract, workspace: root, executor: resolveExecutor("host") });
console.log("ok:", result.ok, "verdict:", result.verdict, "code:", result.code);
console.log("gates:", JSON.stringify(result.gates, null, 1));
console.log("evidence:\n" + result.output);
