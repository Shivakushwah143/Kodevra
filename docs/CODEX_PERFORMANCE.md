# Why `kodevra --engine codex` took 306 s where plain `codex exec` took 128 s

Measured on the same machine, same task, same starting repository, same model
(`openai/gpt-5.6-terra`), same Codex build (0.149.1), same sandbox
(`workspace-write`, `[windows] sandbox = "elevated"`). No estimate in this
document: every number comes from a clock reading in a Codex rollout, from the
Kodevra run record, or from a command re-run here.

## 1. Verdict

**Kodevra's own overhead is about 3-5 seconds, not 178.** It is measurable and
bounded (two instrumented runs): CLI bootstrap 0.0 s, engine probe 0.4-1.1 s,
workspace snapshot 0.6-1.5 s, verification 1.4-2.9 s, change collection and
outcome 0.1 s.

**The 178 s is 12 extra model turns.** Codex's round trip in this setup costs
12-13 s per turn, almost independent of what the turn does:

| run | wall clock | model turns | tool calls | failed | wall / turn |
| --- | --- | --- | --- | --- | --- |
| `kodevra run --engine codex` (306.1 s reported) | 295.9 s in rollout | 22 | 25 (20 shell, 5 plan) | 9 | 13.4 s |
| plain `codex exec`, shell only | 214.9 s | 17 | 18 (14 shell, 4 plan) | 7 | 12.6 s |
| plain `codex exec`, with `node_repl` | 123.4 s (127.8 s reported) | 10 | 12 (2 shell, 7 js, 3 plan) | 2 | 12.3 s |

Time is `turns x ~13 s + startup`. Kodevra's contribution to the first run is
3-5 s of that 296 s (~1.5 %); the rest is Codex's own loop, spent mostly on
recovering from an environment that refuses to work the way a fresh agent
expects it to.

That also means the 90 s target is a *turn budget*, not a millisecond budget:
**<= 7 model turns**, including planning and the final report. The fastest run
measured here used 10. Nothing in Kodevra can make a turn cheaper; the only
lever is removing turns that exist solely because the environment surprised the
model.

## 2. Evidence recovered

Codex keeps full rollouts, so the three runs could be re-analysed after the
fact instead of re-run (the ChatGPT account is out of quota until 24 Nov):

```
~/.codex/sessions/2026/10/26/rollout-2026-10-26T10-48-20-01a176a5-...jsonl   295.9 s  kodevra
~/.codex/sessions/2026/10/26/rollout-2026-10-26T11-04-28-01a176b3-...jsonl   214.9 s  plain, shell only
~/.codex/sessions/2026/10/26/rollout-2026-10-26T11-08-31-01a176b7-...jsonl   123.4 s  plain, node_repl
```

The middle run was not in the earlier report. It matters: **plain Codex, with no
Kodevra involved at all, took 214.9 s on the same task** and produced 7 of the
same failed commands. The 127.8 s baseline and the 306.1 s result are two samples
of one distribution, not two harnesses.

## 3. Normalised commands

Both variants run from an identical disposable copy of the fixture at the same
short-form `%TEMP%` path, each its own git root, with the same task string, same
model id, same sandbox and approval policy, same hidden acceptance test applied
afterwards.

```bash
# A - plain Codex
codex exec --sandbox workspace-write -C <ws> --skip-git-repo-check \
  --json --color never -m gpt-5.6-terra "<task>"

# B - Kodevra (identical flags, plus the verification gate and the facts block)
node bin/kodevra.js run --engine codex -w <ws> --verify "npm test" \
  --executor host -m openai/gpt-5.6-terra --no-doctor --outcome <file> "<task>"
```

Differences that could **not** be eliminated, stated plainly:

1. Kodevra runs `npm test` itself after the agent (the gate) and again in
   pre-flight for the facts block; plain Codex runs it only if the model chooses
   to. Measured cost: 0.9 s for the gate on this fixture, 2.0-2.7 s for the
   pre-flight (`node` start-up dominates).
2. Kodevra writes an outcome file and collects changes: 0.1 s.
3. Kodevra passes the environment through untouched for Codex
   (`scope.env = { ...process.env }`, no `KODEVRA_*` additions); OpenCode-only
   overlay code never runs for Codex. The MCP servers, config and credentials
   Codex uses are the same objects in both variants.
