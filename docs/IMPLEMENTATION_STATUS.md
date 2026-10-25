# Kodevra — FRD implementation status

Source of truth: `Kodevra_Master_FRD_v1.1.md`. This file records what the code actually does, not what the FRD
intends. Status values: **IMPLEMENTED**, **PARTIAL**, **MISSING**, **BLOCKED**, **DEFERRED**. Evidence points at the
file and the command that produced the observation.

Architecture rule unchanged: OpenCode is the only tool-execution owner. Kodevra is the brand, setup, selection,
diagnostics, verification-reporting and failure-classification layer. Nothing here adds a second agent loop.

## P0 — prototype

| ID | Status | Evidence |
| --- | --- | --- |
| FR-001 | IMPLEMENTED | `lib/brand.js` banner shows product, engine, model, auth, mode and workspace. `node bin/kodevra.js doctor`. |
| FR-002 | IMPLEMENTED | Workspace is selected (`kodevra <path>`, `-w`) and validated before any run. Automated runs get a permission overlay (`lib/permissions.js`, passed via `OPENCODE_CONFIG`) where `read`/`edit` are denied outside the selected workspace and `external_directory` is `deny`. Verified: external read/write denied, workspace read/write allowed, junction escape denied. Interactive launch keeps the engine's prompts. |
| FR-003 | IMPLEMENTED | `kodevra doctor` + a real `deepseek-v4-flash` completion in this session. |
| FR-004 | IMPLEMENTED | Proxy health, model list, and a real tool round trip (`examples/agent-smoke` repair). |
| FR-005 | IMPLEMENTED | Kodevra spawns `opencode`; `lib/engine.js` only streams and collects its output. No file or shell tool lives in Kodevra. |
| FR-006 | IMPLEMENTED | Agent reads real files in `examples/agent-smoke` during the smoke run. |
| FR-007 | IMPLEMENTED | Agent edit plus a workspace-scoped `git status` / `git diff --stat` in the TASK RESULT block (`lib/verify.js`). |
| FR-008 | IMPLEMENTED | Engine runs commands in the workspace; the verification command is executed by Kodevra in the same cwd (`lib/engine.js`). |
| FR-009 | IMPLEMENTED | `--verify "<command>"` prints the exact command and exit code; PASS is only claimed on exit 0. Execution requires a developer authorization bound to a fingerprint of scripts, tests and their configuration (`lib/authorization.js`); a changed surface blocks execution until `--reapprove`. Runs through the host executor or the isolated Docker executor. The agent's own `sandbox_exec` calls use the same Docker executor, while the `--verify` gate stays authoritative for PASS/FAIL. |
| FR-010 | IMPLEMENTED | Engine approvals. `--mode ask` keeps prompts, `--mode read-only` uses the `plan` agent. `bash` is `ask` in automated runs (headless shell was `auto-rejecting`) and `deny` with `--executor docker`, where the only shell is the sandboxed `sandbox_exec` tool. Read-only run left `keep.txt` unchanged. |
| FR-011 | IMPLEMENTED | `lib/failures.js` classifies provider/adapter/tool/permission failures with a next action; `lib/verify.js` marks an unverified run `UNVERIFIED`. |
| FR-012 | IMPLEMENTED | Credential checks are presence-only (`lib/providers.js`, `lib/auth.js`); no value is read or printed. |
| FR-013 | IMPLEMENTED | `kodevra doctor` checks node, engine, config, provider, model, auth, proxy and workspace with redacted detail. |

## P1 — developer alpha

