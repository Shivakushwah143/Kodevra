import fs from "node:fs";
import path from "node:path";

import { deriveContract } from "../lib/verification-contract.js";
import { runContractVerification } from "../lib/verification-runner.js";
import { resolveExecutor } from "../lib/executors.js";

const root = path.resolve(".probe-verify/work");
fs.rmSync(root, { recursive: true, force: true });
const write = (rel, text) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};

// A Vite/React-shaped project whose build succeeds but whose bundle throws.
write("package.json", JSON.stringify({ name: "probe-app", scripts: { build: "node build.js" }, dependencies: { react: "^18" } }, null, 2));
write("build.js", "console.log('built');\n");
write("dist/index.html", '<!doctype html><html><body><div id="root"></div><script src="./app.js"></script></body></html>');
write("dist/app.js", 'document.getElementById("root").textContent = "Tasks";\nnotDefinedAnywhere();\n');

const executor = resolveExecutor("host");
const contract = deriveContract({ workspace: root, verifyCommand: "node build.js" });
console.log("derived:", JSON.stringify({
  kind: contract.project.kind,
  gates: contract.repository.map((g) => `${g.id}:${g.command}:${g.source}`),
  runtime: contract.runtime && { adapter: contract.runtime.adapter, mode: contract.runtime.mode, dir: contract.runtime.dir },
}));

const failing = await runContractVerification({ contract, workspace: root, executor });
console.log("runtime-fail ok:", failing.ok, "verdict:", failing.verdict, "code:", failing.code, "status:", failing.status);
console.log("gates:", failing.gates.map((g) => `${g.layer}:${g.id}:${g.skipped ? "skip" : g.ok ? "pass" : "fail"}`).join(" "));
console.log("evidence has ReferenceError:", /ReferenceError/.test(failing.output));
console.log("evidence:\n" + failing.output.split("\n").slice(0, 12).join("\n"));

// Same project, working bundle.
write("dist/app.js", 'document.getElementById("root").textContent = "Tasks";\n');
const passing = await runContractVerification({ contract, workspace: root, executor });
console.log("runtime-pass ok:", passing.ok, "verdict:", passing.verdict, "status:", passing.status, "code:", passing.code);
console.log("evidence:", passing.output.split("\n").slice(2, 5).join(" | "));