4. Tool surface varied between runs: `mcp__node_repl` (a browser/computer-use
   runtime configured in `~/.codex/config.toml`) was used in the 123 s run, and
   by neither Kodevra's run nor the 214.9 s plain run. JSONL does not record the
   offered tool list, so whether it was unavailable or merely unused cannot be
   proven from the trace. Kodevra neither adds nor removes it; `[features]
   js_repl = false` is the user's own setting and was the same in all three runs.

## 4. The exact 20-command sequence, classified

From the 306 s run. `t` is seconds after the run started; the "why" column names
the cause, not the symptom.

| # | t | exit | command (abbreviated) | class | why |
| --- | --- | --- | --- | --- | --- |
| 1 | 20.6 | 1 | `Get-ChildItem -Force; rg --files; git status; Get-Content src/invoice.js` | ENVIRONMENT | `Access to the path '<ws>' is denied` - the sandbox refuses the shell's own working directory |
| 2 | 30.8 | 1 | `Get-Location; [Environment]::CurrentDirectory; Get-ChildItem <parent>` | ENVIRONMENT | same denial |
| 3 | 38.3 | 0 | `Get-Location; Get-ChildItem '<parent>'` | diagnostic | proves the shell starts in `C:\`, not in the workspace |
| 4 | 46.6 | 0 | `$repo=<abs>; Get-ChildItem; icacls; Get-Content src/invoice.js` | USEFUL | first successful read, via absolute paths |
| 5 | 57.6 | 0 | `Get-Content test/invoice.test.js; git status` | USEFUL | expectations from the tests |
| 6 | 74.3 | 1 | `Set-Location; apply_patch @' ... '@` | MODEL | PowerShell here-string is not what the `apply_patch` helper parses |
| 7 | 93.4 | 0 | write patch file, then `apply_patch` | ENVIRONMENT | "The system cannot find the path specified" - relative path resolves against `C:\` |
| 8 | 102.8 | 0 | `Get-Content src/invoice.js` | REDUNDANT | re-read of a file already read at t=46.6 |
| 9 | 114.8 | 1 | `apply_patch` from stdin | MODEL | `--codex-run-as-apply-patch requires a UTF-8 PATCH argument` |
| 10 | 137.9 | 1 | `$patch = @' ... '@; apply_patch $patch` | MODEL | `Invalid patch: The last line of the patch must be '*** End Patch'` |
| 11 | 151.0 | 1 | `$patch = @(...); apply_patch $patch` | MODEL | same |
| 12 | 158.6 | 0 | `Get-Command apply_patch` | diagnostic | finds the generated `.bat` shim |
| 13 | 177.8 | 0 | `Get-Content <shim>.bat` | diagnostic | reads the shim to learn how it forwards arguments |
| 14 | 192.8 | 1 | quoted-argument patch attempt | MODEL | same "last line" error |
| 15 | 214.2 | 1 | base64 / direct-exe patch attempt | ENVIRONMENT | `Failed to read file to update C:\src\invoice.js` - the cwd is `C:\` |
| 16 | 228.6 | 0 | patch passed as a single argument | USEFUL | **first edit** |
| 17 | 242.1 | 1 | `npm --prefix <ws> test` | ENVIRONMENT | `npm.ps1 cannot be loaded because running scripts is disabled` |
| 18 | 249.5 | 0 | `npm.cmd --prefix <ws> test` | VERIFICATION | 3 tests pass |
| 19 | 264.0 | 0 | `git -c safe.directory=... diff --check; git diff` | ENVIRONMENT | `warning: Not a git repository` - relative paths again |
| 20 | 281.8 | 0 | git with `GIT_CONFIG_*` env vars | VERIFICATION | final diff check |

Totals: **9 non-zero exits** (#1, 2, 6, 9, 10, 11, 14, 15, 17), plus two exit-0
commands whose output reported failure (#7, #19). By cause: **5 model attempts to
drive `apply_patch` through PowerShell**, **4 environment denials** (cwd, path,
npm shim, git), 2 diagnostics, 4 useful reads/edits, 2 verification runs, 1
redundant re-read.

Time to first read: 46.6 s. Time to first edit: **228.6 s** - 77 % of the run.

The 214.9 s plain run is the same shape: denial at 34.7 s, `cmd.exe` detour,
patch failures at 93.7/112.9/125.5/136.3 s, first edit at 147.7 s, `npm.ps1`
refusal at 162.5 s, verification at 176.6 s, done at 214.7 s. Kodevra's run took
two more patch attempts and one more confirmation round.

## 5. Sandbox and Windows: what is actually broken

`codex exec` under `[windows] sandbox = "elevated"` launches PowerShell with the
workspace as its working directory and the restricted token denies
`Set-Location` into it. PowerShell then continues in `C:\`, so:

- `Get-ChildItem` with no argument fails against the workspace path;
- `npm test`, `git status` and the `apply_patch` helper all resolve relative
  paths against `C:\`, which is why the patch tool reports `C:\src\invoice.js`;
- absolute paths work, which is how every successful command in all three runs
  did its work.

This is a Codex-on-Windows issue, not a Kodevra one: the 214.9 s run had no
Kodevra involvement and the identical first failure. Kodevra cannot fix it
without weakening the sandbox, and it will not rewrite Codex's configuration.
What it *can* do is stop the model from spending five turns discovering it.

## 6. Verification overhead

Measured, not assumed:

- Kodevra's gate: 0.9 s (`npm test` on this fixture, host executor) in the 306 s
  record, 1.4-2.9 s in re-runs here.
- The runner then runs the same suite once more for the hidden acceptance test.
  That duplicate is part of the *benchmark's* judgement, not of Kodevra's run.
- The pre-flight added in this change runs the same command once more before the
  agent starts (2.0-2.7 s on this fixture, `node` start-up included). It is only
  used to fill the facts block and is skipped for sandboxed executors.

Verification correctness is unchanged: `--verify` still decides PASS/FAIL, still
runs after the agent, and the pre-flight result is never reported as the verdict.

## 7. What Kodevra now does about it (and what it deliberately does not)

Codex keeps its own loop, system prompt, tools, sandbox and credentials. Kodevra
adds one thing before the first turn and one thing that observes the run:

1. **Pre-flight + a one-line facts block** (`lib/packet.js`). Kodevra runs the
   `--verify` command once before starting Codex and prepends a
   `<kodevra_context>` block containing the workspace root, the file list, the
   *real* failing output (head and tail, with the omitted line count), the files
   that output mentions, and - on Windows only - the three environment
   constraints above. The task text is passed through byte-for-byte after it.
   The block is a single line on purpose: on Windows the CLI is reached through
   a `.cmd` shim, and a newline in the prompt truncates the command line. That
   bug was found and fixed here; multi-line prompts through a `.cmd` shim lose
   everything after the first newline.
2. **Phase timings** (`lib/timings.js`, `streamEngine({ onLine })`). Bootstrap,
   engine probe, pre-flight, workspace scan, spawn, first JSON event, first tool
   call, first edit, agent, verification, change collection, outcome and total,
   all from clock readings. Printed for `--engine codex` runs and stored in
   `outcome.timing.phases_ms`.
3. **`--no-context`** to run the previous, context-free baseline for an A/B.

Not done, on purpose: no second agent loop, no subagents, no Codex patching, no
prompt rewrites of the task, no change to the verification gate, no OpenCode
changes.

## 7.1 The service tier (`--speed fast`)

Codex advertises a `priority` tier ("Fast - 1.5x speed, increased usage") for
`gpt-5.6-terra` in the catalog compiled into 0.149.1. There is no CLI flag for
it; the supported switch is the `service_tier` config value, so Kodevra passes
`-c service_tier="priority"` in the child argv for `--speed fast` only.

The tier was inert on this machine for a second reason: `model_catalog_json`
replaces Codex's bundled catalog, so terra had no metadata and Codex dropped the
tier with an explicit warning. Kodevra now merges `codex debug models --bundled`
(the installed version's own catalog) with the effective catalog into a
throwaway `0600` file passed to that invocation only, and removes it afterwards.
`config.toml`, `auth.json` and the custom DeepSeek catalog are never modified.

Measured on the plain CLI before the plumbing existed (same fixture, same flags,
only the tier differing):

| tier | runs | verified | wall clock |
| --- | --- | --- | --- |
| standard | 3 (one from the earlier report) | 3/3 | 127.8, 131.9, 103.7 s |
| priority | 3 | 3/3 | 55.6, 43.4, 69.5 s |

The 127.8 s reference ran on Codex's fallback metadata (no catalog override);
the other standard runs and all priority runs used the catalog that advertises
the tier. That is the one difference that cannot be removed, because the tier
does not exist until the catalog provides it.

Through `kodevra run --engine codex --speed fast` the plumbing is verified (the
real CLI accepted the tier and the merged 12-model catalog: `outcome.speed` =
`{"requested":"fast","effective_service_tier":"priority","model_supports_priority":true,"catalog_source":"bundled+user"}`),
but the agent run itself returned `RATE_LIMITED`: the account is out of quota
until 25 Nov 2026. **No Kodevra timing claim is made.**

## 8. The <= 90 s target: not claimed

With the measured constants, `<= 90 s` needs `<= 7` model turns at ~13 s plus
~7 s of start-up and verification. The fastest observed run used 10 turns with a
working Node tool surface, and 12 with the shell alone.

Removing every environment failure would plausibly take the 306 s run to
~165-190 s (10-12 turns: plan, read the files named in the evidence, edit, run
the suite, report), and to ~120-150 s with a working edit path on the first
attempt. That is inference from the trace, not a measurement. **No run of this
change has been made against `gpt-5.6-terra`: the ChatGPT account hit its usage
limit and every further attempt returns `RATE_LIMITED`, and the local
FreeDeepseekAPI proxy is not running on this machine.** Consequently:

- no pass rate, no before/after wall clock and no `<= 90 s` claim is made here;
- what *is* verified is the wiring, end to end, with a stand-in Codex CLI, plus
  the unit tests for the packet and the timings.

Getting to <= 90 s would additionally require the shell to work on its first
call in Codex's Windows sandbox (one read instead of five), i.e. an upstream or
configuration fix, not a Kodevra one.

## 9. Reproducing the A/B when quota is back

```bash
export KODEVRA_CODEX_BIN="<runnable codex>"
# baseline (previous behaviour)
node benchmarks/codex/runner.js --task 01-bugfix-invoice-tax --variant kodevra \
  --no-context --model openai/gpt-5.6-terra --force
