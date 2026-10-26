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