| ID | Status | Evidence |
| --- | --- | --- |
| FR-014 | PARTIAL | Engine output streams live through `lib/engine.js`; `lib/events.js` now emits structured lifecycle events (`run_started`, `model_started/finished`, `file_changes`, `verification_*`, `sandbox_started/finished`, `repair_started`, `approval_required`, `failure`, `run_finished`) as JSON Lines. Token-level/tool-level streaming still comes from the engine UI, and there is no cancellation event. |
| FR-015 | IMPLEMENTED | `kodevra providers`, `providers use`, `providers current`; selection lives in `~/.kodevra/state.json` and never rewrites the OpenCode config. |
| FR-016 | IMPLEMENTED | `kodevra sessions` lists the engine's local store; `-c/--continue` and `-s/--session <id>` resume from Kodevra. Stale-file caution is documented, not guessed. |
| FR-017 | IMPLEMENTED | `--mode read-only \| ask \| workspace-write` sets the engine agent (`plan`/`build`) and a matching permission overlay (`lib/permissions.js`): read-only denies edits, ask asks for them, workspace-write allows them inside the workspace only. Shell is `ask` in all three (with `--executor docker`, `bash` is `deny` and `sandbox_exec` is the sanctioned shell); unattended runs never pass `--auto`. |
| FR-018 | IMPLEMENTED | `--verify` + `--max-repairs` (default 2, cap 5). Stops when the same failure signature repeats, the model call fails, or the agent changed verification files (authorization gate); reports FAIL, never a fabricated pass. Observed: `FAIL (exit 3)`, `repairs 1/1`. |
| FR-019 | IMPLEMENTED (engine) | OpenCode validates tool names/arguments and rejects malformed calls; Kodevra classifies the resulting `MALFORMED_TOOL_CALL`. |
| FR-020 | PARTIAL | Context/capability data is read from the engine catalog (`catalogModelContext`, provider model lists). No per-request capability negotiation or automatic model downgrade. |
| FR-021 | IMPLEMENTED (engine) | OpenCode ships the `compaction` agent and owns compaction; Kodevra does not reimplement it. |
| FR-022 | IMPLEMENTED | `AUTH_EXPIRED`, `RATE_LIMITED`, `MODEL_UNAVAILABLE`, `CONTEXT_EXHAUSTED`, `PROXY_UNAVAILABLE` are distinct codes with distinct next actions, separate from a failed test. |
| FR-023 | BLOCKED | `gemini-web` is deliberately unsupported: every surveyed adapter replays Google session cookies. Supported path is `google-api` or Gemini via `openrouter`. |
| FR-024 | PARTIAL | ChatGPT sign-in is delegated to OpenCode's official OAuth. SIWC eligibility/pricing review is a product/legal task, not code. |

## P2 — commercial (not in this batch)

FR-025 packaged installer, FR-026 team policies, FR-027 premium features, FR-028 dashboard/analytics, FR-029 signed
distribution and updates, FR-030 operation-level rollback: **DEFERRED**. Git remains the current rollback mechanism.

## Non-functional

| ID | Status | Note |
| --- | --- | --- |
| NFR-01 local-first | IMPLEMENTED | No Kodevra backend; sessions live in the engine's local store. |
| NFR-02 access control | IMPLEMENTED | Engine-enforced. Automated runs deny file access outside the workspace, deny external directories, and reject unapproved shell calls; with `--executor docker` host `bash` is denied outright and model commands go through `sandbox_exec` in a disposable container. |
| NFR-03 safety | PARTIAL | Agent file tools are workspace-scoped and unattended shell is denied, but that is permission policy, not an OS sandbox. With `--executor docker`, model-requested commands (`sandbox_exec`) and final verification both run in an ephemeral Docker container with no network, capabilities or host mounts; the agent's file tools still run on the host, and interactive launches keep unrestricted approved shell. |
| NFR-04 observability | PARTIAL | Each run has a `run_id` and a JSONL event log (`~/.kodevra/runs/`) with timestamps, executor, sandbox flag, container image, snapshot path, staged file count, exit codes, durations, changed files, failure codes, approval decisions and `sandbox_started`/`sandbox_finished` for every agent command. No token/cost accounting or provider request IDs yet. |
| NFR-05 maintainability | IMPLEMENTED | OpenCode and FreeDeepseekAPI untouched; integration defects fixed in Kodevra. |
| NFR-06 replaceability | IMPLEMENTED | Providers are descriptors in `lib/providers.js` / `lib/config.js`; the agent loop is untouched. |
| NFR-07 truthful completion | IMPLEMENTED | PASS requires a real exit 0; unverified runs say `UNVERIFIED`; failures print code + origin. |
| NFR-08 availability | PARTIAL | Failures are visible and are not retried automatically; no timeout budget on the engine call itself. |
| NFR-09 user control | IMPLEMENTED | Stop via the engine, provider selection, diff inspection, mode selection. |
| NFR-10 licensing | IMPLEMENTED | `THIRD_PARTY_NOTICES.md`; upstream code is not vendored (the proxy folder is git-ignored). |