# with the facts block
node benchmarks/codex/runner.js --task 01-bugfix-invoice-tax --variant kodevra \
  --model openai/gpt-5.6-terra --force
```

Each run records `workspace_context: true|false` so the pair stays identifiable,
and the printed `timings` line plus `outcome.timing.phases_ms` give the phase
table directly. Read `commands`, `failed_commands` and `first_edit` from the
outcome rather than from the wall clock; those are what the turn budget depends
on.

## 10. Verification performed for this change

- `npm test` - **125 tests, 125 pass, 0 fail**.
- `node benchmarks/codex/runner.js --check` - **5/5 fixtures sound**.
- End-to-end with a stand-in Codex CLI (no model), same fixture and task:
  `preflight npm test -> exit 1 (2.0s)`, 1 file changed, `npm test` exit 0,
  **VERIFIED**, and the prompt captured by the stand-in was the full 2,069-byte
  single-line block (zero newlines) with the real failing output, the mentioned
  test file and the shell notes. Phase marks from that run: bootstrap 0.0 s,
  engine probe 1.1 s, pre-flight 3.5 s, workspace scan 1.5 s, spawn 3.5 s, first
  event 4.0 s, first tool 4.2 s, first edit 4.6 s, agent 4.9 s, verification
  7.8 s, changes 8.0 s, total 8.0 s.
- That stand-in run is a harness test, not a performance measurement: it does no
  reasoning and its timings say nothing about model latency.

## 11. Diagnostics follow the invocation; wrapper overhead (second pass)

### A. Why `doctor --engine codex -m openai/gpt-5.6-terra` probed freedeepseek

Two different resolutions were in play. The adapter resolves the target the run
will actually use (`resolveCodexRun`: explicit `-m` wins, otherwise Codex's
`config.toml` decides) and builds `codex exec` from it. Diagnostics resolved the
provider separately, straight from `~/.codex/config.toml`, and probed the
`baseURL` of *that* provider. With `provider = "freedeepseek"` in the global
config, every Codex diagnostic - including an explicit OpenAI run - asked
`http://127.0.0.1:9655/v1/models` for a model it was not about to use, and failed
when the proxy was down.

