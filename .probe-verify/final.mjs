import fs from "node:fs";
import path from "node:path";

import { deriveContract } from "../lib/verification-contract.js";
import { captureContractBaseline, runContractVerification } from "../lib/verification-runner.js";
import { normalizeOutcome } from "../lib/outcome.js";
import { resultLines } from "../lib/verify.js";
import { resolveExecutor } from "../lib/executors.js";

const executor = resolveExecutor("host");
const root = path.resolve(".probe-verify/final-work");
fs.rmSync(root, { recursive: true, force: true });
const write = (rel, text) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};

write("package.json", JSON.stringify({ name: "final", scripts: { build: "node build.js", typecheck: "node check.js" }, dependencies: { vite: "^5" } }));
write("build.js", "process.exit(0);\n");
write("check.js", "process.exit(0);\n");
write("dist/index.html", '<!doctype html><div id="root"></div><script src="./app.js"></script>');
write("dist/app.js", 'document.getElementById("root").textContent = "Tasks";');

const contract = deriveContract({ workspace: root, verifyCommand: "node build.js" });
contract.baseline = (await captureContractBaseline({ contract, workspace: root, executor })).baseline;
const result = await runContractVerification({ contract, workspace: root, executor });
console.log("passing contract: ok=" + result.ok + " verdict=" + result.verdict + " command=" + result.command);
console.log("gates:", result.gates.map((g) => `${g.layer}:${g.id}:${g.ok ? "pass" : "fail"}`).join(" "));

const outcome = normalizeOutcome({
  harness: "probe",
  model: "probe/model",
  run: { status: 0, durationMs: 1000 },
  verification: result,
  changes: { files: [] },
  executor,
  startedAt: Date.now() - 5000,
  endedAt: Date.now(),
});
console.log("outcome status:", outcome.status, "ok:", outcome.ok, "verdict:", outcome.verification.verdict);
console.log("outcome contract gates:", outcome.verification.contract.gates.length, "| baseline recorded:", Boolean(outcome.verification.contract.baseline));
console.log("outcome serializes:", JSON.stringify(outcome).length, "chars");

const summary = resultLines({
  model: "probe/model",
  durationMs: 5000,
  verification: result,
  repairs: 0,
  maxRepairs: 2,
  changes: { files: [], isGit: false, stat: null },
  failure: null,
  preexisting: 0,
  executor,
  authorization: null,
  approval: null,
});
console.log("summary:", summary.filter((line) => /Verification|Gates|Status/.test(line)).map((line) => line.trim()).join(" | "));