## Implemented in this batch

1. **Failure taxonomy** — `lib/failures.js`: provider/adapter/permission/tool/cancellation classification with an
   actionable next step, plus a proxy-reachability fact check.
2. **Engine streaming** — `lib/engine.js`: streams engine output live while keeping the tail for classification, and
   runs a workspace-scoped verification command with a timeout.
3. **Verification and bounded repair** — `lib/verify.js`: workspace-scoped git evidence, failure signatures, the repair
   prompt, and the TASK RESULT block. CLI: `--verify`, `--max-repairs`.
4. **Automation modes** — `read-only` / `ask` / `workspace-write`, reusing the engine's `plan` agent and `--auto`.
5. **Sessions** — `kodevra sessions`, `-c/--continue`, `-s/--session`.
6. **CLI hardening** — workspace existence pre-check, mode in the banner, verified exit codes, failure lines.
7. **Regression tests** — `test/failures.test.js`, `test/verify.test.js`, `test/permissions.test.js`, `test/authorization.test.js`, `test/events.test.js`, `test/executors.test.js`, `test/sandbox.test.js`, `test/docker.test.js`, `test/sandbox-tool.test.js`, `test/brand.test.js`, `test/progress.test.js` (46 tests, `npm test`).

## Execution safety added in the developer-alpha batch

Goal: autonomous runs may edit the selected workspace but must not reach outside it or execute unapproved shell
commands, without forking OpenCode.

- `lib/permissions.js` builds a permission overlay and writes it to `~/.kodevra/run/opencode-<pid>.json` for the
  duration of one run, then deletes it. Only permission keys are generated, so no provider credential is copied.
  A user-managed `OPENCODE_CONFIG` is merged into the overlay instead of being replaced.
- The overlay uses `read`/`edit` deny-by-default with a workspace allow pattern, `external_directory: deny`, and
  `bash: ask`. Patterns are relative to the engine's project root, computed with `git rev-parse --show-prefix`, so a
  nested workspace is still scoped to itself. Absolute allow patterns were tested and do **not** match in 1.18.30.
- Headless OpenCode auto-rejects an unanswered `ask`, so unattended runs have no shell authority. Kodevra never
  passes `--auto` for `run`; an explicit `--auto` is reported as ignored.
- Verification commands (`--verify`) are run by Kodevra itself, in the workspace, with the developer's own command —
  that path is unchanged by the agent's shell restriction.

Verified in a disposable workspace (`.tmp/iso/ws2`) inside the Kodevra repository:

| Check | Observed |
| --- | --- |
| read `inside.txt` | allowed, content returned |
| write `written.txt` | allowed, file created |
| read `C:/Windows/win.ini` | denied: `external_directory` rule |
| write `../outside/evil.txt` | denied: `edit` rule, file absent |
| `bash: echo probe` | `permission requested: bash ...; auto-rejecting` |
| read through a junction to `C:/Windows` | denied after real-path resolution |
| DeepSeek coding smoke with `--verify "npm test"` | file fixed, `PASS (exit 0)`, no shell used |

## Controlled verification and structured events (this batch)