Fix: one source of truth. `runDiagnostics` now receives the same `codexTarget`
the exec arguments are built from, reports `model/provider` from it, and probes a
proxy only when that effective provider has a known local `baseURL`. OpenAI has
none, so no probe; `-m freedeepseek/deepseek-v4-flash` still probes. The auth
check is keyed the same way: a custom-provider `codexAuth` success no longer
passes an explicit OpenAI run that has no ChatGPT credential.

### B. Why Docker was "unavailable" for a native Codex run

The Codex branch treated Docker as *the* sandbox. It ran `docker info` on every
Codex diagnostic and marked the result fatal, even though Docker is only the
`--executor docker` verification container. Codex's own Windows sandbox
(`[windows] sandbox = "elevated"`) is the boundary for host execution and does
not need Docker at all.

Fix: diagnostics take the executor this invocation will really use (`--executor`,
`KODEVRA_EXECUTOR`, or the implicit Docker choice `--verify` makes) and probe
Docker only for `docker`. On `host` the Docker line is not printed at all, and
the `codex sandbox` line stays advisory (`fatal: false`) because it describes
Codex's config, not a Kodevra precondition. OpenCode diagnostics are unchanged:
Docker stays optional there and the proxy check still runs.

### C. What changed

- `lib/doctor.js` - `purpose: "run" | "doctor"`, `codexTarget`, `codexStatus`,
  `executor` and an `engine` test seam; effective-provider proxy/auth routing;
  Docker only for the selected executor. `purpose: "run"` keeps engine, auth,
  model/provider, proxy and Docker-if-docker, and drops the informational
  node/config/workspace/catalog lines.
