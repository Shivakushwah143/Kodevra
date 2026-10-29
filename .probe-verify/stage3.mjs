import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { deriveContract } from "../lib/verification-contract.js";
import { captureContractBaseline, runContractVerification } from "../lib/verification-runner.js";
import { startOwnedProcess } from "../lib/verification-runtime.js";
import { resolveExecutor } from "../lib/executors.js";
import { compactFailure } from "../lib/chatgpt-web-verify.js";
import { repairPrompt, resultLines } from "../lib/verify.js";
import { decideApproval } from "../lib/approval-policy.js";

const executor = resolveExecutor("host");
const base = path.resolve(".probe-verify/stage3");
fs.rmSync(base, { recursive: true, force: true });
const project = (name, files) => {
  const root = path.join(base, name);
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- baseline / delta ------------------------------------------------------
const delta = project("delta", {
  "package.json": JSON.stringify({ name: "delta", scripts: { typecheck: "node check.js" } }),
  "check.js": 'console.error("TypeError: cannot read property tasks"); process.exit(1);\n',
});
const deltaContract = deriveContract({ workspace: delta, verifyCommand: "node -e 0" });
const captured = await captureContractBaseline({ contract: deltaContract, workspace: delta, executor });
deltaContract.baseline = captured.baseline;
console.log("baseline gates:", JSON.stringify(Object.fromEntries(Object.entries(captured.baseline.gates).map(([k, v]) => [k, v.ok]))));

const unchanged = await runContractVerification({ contract: deltaContract, workspace: delta, executor });
console.log("same pre-existing failure: ok=" + unchanged.ok + " verdict=" + unchanged.verdict + " preExisting=" + JSON.stringify(unchanged.preExistingGates) + " failed=" + JSON.stringify(unchanged.failedGates));

fs.writeFileSync(path.join(delta, "check.js"), 'console.error("TypeError: a different, newly introduced bug"); process.exit(1);\n');
const regressed = await runContractVerification({ contract: deltaContract, workspace: delta, executor });
console.log("new failure mode: ok=" + regressed.ok + " verdict=" + regressed.verdict + " failed=" + JSON.stringify(regressed.failedGates) + " code=" + regressed.code);

const clean = project("delta-clean", {
  "package.json": JSON.stringify({ name: "delta2", scripts: { typecheck: "node check.js" } }),
  "check.js": "process.exit(0);\n",
});
const cleanContract = deriveContract({ workspace: clean, verifyCommand: "node -e 0" });
cleanContract.baseline = (await captureContractBaseline({ contract: cleanContract, workspace: clean, executor })).baseline;
fs.writeFileSync(path.join(clean, "check.js"), 'console.error("TypeError: broke it"); process.exit(1);\n');
const freshBreak = await runContractVerification({ contract: cleanContract, workspace: clean, executor });
console.log("baseline-passed then broken: ok=" + freshBreak.ok + " verdict=" + freshBreak.verdict + " failed=" + JSON.stringify(freshBreak.failedGates));

// ---- --verify only compatibility -------------------------------------------
const plain = project("plain", {
  "package.json": JSON.stringify({ name: "plain-lib", main: "index.js" }),
  "index.js": "module.exports = 1;\n",
});
const plainContract = deriveContract({ workspace: plain, verifyCommand: "node -e process.exit(0)" });
console.log("plain contract gates:", plainContract.repository.map((g) => g.id).join(","), "runtime:", plainContract.runtime?.adapter ?? "none");
const plainRun = await runContractVerification({ contract: plainContract, workspace: plain, executor, includeRuntime: false });
console.log("verify-only: ok=" + plainRun.ok + " status=" + plainRun.status + " command=" + plainRun.command + " verdict=" + plainRun.verdict);
const plainFailContract = deriveContract({ workspace: plain, verifyCommand: "node -e process.exit(7)" });
const plainFail = await runContractVerification({ contract: plainFailContract, workspace: plain, executor, includeRuntime: false });
console.log("verify-only failing: ok=" + plainFail.ok + " status=" + plainFail.status + " code=" + plainFail.code);

// ---- repair evidence + summary ---------------------------------------------
const webRoot = project("webfail", {
  "package.json": JSON.stringify({ name: "w", scripts: { build: "node -e 0" }, dependencies: { vite: "^5" } }),
  "dist/index.html": '<!doctype html><div id="root"></div><script src="./app.js"></script>',
  "dist/app.js": "missingFn();",
});
const webContract = deriveContract({ workspace: webRoot, verifyCommand: "node -e 0" });
const webResult = await runContractVerification({ contract: webContract, workspace: webRoot, executor });
const compacted = compactFailure(webResult, { maxChars: 3500 });
console.log("compacted evidence carries the gate:", /FRONTEND_RUNTIME_FAILED|ReferenceError/.test(compacted), "chars:", compacted.length);
const prompt = repairPrompt({ command: webResult.command, result: webResult, attempt: 1, maxRepairs: 2 });
console.log("repair prompt:", prompt.split("\n")[1]);
const summary = resultLines({
  model: "probe/model",
  durationMs: 1234,
  verification: webResult,
  repairs: 0,
  maxRepairs: 2,
  changes: { files: [], isGit: false, stat: null },
  failure: null,
  preexisting: 0,
  executor: { name: "host", sandboxed: false, description: "probe" },
  authorization: null,
  approval: null,
});
const summaryText = summary.join("\n");
console.log("summary verification line:", summary.find((line) => line.includes("->"))?.trim());
console.log(
  "summary has gate counts:",
  /Gates/.test(summaryText),
  "| failing gate listed:",
  /frontend-web/.test(summaryText),
  "| status:",
  summary.find((line) => line.includes("Status"))?.trim(),
);

// ---- owned processes -------------------------------------------------------
const owned = startOwnedProcess({ command: 'node -e "setTimeout(()=>{},60000)"', cwd: os.tmpdir() });
await sleep(500);
const aliveBefore = (() => {
  try {
    process.kill(owned.pid, 0);
    return true;
  } catch {
    return false;
  }
})();
owned.stop();
await sleep(600);
const aliveAfter = (() => {
  try {
    process.kill(owned.pid, 0);
    return true;
  } catch {
    return false;
  }
})();
console.log("owned process alive before stop:", aliveBefore, "| after stop:", aliveAfter);

const bystander = spawn("node", ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore" });
await sleep(400);
const chromeCount = () => (spawnSync("tasklist", ["/FI", "IMAGENAME eq chrome.exe", "/NH"], { encoding: "utf8" }).stdout.match(/chrome\.exe/gi) ?? []).length;
const profiles = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("kodevra-browser-")).length;
const chromeBefore = chromeCount();
const profilesBefore = profiles();
await runContractVerification({ contract: deriveContract({ workspace: webRoot, verifyCommand: "node -e 0" }), workspace: webRoot, executor });
await sleep(700);
console.log("bystander still alive:", bystander.exitCode === null);
console.log("chrome processes before/after:", chromeBefore + "/" + chromeCount(), "| temp profiles before/after:", profilesBefore + "/" + profiles());
bystander.kill();

// ---- approval policy unchanged --------------------------------------------
console.log(
  "autonomous approvals:",
  ["npm install", "npm run build", "pytest", "cargo build", "go test ./...", "gradle build", "tsc -p ."]
    .map((command) => decideApproval({ mode: "autonomous", action: { action: "shell", command } }).decision)
    .join(","),
);
console.log("autonomous hard block:", decideApproval({ mode: "autonomous", action: { action: "shell", command: "sudo npm install" } }).code);
console.log(
  "strict/balanced:",
  ["npm test", "npm install"]
    .map(
      (command) =>
        decideApproval({ mode: "strict", action: { action: "shell", command } }).decision +
        "/" +
        decideApproval({ mode: "balanced", action: { action: "shell", command } }).decision,
    )
    .join(" "),
);