**Authorization before host execution.** `--verify "<command>"` is recorded as the developer's explicit
authorization, bound to the command and to a fingerprint of the files that decide what it runs: package scripts and
lockfiles, test-runner and build configuration, test files/directories, and any path the command names. Before every
execution Kodevra re-hashes that surface:

- unchanged -> the command runs through the resolved executor;
- changed, added or removed -> execution is refused, the changed files are printed, the run exits 1, and an
  `approval_required` event is emitted. No project code runs;
- `--reapprove` -> the developer explicitly renews authorization on the current surface (`verification_reapproved`),
  then the command runs.

The gate is applied between bounded repair attempts too, so a repair cannot make a suite pass by editing it.

**Executor seam.** `lib/executors.js` defines `{ name, sandboxed, description, check(), run(command, options) }`.
`host` wraps the existing verified executor and reports `sandboxed: false`; `docker` runs the command in an ephemeral
Linux container (see below). An unknown or unavailable executor fails with `EXECUTOR_UNAVAILABLE`, Kodevra never
falls back silently, and the report always states whether the executor is sandboxed.

**Structured events.** `lib/events.js` appends one JSON object per line to `~/.kodevra/runs/<run_id>.jsonl`, and
`--events-json` mirrors the same lines to stderr for a future branded terminal interface. There is no database or
message bus: fields come from engine timings, git state and verification results Kodevra already has. Each entry has
`run_id`, `ts`, `event` plus event-specific metadata (no prompts, no file contents, no credentials).

Verified in disposable workspaces:

| Check | Observed |
| --- | --- |
| agent adds `test/extra.test.js` under `--verify "npm test"` | `verification refused - approval required`, 0 executions, exit 1, `approval_required` event |
| same change with `--reapprove` | `verification_reapproved`, 1 execution, `PASS (exit 0)`, exit 0 |
| `--executor nope` | `Unknown executor "nope". Available: host, docker`, exit 2, no fallback |
| refused-run event file | `run_started`, `verification_authorized`, `model_started/finished`, `file_changes`, `approval_required`, `run_finished` |
| reapproved-run event file | adds `verification_reapproved`, `verification_started`, `verification_finished` |
| DeepSeek coding smoke with `--verify` | `PASS (exit 0)`, events file written, 22.0s |
| `--events-json` short run | 8 JSON events on stderr |

Every report prints `executor host - runs project code directly on this machine not sandboxed` and the authorization
source with the surface fingerprint short hash.

## Docker executor (this batch)

Verification can run in an ephemeral Linux container instead of the host. The agent, provider and verification loop
are unchanged; only the executor differs.

- `checkDocker()` probes the Docker CLI and Linux engine before the model runs, treats a stopped engine as
  `EXECUTOR_UNAVAILABLE` with setup guidance, refuses Windows-container mode, and pulls `node:22-alpine` once if it
  is absent.
- `lib/sandbox.js` stages a private copy under `~/.kodevra/sandboxes/`. `.git`, `integrations/`, `.env*`, `auth.json`,
  `deepseek-auth.json`, `credentials*.json`, `*.pem`, `*.key`, `.npmrc`, `.netrc`, `id_rsa*` and symlinks are skipped;
  staging is capped at 20,000 files / 512 MB.
- `lib/docker-executor.js` starts one `--rm` container with `--network none`, `--cap-drop ALL`,
  `--security-opt no-new-privileges`, `--user 1000:1000`, `--read-only` + tmpfs scratch, `--pids-limit 256`,
  `--memory 2g`, `--cpus 2`, a wall-clock timeout and only the snapshot bind-mounted at `/workspace`. There is no
  Docker socket and no host secret mount.
- Cleanup runs on success, failure, timeout and SIGINT/SIGTERM: `docker rm -f` plus snapshot deletion. `--rm` is a
  second layer.
- Events and results carry `executor: docker`, `sandboxed: true`, `image`, `snapshot`, `staged_files`, exit code and
  duration. The source workspace is never mounted; the report prints the snapshot path separately.