- `bin/kodevra.js` - pass the already-resolved `harnessInfo`/`codexTarget` into
  diagnostics instead of letting it re-run `codex --version` and
  `codex login status`; thread the real executor; mark `diagnostics` in the
  phase timings. The post-agent `git status`/`git diff` view is computed once and
  reused by the outcome (it was asked twice per run); after a repair run, which
  lets the model edit again, it is recomputed so the recorded changes stay exact.
- `lib/codex-catalog.js` - `bundledCatalog()` caches `codex debug models
  --bundled` by binary identity (path, size, mtime, reported version) under
  `~/.kodevra/cache/`, model metadata only; the merged temp catalog is written
  compact instead of pretty-printed (322 kB instead of ~700 kB per fast run).
- `lib/providers.js` - the opencode catalog (~6 MB) is parsed once per process
  and reused while size/mtime are unchanged; a Codex run no longer asks for it
  at all, and no longer runs `opencode models openai` (3.5-4.3 s here) for a
  banner label.
- `lib/docker-executor.js` - `probeDocker()` memoised per process; the startup
  panel probes Docker only when Docker is the executor (or `--verify` is about to
  choose one), so a host/native run never pays the 200-430 ms failed probe.
- `lib/codex.js` - `resolveCodexRun` exported as the single resolution entry
  point; `readCodexConfig` also reports `model_catalog_json`/`profile` presence.
- `lib/engine.js` - quote the command when `KODEVRA_CODEX_BIN` is a `.cmd` path
  containing spaces (it was previously split by the shell).
- `lib/doctor.js` - allow a custom `engine` object (test seam) so the unchanged
  OpenCode branch can be asserted without an OpenCode install.
- `benchmarks/codex/wrapper-overhead.mjs` - self-contained harness: it writes a
  stub `codex` that answers `--version`, `login status` and `debug models` and
  emits minimal valid exec JSONL, then measures 11 runs in each mode.

Not changed: `~/.codex/config.toml`, `auth.json`, the custom DeepSeek catalog,
the verification gate, `--speed fast` planning, OpenCode's own diagnostics.

### D/E. Wrapper overhead, before and after

Same machine, same stub, same fixture; `total` is Kodevra's own end-of-run
timings line, `wall` is the parent process. The "before" numbers were taken with
a loopback stub of the FreeDeepseekAPI proxy, because the old diagnostics aborted
the run otherwise.

| | before median | before p95 | after median | after p95 |
| --- | --- | --- | --- | --- |
| default total | 1800 ms | 2300 ms | 700 ms | 900 ms |
| default wall | 1913 ms | 2577 ms | 856 ms | 1166 ms |
| fast total | 2000 ms | 2800 ms | 900 ms | 1400 ms |
| fast wall | 2176 ms | 3010 ms | 1085 ms | 1581 ms |

A second run of the same after code gave 1023/1440 ms and 1015/1385 ms
(default/fast wall median/p95), so treat ~0.85-1.1 s as the range.

The committed harness, run unmodified against both revisions, reproduces the
same conclusion with larger absolutes (this shell has a working `opencode` on
PATH, so the old wrapper paid `opencode models openai` on every run):

| harness | default wall median / p95 | fast wall median / p95 |
| --- | --- | --- |
| `dd98384` + `--no-doctor` (see note) | 4535 / 4755 ms | 5393 / 6661 ms |
| this revision, unmodified | 718-1103 / 813-1652 ms | 861-1277 / 1041-1667 ms |

Note: at `dd98384` the harness cannot complete a single run on this machine.
`Diagnostics failed` because `codex provider` probed the (stopped) freedeepseek
proxy for an OpenAI run and `sandbox` reported the missing Docker engine, so the
before row adds `--no-doctor`; the after row is the script exactly as committed.
Phase medians at `dd98384`, warm, default / fast: engine probe 300/300,
**assessment 3500/4000**, workspace scan 4100/4900, spawn 4100/4900, changes
4400/5300, total 4400/5300 ms.

