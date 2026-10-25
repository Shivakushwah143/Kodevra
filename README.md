# Kodevra

**Your Models. Your Code. Your Agent.**

Kodevra is a thin, branded entry point for autonomous coding. It deliberately ships **no agent loop of its own**:
[OpenCode](https://opencode.ai) owns tool execution, permissions, sessions and the terminal interface, while
FreeDeepseekAPI provides OpenAI-compatible access to DeepSeek. Kodevra adds the product identity, a default model,
startup diagnostics, verification reporting and a one-word command.

```
  ◆ KODEVRA 0.2.0
  Your Models. Your Code. Your Agent.

  Workspace  ./my-project
  Model      freedeepseek/deepseek-v4-flash
  Provider   DeepSeek (FreeDeepseekAPI)
  Auth       ready · local proxy
  Sandbox    docker ready · linux engine
  Mode       workspace-write - workspace edits allowed
```

## Requirements

- Node.js 20 or newer
- OpenCode 1.18+ (`npm i -g opencode-ai`)
- The FreeDeepseekAPI proxy running on `http://127.0.0.1:9655/v1` with the `deepseek-v4-flash` model

## Install

```bash
npm install -g .                # from a checkout, or: npm install -g ./kodevra-0.2.0.tgz
kodevra init                    # guided setup: detects node, engine, Docker, providers
kodevra doctor                  # checks engine, provider, model, proxy, sandbox and workspace
kodevra                         # launch the agent in the current directory
```

`npm pack` produces a 54 kB tarball with 24 files: `bin/`, `lib/`, `tools/`, `docs/`, `README.md` and
`THIRD_PARTY_NOTICES.md`. Tests, examples, benchmarks, credentials, sessions and runtime state are not packaged.
The package is `private` on purpose: it installs locally but cannot be published by accident. The name `kodevra`
is unclaimed on the public registry as of 2026-10-25, so no release has been made.

### `kodevra init`

First-run setup detects and then asks, in this order: Node.js version, OpenCode and its version, the operating
system, Docker and its Linux engine, and every provider with its readiness state and the exact sign-in command.

It proposes the changes it will make — adding the `freedeepseek` provider block when missing and capping
`openrouter/google/gemini-3.6-flash` at 4096 output tokens — and applies them only after an interactive yes
(`--yes` accepts non-interactively). Existing configuration is merged, never replaced, and a backup is written
before any change. `kodevra init -p <provider>` selects a ready provider for future runs; if that provider is not
ready, DeepSeek stays the default and the exact `kodevra auth login` command is printed instead.

Kodevra never installs OpenCode or Docker, never asks for a password or browser cookie, and never writes a
credential into the package or the repository.

## Launch

```bash
kodevra                              # agent in the current directory
kodevra C:/path/to/project           # agent in another workspace
kodevra run "fix the failing test"   # one headless task (workspace-write by default)
kodevra run "fix the failing test" --verify "npm test"
                                     # the command decides PASS/FAIL, then bounded repair
kodevra run --verify "npm test" --executor docker "fix it"  # verify inside a container
kodevra run --verify "npm test" --reapprove "fix it"   # renew authorization after a surface change
kodevra run --verify "npm test" --events-json "fix it" # stream events on stderr
kodevra run -c "and add a test"      # continue the last session
kodevra sessions                     # list local sessions for this workspace
kodevra doctor                       # diagnostics only
kodevra providers                    # provider readiness, credentials and default models
kodevra providers use openai         # select a provider (Kodevra state, not OpenCode config)
kodevra init                         # add the DeepSeek provider if it is missing
node bin/kodevra.js                  # fallback: no global install required
```

Anything after `--` is forwarded to OpenCode unchanged:

```bash
kodevra -- --continue
```

Start the model proxy before launching:

```bash
cd integrations/FreeDeepseekAPI && npm start
```

## Verification, repair and modes

`kodevra run` reports what actually happened. With `--verify`, Kodevra runs your command in the workspace after the
agent finishes and lets its exit code decide the result:

```
kodevra run --verify "npm test" "fix the failing slugify test"

  verify  npm test
  ... real test output ...

  TASK COMPLETE

  Files changed    1
  Sandbox commands 2
  Verification     npm test -> PASS (exit 0)
  Repair attempts  none
  Duration         24.0s
  Model            freedeepseek/deepseek-v4-flash
  Executor         docker - ephemeral Linux container sandboxed

  Changes
  src/slugify.js
  1 file changed, 2 insertions(+), 1 deletion(-)

  Status           VERIFIED
```

- If the command fails, the failure output is handed back to the model and the command is re-run — at most
  `--max-repairs` times (default 2, capped at 5). The loop stops early when the same failure repeats, and it stops
  immediately if the model call itself fails.
- Without `--verify` the result block says **UNVERIFIED**; Kodevra never turns the model's prose into a green check.
  `VERIFIED` is printed only after the command actually exits 0; a failed command prints `FAILED`, an authorization
  refusal prints `REFUSED`, and `pilot`-style prose never influences the status line.
- `Changes` is read from git in the selected workspace only, so a project inside a larger repository is not credited
  with unrelated changes; when git cannot speak for the workspace (an ignored or untracked directory) Kodevra falls
  back to a file-metadata snapshot instead of reporting zero. Files already modified before the run are called out.
- Failures are classified (`PROXY_UNAVAILABLE`, `AUTH_EXPIRED`, `RATE_LIMITED`, `MODEL_UNAVAILABLE`,
  `MALFORMED_TOOL_CALL`, `TOOL_DENIED`, `CONTEXT_EXHAUSTED`, `CANCELLED`, ...) with one next action instead of a stack
  trace. A dead local proxy is detected by probing it, not by matching log text.

Modes reuse what OpenCode already enforces, plus a workspace-scoped permission overlay:

| `--mode` | Workspace files | Shell |
| --- | --- | --- |
| `read-only` | read only (`plan` agent) | needs approval |
| `ask` | reads allowed; edits need approval | needs approval |
| `workspace-write` | read and edit allowed inside the workspace | needs approval |

Every `kodevra run` writes a permission overlay to `~/.kodevra/run/` and launches OpenCode with
`OPENCODE_CONFIG` pointing at it (OpenCode merges that over your global config, so no provider or credential is
copied). Inside the overlay:

- `read` and `edit` are denied by default and re-allowed only under the selected workspace, so native file tools
  cannot reach outside it even when the workspace is a subdirectory of a larger repository;
- `external_directory` is `deny` as a second layer for glob/grep and any other tool that takes a path;
- `bash` is `ask`. A headless run has nobody to approve, so OpenCode rejects the call — unattended runs get **no
  host shell authority**. Interactive launches still prompt, and `--auto` is ignored for `run` on purpose.
- With `--executor docker`, `bash` is `deny` instead and the agent's only shell is Kodevra's `sandbox_exec` tool
  (below), which runs in a disposable container.
- `.env` reads stay `ask` (rejected unattended) even inside the workspace.

The engine resolves real paths before applying these rules, so a junction/symlink inside the workspace that points
outside is denied too. This is permission policy, **not** an OS sandbox: an interactively approved shell command is
not path-restricted by OpenCode. The agent still runs on the host; verification can be containerized with
`--executor docker` (below).

### Host execution is authorized, then re-authorized

`--verify "<command>"` is your explicit authorization to run that command on this host. Before each execution Kodevra
hashes the files that decide what it actually runs: package scripts and lockfiles, test-runner/build configuration,
test files, and any path the command names. If the agent changed, added or removed one of them during the run, the
command is **not** executed. Kodevra prints the changed files, exits 1, and asks for an explicit renewal:

```text
  approval required the verification command was not executed
  changed by agent test/extra.test.js
  next             re-run with --reapprove to authorize the current workspace state
```

`--reapprove` renews the authorization on the current workspace and is recorded in the event log. The gate is checked
between bounded repair attempts too, so a repair cannot make a suite pass by editing it.

### Docker executor (isolated verification)

`--executor docker` runs the authorized verification command in an ephemeral Linux container built from a private
snapshot of the workspace:

```bash
kodevra run "fix the bug" --verify "npm test" --executor docker
```

- **Snapshot, not the workspace.** The workspace is copied to `~/.kodevra/sandboxes/...` and only that copy is
  mounted at `/workspace`. `.git`, `integrations/`, `.env*`, `auth.json`, `deepseek-auth.json`, `*.pem`, `*.key`,
  `.npmrc`, `.netrc` and symlinks are never copied. The source workspace is not mounted, read-only or otherwise.
- **Container isolation controls:** `--network none`, `--cap-drop ALL`, `--security-opt no-new-privileges`,
  non-root user `1000:1000`, read-only root filesystem with tmpfs scratch areas, `--pids-limit 256`, `--memory 2g`,
  `--cpus 2`, a wall-clock timeout, and no Docker socket.
- **Cleanup** on success, failure, timeout and cancellation: `--rm` plus an explicit `docker rm -f`, and the snapshot
  directory is deleted.
- **No silent fallback.** If Docker Desktop or its Linux engine is unreachable, the run stops with
  `EXECUTOR_UNAVAILABLE` and setup guidance before any model call; the host executor is never used implicitly.
- **Requirements:** Docker Desktop with the WSL2 backend in Linux-container mode. `node:22-alpine` is pulled once if
  missing (host network at setup time, never inside the container). The report always shows executor, sandbox status,
  exit code, duration and the snapshot path.

`--executor host` still exists, runs code directly on this machine and reports `not sandboxed`; it remains the default.

Containers are not perfect security. Docker, the host kernel and Docker Desktop stay in the trusted computing base,
a secret with an unexpected name inside a project file can still reach the snapshot, and projects that need network
access or pre-installed `node_modules` may fail under this executor.

### Agent terminal: `sandbox_exec`

An agent that cannot run the test suite can only guess. With `--executor docker`, Kodevra gives the model one shell — a
Kodevra-owned OpenCode tool called `sandbox_exec` — and keeps native host `bash` denied:

```bash
kodevra run "fix the failing test" --executor docker --verify "npm test"
```

The model runs `sandbox_exec` with `{ command, timeout_ms }` and gets back the real exit code, stdout, stderr, duration
and timeout state, so it can read a failure, edit the source and run the command again.

- **Loaded through OpenCode's supported mechanism.** The tool is a custom tool file installed at
  `~/.config/opencode/tools/sandbox_exec.js` (never in the workspace, which the agent can write) and marked
  `kodevra-managed-tool`. Kodevra reinstalls it on each docker run and will not overwrite a tool file it does not own.
- **Inert outside a run.** The file refuses to execute unless the current Kodevra process exported
  `KODEVRA_SANDBOX_EXEC=1`; then it imports `lib/sandbox-command.js` from the Kodevra install.
- **Fresh snapshot per command.** Every call re-stages the current workspace through `lib/sandbox.js` and starts a new
  ephemeral container with the same isolation flags as `--verify`, the same resource limits and a per-call timeout
  (default 120 s, max 300 s).
- **Nothing comes back.** The container filesystem is discarded; files it creates are never imported into the
  workspace, so there is no path from generated output back into your source tree.
- **No fallback.** If Docker is unavailable the tool returns `EXECUTOR_UNAVAILABLE` with setup guidance; it never runs
  the command on the host.
- **Same run, same log.** Each call appends `sandbox_started` / `sandbox_finished` to the existing `run_id` event file,
  so agent commands, the verification and the repairs sit in one timeline.

Interactive launches (`kodevra <path>`) are unchanged: no tool is enabled there and the engine's own prompts apply.

### Execution events

Each `kodevra run` writes a JSON Lines file under `~/.kodevra/runs/`; `--events-json` also streams the same lines to
stderr so a terminal UI can consume them without scraping coloured output:

```json
{"run_id":"run_20261025-081817_7aa326","ts":"2026-10-25T08:18:17.004Z","event":"verification_finished","command":"npm test","executor":"host","sandboxed":false,"status":0,"ok":true,"timed_out":false,"duration_ms":940}
```

Events cover `run_started`, `model_started/finished`, `file_changes`, `verification_authorized`,
`verification_reapproved`, `approval_required`, `verification_started/finished`, `verification_skipped`,
`sandbox_started/finished`, `repair_started`, `failure` and `run_finished`. They carry metadata only - no prompts,
file contents or credentials.

## Configuration

Kodevra reads the OpenCode config at `~/.config/opencode/opencode.json` (override with `OPENCODE_CONFIG`):

- provider `freedeepseek` -> `http://127.0.0.1:9655/v1`
- default model `freedeepseek/deepseek-v4-flash`

`kodevra init` is merge-only and backs the config up to `opencode.json.kodevra-backup` before any write:

- adds the `freedeepseek` provider when it is missing (an existing block is left byte-for-byte untouched);
- caps `openrouter/google/gemini-3.6-flash` at **4096 output tokens** using OpenCode's model-level `limit` config,
  keeping its real 1,048,576-token context and its capabilities. OpenRouter reserves `max_tokens` up front, so the
  catalog default of 65,536 can exceed a small balance even for a one-line answer. Nothing else in the config is
  touched, and no credits are ever purchased automatically.

Provider discovery and presets live in `lib/providers.js`; new providers are added by registering them there, never
by editing your working config.

Environment variables: `KODEVRA_MODEL`, `KODEVRA_SKIP_DOCTOR=1`, `OPENCODE_BIN`, `OPENCODE_CONFIG`,
`KODEVRA_STATE`, `KODEVRA_DEEPSEEK_BASE_URL`, `KODEVRA_DEEPSEEK_API_KEY`. Credentials belong in local files only -
never commit `.env`, `auth.json` or session tokens.

## Providers

`kodevra providers` lists what this machine can actually run. Readiness comes from the engine's own model catalog and
credential store, so nothing is advertised that is not configured:

```
provider               state        credential              default model
freedeepseek           ready        local proxy             deepseek-v4-flash
deepseek               ready        opencode auth           deepseek-v4-flash
openrouter             ready        env OPENROUTER_API_KEY  openai/gpt-5
gemini-web             unsupported  none                    -
google-api             needs auth   none                    gemini-2.5-pro
openai                 needs auth   none                    gpt-5
```

Kodevra keeps **official API access** and **experimental web access** strictly separate: `google-api` is the
supported Gemini path, `gemini-web` is registered but explicitly unsupported (see below).

- **DeepSeek through FreeDeepseekAPI is the default** and the only provider proven with the full coding loop.
- Pick a provider for one run: `kodevra run -p <provider> "<task>"`.
- Make it the default: `kodevra providers use <provider>` (or `<provider>/<model>`). Selection is stored in
  `~/.kodevra/state.json`; **OpenCode's config is never rewritten**. `kodevra providers use freedeepseek` restores
  the shipping default, and `kodevra providers current` shows the active model and where it came from.
- Credentials come from the environment (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, ...) or from
  OpenCode's own credential store via `opencode auth login`. Kodevra never asks for account passwords or browser
  cookies, and never prints a key: it reports only that credentials exist.
- A provider without credentials fails at `kodevra doctor` with the exact command or variable to set, and the agent is
  not launched.

## Authentication

Kodevra delegates every sign-in to OpenCode's own authentication flow. It never runs an OAuth exchange, never
asks for a password or cookie, and never stores a key itself - it only checks that a credential *exists* afterwards
and refreshes provider readiness.

```bash
kodevra auth status                    # provider, auth state, model, missing-credential guidance
kodevra auth login openai              # ChatGPT Plus/Pro sign-in on the official OpenAI page
kodevra auth login openai --headless   # same flow, paste the code manually
kodevra auth login google-api          # AI Studio key, pasted into OpenCode's prompt
kodevra auth login deepseek            # direct DeepSeek platform key
```

- **ChatGPT** uses OpenCode's supported OAuth (`ChatGPT Pro/Plus (browser)`), which redirects to
  `auth.openai.com` and returns to a local callback. If the installed OpenCode cannot do this, Kodevra says so
  instead of building an unofficial workaround.
- **Gemini** has two names, and only one works. `google-api` uses a Google AI Studio key
  (`https://aistudio.google.com/apikey`) entered through OpenCode's prompt.
- Signing in never changes the default provider. Opt in with `kodevra providers use openai` afterwards.

### Why `gemini-web` is unsupported

A Gemini consumer web session has no authorized API surface. Every web-to-API adapter surveyed
(`qutek/gemini-web-api`, `n0madic/go-gemini-web2api`, `@orcushq/gemini`) authenticates by replaying Google
**session cookies** - `__Secure-1PSID` / `__Secure-1PSIDTS`, or cookies scraped from a local Chrome profile -
against `gemini.google.com`. That is automated access outside Google's terms, it hands over account-level
credentials rather than a scoped key, and it breaks whenever Google rotates the flow.

Kodevra therefore does not ship that bridge: `kodevra auth login gemini-web` reports **BLOCKED** with the reason,
and `kodevra run -p gemini-web` refuses to start. There is no one-click OAuth to claim. Supported paths to Gemini
models are `kodevra auth login google-api`, or a Gemini model through the already-credentialed `openrouter`
provider (`-m openrouter/google/gemini-3.6-flash`, capped at 4096 output tokens by `kodevra init`).

## Developer experience

The launch panel is the product's identity: brand and version, workspace, model, provider, authentication
readiness, sandbox availability, mode and the commands worth knowing. It is terminal-safe on Windows PowerShell
(no cursor tricks, no animation) and falls back to plain text when colour is unavailable.

During a run, Kodevra prints the engine's own stream plus one line per sandbox command it observes in the run's
event file — `sandbox npm test -> exit 1 (5.9s)` — so progress is visible without a second orchestrator. The run
finishes with `TASK COMPLETE`, a real file count, sandbox command count, verification result with exit code,
repair attempts, duration, executor and sandbox status, the changed files and a single status word.

Interactive launches keep OpenCode's terminal interface. Kodevra owns the launcher, banner, setup screen,
diagnostics and summaries; it does not fork the engine's TUI for branding because that would mean patching
upstream. OpenCode's own themes and configuration remain available inside the interactive session.

## Benchmarks

`benchmarks/` is a reproducible comparison harness: 20 Node.js tasks across bug fixing, multi-file changes, API
implementation, validation, refactoring, error handling, test repair, backend logic, async work, dependency-aware
changes, parsing, dates, sorting, strings, state machines, caching, pagination, security and CLI parsing.

```bash
node benchmarks/runner.js --validate   # manifests, templates, hidden tests, solutions
node benchmarks/runner.js --check      # broken template -> failing hidden test -> solution passes
node benchmarks/runner.js --task 01-cart-total --variant both
node benchmarks/runner.js --summary
```

Every task ships a broken template, a hidden acceptance test that is copied in only after the agent finishes,
and a reference solution used to prove the fixture is solvable. All 20 fixtures pass `--check` (20/20). The live
pilot is blocked by the local proxy account entering cooldown; `benchmarks/results/summary.md` records the two
attempted runs as infrastructure failures rather than as a model comparison, and the reasons are documented in
`benchmarks/README.md`. Do not read it as evidence that either agent is better.

## Layout

| Path | Purpose |
| --- | --- |
| `bin/kodevra.js` | CLI: launch, `run` (+`--verify`, `--mode`, resume), `sessions`, `doctor`, `init`, pass-through |
| `lib/config.js` | OpenCode config reader, DeepSeek preset, merge-only provider and model-limit writes |
| `lib/providers.js` | provider catalog discovery, readiness, credential diagnostics, selection state |
| `lib/auth.js` | delegates sign-in to OpenCode and verifies credential presence only |
| `lib/doctor.js` | startup diagnostics (node, engine, config, provider, model, auth, proxy, workspace) |
| `lib/engine.js` | streams the engine, captures its tail, runs the verification command |
| `lib/verify.js` | workspace-scoped git + metadata evidence, failure signatures, repair prompt, completion summary |
| `lib/progress.js` | tails the run's JSONL events to print live sandbox command progress |
| `lib/onboarding.js` | guided `kodevra init`: detection, provider choice, consent, safe defaults |
| `lib/failures.js` | failure taxonomy (`PROXY_UNAVAILABLE`, `AUTH_EXPIRED`, `TOOL_DENIED`, ...) |
| `lib/permissions.js` | workspace-scoped permission overlay for automated runs |
| `lib/authorization.js` | verification authorization fingerprint, drift detection and renewal |
| `lib/executors.js` | executor registry: `host` (not sandboxed) and `docker` (isolated) |
| `lib/docker-executor.js` | Docker availability probe, isolation flags, container lifecycle |
| `lib/sandbox.js` | workspace snapshot staging with credential exclusions and limits |
| `lib/sandbox-command.js` | one model-requested command through the Docker executor, formatted for the agent |
| `lib/sandbox-tool.js` | installs and guards the trusted OpenCode tool file |
| `tools/sandbox_exec.js` | the `sandbox_exec` custom tool OpenCode loads (`~/.config/opencode/tools/`) |
| `lib/events.js` | JSONL execution events for a future branded terminal interface |
| `lib/brand.js` | wordmark, tagline, colour |
| `benchmarks/` | 20-task comparison harness, fixtures, runner and recorded results |
| `test/` | Node built-in tests: taxonomy, verification, sandboxing, branding, progress, onboarding |
| `docs/IMPLEMENTATION_STATUS.md` | FRD coverage by requirement ID |
| `AGENTS.md` | engineering instructions picked up by OpenCode's `AGENTS.md` mechanism |
| `examples/agent-smoke` | disposable project with one failing test, used to prove the agent works |

## Smoke test

`examples/agent-smoke` is the disposable harness used to prove that the agent really reads, edits and tests files.
It ships with a `slugify` implementation whose single test fails; the agent fixes it end to end:

```bash
npm run smoke                           # run --verify "npm test" against the fixture
cd examples/agent-smoke && npm test     # 1 pass, 0 fail
```

Kodevra's own units run with the same built-in test runner: `npm test`.

To re-arm the demo, break the implementation again (for example drop `.toLowerCase()` from
`examples/agent-smoke/src/slugify.js`) so its test fails before the next agent run.

## Attribution

Kodevra builds on other people's work and keeps their licenses and attribution intact. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