Verified on this machine (Docker Desktop, Linux engine):

| Check | Observed |
| --- | --- |
| engine probe | `docker version --format '{{.Server.Os}}'` -> `linux`; `node:22-alpine` pulled |
| passing Node project, `--executor docker --verify "npm test"` | `PASS (exit 0)`, snapshot printed, source `marker.txt` unchanged |
| write to `/etc/escape.txt` from the container | `blocked-outside` (read-only root filesystem) |
| network reachability | `fetch('https://example.com')` rejected: `net=off` |
| failing test in the container | `FAIL (exit 1)`, process exit 1 |
| agent adds a test file, `--verify "npm test"` | `verification refused - approval required`, no container started |
| engine unreachable (`DOCKER_HOST` pointed at a missing pipe) | `EXECUTOR_UNAVAILABLE` guidance, exit 2, no host fallback |
| cleanup | 0 sandbox directories, 0 labelled containers left |
| host path regression (DeepSeek coding smoke) | `PASS (exit 0)`, 17.7s |

## Sandboxed agent terminal (this batch)

An unattended agent could previously read and edit files but never run them, so it had to guess whether its change
worked. `--executor docker` now gives the model exactly one shell: Kodevra's own `sandbox_exec` tool, loaded through
OpenCode's supported custom-tool mechanism. No upstream source is patched and there is no second agent loop.