Phase medians (warm, default / fast):

| phase | before | after |
| --- | --- | --- |
| engine probe | 400 / 400 ms | 300 / 300 ms |
| provider assessment | 500 / 500 ms | 300 / 300 ms |
| speed plan + catalog | - / 800 ms | - / 500 ms |
| workspace scan | 1300 / 1500 ms | 400 / 600 ms |
| spawn preparation | 1400 / 1500 ms | 400 / 600 ms |
| agent (stub) | 1500 / 1700 ms | 600 / 800 ms |
| changes + outcome | 1800 / 2000 ms | 700 / 900 ms |

Most of the win is the dropped duplicate Codex probe/auth/config work and the
workspace scan no longer running twice; the catalog cache removes ~250 ms from
`--speed fast`, which now skips the bundled-catalog lookup entirely unless a tier
is being applied.

Caveat: the stub is ~70 ms of Node start, not the real CLI. The real
`codex --version` / `codex login status` / `codex debug models --bundled` cost was
measured earlier at 0.4-1.1 s of the old 3-5 s wrapper, so a real-binary wrapper
after this change should land near 1.2-1.7 s, still under the 3 s target.

### F. Cold / warm / p95 (after, 11 runs each, committed harness)

Final run on a quiet machine, milliseconds:

| mode | cold wall | warm wall median | warm wall p95 | warm total median | warm total p95 |
| --- | --- | --- | --- | --- | --- |
| default | 728 | 718 | 813 | 600 | 700 |
| fast | 1000 | 861 | 1041 | 700 | 800 |

Across repeated runs of the same script the after medians landed between 696 and
1103 ms (default) and 854 and 1277 ms (fast), with p95 up to 1652 / 1667 ms (a
repeat of the final run: 696 / 839 and 854 / 1005 ms). The
default "cold" run is the first invocation after a fresh `git init` in the
fixture (index and status are cold); the fast cold run also writes the bundled
catalog cache once, which is the 1000 vs 728 ms difference.

Warm ≤ 3 s: met with a wide margin. Stretch ≤ 1.5 s: met on every median; p95
meets it on the quiet runs and sits above it (1.65 s) when the machine is busy.

### G. Tests

`npm test` - **156 tests, 156 pass, 0 fail**. New coverage:
`test/codex-diagnostics.test.js` asserts explicit OpenAI never calls the proxy
probe, explicit DeepSeek does, the configured default is still probed without an
override, native Codex never probes Docker while `--executor docker` does and a
failing Docker probe blocks only that run, a custom-provider credential does not
pass an explicit OpenAI run, run mode keeps only launch-critical checks, and the
OpenCode branch still emits its optional Docker line plus its proxy check.
Existing Codex and `--speed fast` tests are unchanged and pass.

Live check with a real Codex CLI (`KODEVRA_CODEX_BIN` pointed at
`codex-cli 0.164.0-alpha.11.1`; the npm shim on this machine is broken and the
0.149.1 binary was not on PATH in this shell):

```
$ kodevra doctor --engine codex -m openai/gpt-5.6-terra
  PASS  node            v24.13.1
  PASS  engine          codex 0.164.0-alpha.11.1 . KODEVRA_CODEX_BIN
  PASS  auth            ChatGPT sign-in
  PASS  model/provider  OpenAI / gpt-5.6-terra
  PASS  codex config    ~/.codex/config.toml . freedeepseek/deepseek-v4-flash
  PASS  codex sandbox   [windows] sandbox = elevated
  PASS  workspace       ...
All checks passed.

$ kodevra doctor --engine codex -m freedeepseek/deepseek-v4-flash
  FAIL  proxy           http://127.0.0.1:9655/v1/models unreachable (fetch failed)
  (everything else PASS)

$ kodevra doctor --engine codex -m openai/gpt-5.6-terra --executor docker
  FAIL  docker          Docker engine is not reachable (...)
```

No `docker` line appears for the host executor, and the proxy line appears only
for the provider that has a local endpoint. `kodevra run --engine codex` on the
same target prints four preflight checks (engine, auth, model/provider, codex
sandbox), no proxy and no Docker, with `diagnostics` costing 0 ms because the
probe was already paid for: `engine probe 0.5s . diagnostics 0.5s . workspace
scan 0.7s . spawn 0.7s . total 1.1s` on the stub.

### H. Projected Kodevra + Terra Fast runtime, from measured numbers only

Wrapper: 0.7-0.9 s (stub), 1.2-1.7 s with the real binary's probes. Per model
turn, measured on this machine: 12.34 s (123.4 s / 10 turns) and 13.45 s
(295.9 s / 22 turns). So

`runtime ≈ 0.9-1.7 s + turns × 12.3-13.4 s`

- 5 turns: ~63-69 s
- 6 turns: ~75-82 s
- 7 turns: ~87-96 s

The target therefore still needs ≤ 6 turns, or ≤ 7 on the fast per-turn figure.
The wrapper change buys ~1.0 s, which is invisible next to turn count. **No ≤ 90 s
claim is made**: the ChatGPT quota is still exhausted (`RATE_LIMITED` until
25 Nov 2026), so no live `kodevra run --engine codex --speed fast` on
`gpt-5.6-terra` was possible.

## 12. Turn budget: what the packet now carries (measured build cost only)

Section 1 established that the 90 s target is a turn budget: <= 7 model turns at
~12-13 s. The 306 s run used 22, and 8 of its 20 commands existed only because
the environment surprised the model (5 failed `apply_patch` attempts through
PowerShell, plus the cwd, npm and git denials). The facts block already described
the symptoms; this pass makes it describe the working recipes, and adds the reads
the model would otherwise spend turns on.

### What changed

1. **Concrete Windows recipes** (`lib/packet.js` `shellFacts`). Instead of "retry
   with absolute paths" and "pass the patch as a single argument", the block now
   says the shell starts in `C:\`, and names the exact forms that worked in the
   trace: `Get-Content "<ws>\src\file.js"`, `npm.cmd --prefix "<ws>" test`,
   `git -C "<ws>" status` / `git -c safe.directory="<ws>"`, and
   `apply_patch "*** Begin Patch ... *** End Patch"` as ONE quoted argument, not
   a here-string or piped stdin (both of which produced the run's
   `requires a UTF-8 PATCH argument` / `last line ... *** End Patch` failures).
2. **Bounded excerpts of the files the failure names** (`fileExcerpt`,
   `importedFiles`). The pre-flight output names the failing test; the test
   imports its subject; both are the files the model read at t=46.6 s and 57.6 s
   in the trace. The packet now carries up to 2 excerpts (40 lines, 160 chars a
   line, 64 KB per file), read-only and resolved inside the workspace. The bytes
   are the file's own and are not rewritten, because the model could read the
   same file with a tool; the bounds are the only limit.
3. **Turn evidence in the outcome** (`lib/codex.js`, `lib/outcome.js`).
   `parseCodexEvents` counts `turns` from Codex's `turn.completed` /
   `turn.failed` events, and the outcome keeps `at_ms` on every command and file
   change plus `first_command_at_ms` / `first_change_at_ms`. The next live run can
   be read against a turn budget directly instead of inferring it from the wall
   clock.

The task text is still passed through byte-for-byte, the block is still one line,
and Codex's system prompt, tools, sandbox, config and loop are untouched.

### Measured

- Packet build for the `01-bugfix-invoice-tax` fixture: **0.73 ms**, 2.9 KB,
  with both excerpts (test + imported source). 50 builds averaged, same process.
- Wrapper overhead unchanged by this pass: default warm wall **874 ms**
  (p95 1383), fast **1032 ms** (p95 1350), 11 runs each; the packet is built
  inside the run phase already counted there, and three workspace files cost
  less than a millisecond.
- `npm test`: **160 tests, 160 pass, 0 fail** (new: packet excerpts and their
  bounds, traversal refusal, import resolution, turn counting, outcome marks).

### What is *not* measured

The ChatGPT account is still out of quota and `codex exec` returns
`Reconnecting... waiting for network`, so **no live turn count exists for this
change**. The plausible saving is arithmetic, not evidence: removing the five
failed patch attempts (~65 s) and the two read turns the excerpts replace
(~27 s) would take the 306 s run to roughly **215 s** - real, but still 12+
turns and far from 90 s. Reaching <= 7 turns needs the model to plan, edit once
and verify, which this packet makes possible but cannot prove. Run
`node benchmarks/codex/runner.js --all` when quota returns; each record now
carries `evidence.agent.turns` and the first-command / first-change marks, so the
claim can be settled with one run instead of a trace reconstruction.

## 13. Turn forensics: the number that decides a prompt change

The metric for turn compression is **model round trips to a verified change**, not
tool calls. `benchmarks/codex/turn-report.mjs` derives it from Codex's own
rollout JSONL (`$CODEX_HOME/sessions/<date>/rollout-*.jsonl`), the only place the
response boundary is recorded:

```bash
node benchmarks/codex/turn-report.mjs --dir ~/.codex/sessions/2026/10/26 --group
node benchmarks/codex/turn-report.mjs <rollout.jsonl>... --json
```

A turn is one model response. Two `exec_command` calls in one response are one
turn; the same two calls in two responses are two. `calls/turn` therefore reads
`1.00` for a model that never batches, and drops below 1 only when a change
actually made it batch.

### Baseline, six real runs on this machine (2026-10-26, `gpt-5.6-terra`, effort low)

| run | label | turns | wall | calls/turn | env fails | first *successful* edit | planning-only turns |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | native | 16 | 162.0 s | 1.00 | 7 | turn 8 (81.8 s) | 3 |
| 02 | native | 24 | 288.8 s | 1.00 | 9 | turn 8 (91.5 s) | 4 |
| 03 | native | 17 | 208.9 s | 1.00 | 3 | turn 7 (99.9 s) | 3 |
| 04 | native | 11 | 118.2 s | 1.00 | 0 | none (no edit) | 2 |
| 05 | context block | 18 | 263.7 s | 1.00 | 7 | turn 11 (163.7 s) | 3 |
| 06 | native | 20 | 301.4 s | 1.00 | 3 | turn 7 (135.0 s) | 3 |

Median 17 turns, p95 24; per-turn model latency median **8.99 s**, p90 **16.1 s**.
Six runs, and not one batched two independent calls into a single response.

### Where the turns go

Classified from the tool calls themselves, per run (`!` = the call failed):

```
native  DEPENDENCY_LOOKUP! -> DISCOVERY! -> DISCOVERY -> DEPENDENCY_LOOKUP -> READ -> PLANNING
        -> EDIT! x2 -> READ -> EDIT! x3 -> EDIT -> EDIT! x2 -> EDIT -> PLANNING
        -> VERIFICATION! -> VERIFICATION -> PLANNING -> READ! -> OTHER -> PLANNING