- **Trusted installation.** `lib/sandbox-tool.js` copies `tools/sandbox_exec.js` to
  `~/.config/opencode/tools/sandbox_exec.js` (OpenCode's global custom-tool directory). The workspace is not used, so
  the agent's own edit permissions cannot reach the tool. The file carries a `kodevra-managed-tool` marker; a file
  without it is never overwritten (`TOOL_CONFLICT`, exit 2).
- **Inert by default.** The installed file returns a refusal unless the launching Kodevra process exported
  `KODEVRA_SANDBOX_EXEC=1` plus the workspace and run id. Interactive launches never set it.
- **Host shell stays denied.** With `--executor docker` the overlay sets `bash: deny` and `sandbox_exec: allow`, so
  native shell is unavailable and the tool is the only command path. Without the docker executor nothing changes.
- **Same executor, every call.** `lib/sandbox-command.js` re-stages the current workspace through `lib/sandbox.js` and
  calls `runInDocker` — the same flags, resource limits, snapshot exclusions and cleanup as `--verify`. Each command
  gets a fresh container and a per-call timeout (default 120 s, capped at 300 s).
- **Real results.** The model receives exit code, timeout state, duration, stdout and stderr (bounded) plus the
  container name, image and staged file count. It can read a failure, edit source and run the command again.
- **No import path.** The container filesystem is thrown away; there is no mechanism to copy generated files back
  into the workspace.
- **No fallback.** A missing engine returns `EXECUTOR_UNAVAILABLE` with setup guidance inside the tool result; the
  command is never retried on the host.
- **Events.** `sandbox_started` / `sandbox_finished` are appended to the existing `run_id` JSONL file by
  `appendRunEvent`, so agent commands, verification and repairs share one timeline.

Verified with a real DeepSeek run in `examples/agent-smoke` (`--executor docker --verify "npm test"`), after
reintroducing the `_`/`-` separator bug in `src/slugify.js`:

| Check | Observed |
| --- | --- |
| tool load | `tool sandbox_exec -> C:\Users\...\.config\opencode\tools\sandbox_exec.js docker sandbox`; model called it twice |
| first `sandbox_exec` call | `exit 1`, real TAP failure (`+ 'hello_world' - 'hello-world'`), `staged 3 file(s)`, 5.9 s |
| model action | read `src/slugify.js`, changed the separator back to `-` |
| second `sandbox_exec` call | `exit 0`, `ok 1 - slugify produces stable url slugs`, 2.1 s |
| final `--verify "npm test"` | `PASS (exit 0)` through the docker executor, snapshot printed, source workspace not mounted |
| event file | one `run_id`, `run_started` (`sandbox_exec: true`), two `sandbox_started`/`sandbox_finished` pairs, `verification_finished`, `run_finished` |
| Docker unavailable (`DOCKER_HOST` at a missing pipe) | `EXECUTOR_UNAVAILABLE` + `Start Docker Desktop...`, exit 125, no host execution |
| cleanup | 0 sandbox directories, 0 labelled containers |
| `npm test` | 40 pass / 0 fail |

## Branded developer experience (this batch)

- `lib/brand.js` now renders the startup panel: a single `◆ KODEVRA <version>` mark, the tagline, and aligned rows
  for workspace, model, provider, auth, sandbox and mode, plus three command hints. Colour is TTY/`NO_COLOR`
  aware; there is no animation, cursor control or multi-line ASCII art. `banner()` remains as the compact variant
  for `--help`, `providers` and `auth`.
- `kodevra doctor` gained a non-fatal `sandbox` row from `probeDocker()` (no image pull, 4 s timeout), so a
  developer can see Docker readiness without starting a container. Verified: `PASS sandbox docker ready · linux engine`.
- `lib/progress.js` tails the run's own JSONL file and turns `sandbox_started` / `sandbox_finished` into one line
  each (`sandbox npm test -> exit 0 (2.1s)`). Startup removed a second orchestration layer: the events Kodevra
  already writes are the only source.
- `lib/verify.js` prints `TASK COMPLETE` with files changed, sandbox commands, verification + exit code, repair
  attempts, duration, model, executor and sandbox status, authorization fingerprint and a single status word.
  `VERIFIED` requires a real exit 0; a failed command prints `FAILED`, an approval refusal `REFUSED`, and no
  verification `UNVERIFIED`. A failed verification used to be reported as UNVERIFIED; that was corrected.
- Workspace evidence now has a fallback: `snapshotTree()` / `treeChangedFiles()` record size and mtime (skipping
  `.git`, `node_modules`, `.tmp`, `.kodevra`, `dist`, `build`, capped at 20,000 files) so an ignored or untracked
  workspace reports real changes instead of "no changes vs git HEAD".
- Interactive TUI: OpenCode's interface is kept. Rebranding it would require patching upstream 1.18.30, which the
  architecture forbids; Kodevra owns the launcher, panel, setup, diagnostics and summaries around it.

Verified with a real DeepSeek run (`--executor docker --verify "npm test"`, task: run the suite and report):

| Check | Observed |
| --- | --- |
| launch panel | `◆ KODEVRA 0.2.0`, tagline, `Workspace/Mode/Model/Executor`, `Sandbox docker ready · linux engine` |
| doctor sandbox row | `PASS sandbox docker ready · linux engine` |
| live sandbox line | `sandbox npm test -> exit 0 (2.1s)` from `sandbox_finished` |
| completion summary | `Files changed 0 · Sandbox commands 1 · Verification PASS (exit 0) · Status VERIFIED` |
| metadata fallback | ignored workspace under `.tmp` reports the edited file instead of zero |

## Installable package and onboarding (this batch)

- `package.json` is 0.2.0, `private: true` (installs locally, cannot be published by accident) and has an explicit
  `files` allowlist: `bin/`, `lib/`, `tools/`, `docs/`, `README.md`, `THIRD_PARTY_NOTICES.md`. Tests, examples,
  benchmarks, `.env`, `auth.json`, sessions, runtime snapshots and `.tmp` are excluded. No dependency was added.
- `lib/onboarding.js` runs `kodevra init`: detects platform, Node, OpenCode version, Docker/Linux engine, config
  path and every provider's readiness; proposes the exact writes; asks for consent when interactive; merges config
  instead of replacing it; writes a backup; selects a ready provider only through Kodevra's own state; prints the
  next commands. `--yes` accepts non-interactively. It never installs software and never asks for a secret.
- `kodevra init` keeps the old behaviour (freedeepseek provider block when missing, 4096-token OpenRouter Gemini
  cap) and now reports `unchanged ... (existing settings were preserved)` on a second run.

Verified:

| Check | Observed |
| --- | --- |
| `npm pack --dry-run` | 24 files, 54.1 kB packed / 178.6 kB unpacked; no tests, examples or benchmarks |
| registry name | `npm view kodevra version` -> `404 not found` (name unclaimed, nothing published) |
| local global install | `npm install -g --prefix .tmp/pkgtest ./kodevra-0.2.0.tgz` -> installed, `kodevra --version` -> `Kodevra 0.2.0` |
| installed `--help` | branded panel + full command/option list |
| installed `doctor` | all PASS including `sandbox docker ready · linux engine` |
| installed real task | `kodevra run -w .tmp/pkgws --executor docker --verify "npm test"` -> `PASS (exit 0)`, `Status VERIFIED` |
| `kodevra init` (non-TTY) | setup panel, provider table, plan, `unchanged` writes, next commands; exit 0 |
| package content audit | `tar -tzf` lists only bin/lib/tools/docs/README/THIRD_PARTY_NOTICES/package.json |

## Coding benchmarks (this batch)

`benchmarks/` adds a reproducibility harness, not a claim of superiority.

- 20 tasks in 19 categories (bug fix, multi-file, API implementation, validation, refactoring, error handling, test
  repair, backend logic, async, dependency-aware, parsing, dates, sorting, strings, state machine, caching,
  pagination, security, CLI parsing). Each has `task.json`, a deliberately broken `template/`, one hidden
  `acceptance/acceptance.test.js`, and a reference `solution/`.
- `runner.js` validates manifests (`--validate`), proves each fixture is solvable (`--check`: template fails,
  hidden test fails on the template, reference solution passes), and runs both variants on the same model with the
  repository reset from its fixture before every run.
- Hidden tests and solutions are copied into the workspace only during `--check`; the agent never receives them.
  A SHA-256 fixture hash is taken before each run and a changed fixture rejects the run (`fixture tampered`).
- Workspaces live under `%TEMP%/kodevra-bench`, each initialized as its own git root, so Kodevra's workspace-scoped
  permission overlay cannot widen and an agent has no path to the fixtures.
- The runner resets the local proxy chat before every run
  (`POST /reset-session?agent=all&history=drop`). Without that, all CLI runs share one sticky DeepSeek conversation
  and sessions bleed between tasks and variants.
- Results are resumable (`raw/<variant>/<task>.json`, `runs.jsonl`) and `--summary` regenerates
  `results/summary.md` with executed/verified counts and the unexecuted list.

Verified:

| Check | Observed |
| --- | --- |
| `--validate` | `20 manifests checked ... all present` |
| `--check` | 20/20 fixtures sound (`template=1 hidden=1 solution=0` for every task) |
| fixture leak audit | 20 hidden tests, 0 present in any template |
| pilot (`01-cart-total`, both variants) | both timed out (124) while the proxy account was in cooldown; recorded as failures |
| proxy state during pilot | `failures: 6`, `cooldown: true`, `cooldown_remaining_sec: 267` |
| `results/summary.md` | `Runs executed: 2 (5%)`, 0 verified, pilot note, unexecuted list, fairness + gaps |

## Known limitations

- The permission overlay is policy, not an OS sandbox. An approved interactive shell command can reach any path the
  developer account can. The optional Docker executor isolates verification, not the agent.
- Unattended runs iterate only with `--executor docker`: without it, native shell stays rejected and the model cannot
  run a test or linter inside the run. `--verify` still covers that step.
- `--mode ask` in a headless run rejects every edit, because there is nobody to approve it; that is deliberate.
- External access for `glob`/`grep` is covered by `external_directory`, and the engine resolves real paths, but
  platform-specific link types beyond a Windows junction were not exercised.
- The repair loop stops on a repeated failure signature, `--max-repairs`, or an unchanged authorization; it does not
  attempt provider-level retry.
- Sessions are the engine's; there is no cross-project session management or Kodevra-side history.
- Events are lifecycle-level. OpenCode's CLI does not expose per-tool-call events or provider request IDs, so Kodevra
  does not invent them; run files under `~/.kodevra/runs/` also have no retention policy yet.
- Containers isolate commands, not the agent: with `--executor docker` both `sandbox_exec` and `--verify` run in the
  container, but the model still reads and edits the host workspace, and an interactively approved shell command is
  unrestricted.
- `sandbox_exec` necessarily talks to the Docker daemon on the host; the daemon and Docker Desktop are part of the
  trusted computing base. The tool receives no Docker socket, host credential or environment variable from the run.
- `sandbox_exec` output is bounded (16,000 characters of stdout/stderr) and the container image is fixed to
  `node:22-alpine`, so Node projects are the supported case; other runtimes would need a different image.
- Because every call re-stages the workspace, an agent editing many files then running long commands pays the staging
  cost each time, and nothing the command generates exists for the next call.
- Docker containment is not perfect: Docker Desktop, the host kernel and the runtime stay in the trusted computing
  base. The snapshot filter is name-based, so an unexpectedly named secret file can still be copied.
- The snapshot includes `node_modules` when present, under a 20,000-file / 512 MB budget; larger workspaces are
  refused rather than staged, and dependency installation inside the container has no network.
- The image default is `node:22-alpine`; other runtimes and Windows containers are not supported.
- `--executor host` remains available and is still the default; it is not sandboxed.
- Renewing authorization is an explicit flag (`--reapprove`), not an interactive prompt.
- `--verify` applies to `kodevra run` only; the interactive session has no headless result to check.
- The interactive terminal is still OpenCode's. Kodevra brands the launcher, panel, setup, diagnostics and
  summaries; rebranding the TUI itself would require patching upstream 1.18.30 and was not attempted.
- Benchmark fixtures are validated (20/20) but the live comparison is incomplete: the local DeepSeek proxy account
  entered cooldown (`failures: 6`) and both pilot variants timed out. No task success rate can be claimed yet.
- Benchmark runs use the host executor for both variants. Sandboxed execution (`--executor docker`) is a different
  environment and is not part of this comparison.
- The package is `private` and has not been published. Registry availability was checked once (404) and must be
  re-checked before any release. `files` is allowlisted, but only the local tarball contents were audited.
- Benchmark task difficulty, variance and token cost are unmeasured; one task family per category is a small sample
  even once the full 40 runs complete.

## Verification commands

```bash
node bin/kodevra.js doctor                  # all PASS expected
npm test                                    # Kodevra units (46)
node bin/kodevra.js run -w examples/agent-smoke --verify "npm test" "<task>"
node bin/kodevra.js run --verify "npm test" --events-json "<task>"   # events on stderr too
node bin/kodevra.js run --verify "npm test" --executor docker "<task>"  # isolated verification
node bin/kodevra.js run -w examples/agent-smoke --executor docker --verify "npm test" "<task>"
                                            # agent gets sandbox_exec for its own commands
npm pack --dry-run                          # package contents (24 files)
npm install -g --prefix .tmp/pkgtest ./kodevra-0.2.0.tgz   # local install check
node benchmarks/runner.js --validate        # 20 manifests
node benchmarks/runner.js --check           # 20/20 fixtures sound
```

The scoping checks were run in a disposable workspace and removed afterwards; to repeat them, create a scratch
directory containing a file, then ask `kodevra run -w <scratch>` to read a system file, write outside the scratch
directory, and run `echo probe`. Expect a rule denial for the external paths and `auto-rejecting` for the command.