context DEPENDENCY_LOOKUP! -> DEPENDENCY_LOOKUP! -> OTHER! -> DISCOVERY -> DEPENDENCY_LOOKUP
        -> PLANNING -> EDIT! x4 -> EDIT -> EDIT -> OTHER -> OTHER -> PLANNING
        -> VERIFICATION -> VERIFICATION -> PLANNING
```

Environment failures by signature, over the six runs: `apply_patch` quoting in 4,
cwd/ACL denial in 3, `npm.ps1` execution policy in 2, git "not a repository" in 2,
relative-path-from-`C:\` in 1.

### What this says about the interventions

1. **The facts block did not change the shape of a run.** The one run that carried
   the shell notes (`context`) still spent turns 1-3 on cwd discovery and turns
   7-10 on `apply_patch` quoting, and reached its first successful edit at turn 11
   (163.7 s) - later than every native run, three of which edited by turn 7-8.
   Notes placed in the prompt are not read before the model acts.
2. **Batching is not the lever yet.** Calls/turn is 1.00 in every trace, so a
   prompt asking for batched reads addresses something the model was never doing
   wrong; the turns are spent on *failures*, not on one-at-a-time reads.
3. **Planning is free to cut**: 2-4 `update_plan` turns per run carry no
   information and precede no change in direction.
4. The committed packet change (section 12) removes two *read* turns by
   construction, which is deterministic and is 2 of ~18. The patch loop (2-6
   turns in the runs that hit it) and the cwd loop (2-3) are untouched by it.

### A/B recipe when quota returns

```bash
# baseline: same binary, same model, same effort, no packet
kodevra run --engine codex -m openai/gpt-5.6-terra --no-context --executor host \
  --verify "npm.cmd test" --outcome base.json "<task>"
# candidate: the committed packet
kodevra run --engine codex -m openai/gpt-5.6-terra --executor host \
  --verify "npm.cmd test" --outcome cand.json "<task>"

node benchmarks/codex/turn-report.mjs ~/.codex/sessions/<date>/rollout-*.jsonl --group
```

`outcome.evidence.agent.turns` reports the same count per run, so the acceptance
rule (verified pass >= baseline **and** median turns down **and** median verified
runtime down) can be read from the outcome files directly.

**No turn reduction is claimed.** The ChatGPT account refuses every request
(`Reconnecting... waiting for network`), so no run of the packet change exists on
this machine; every number above is from runs made before it.
