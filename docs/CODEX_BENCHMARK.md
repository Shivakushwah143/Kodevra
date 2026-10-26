# Codex harness integration and benchmark

Kodevra can run the **official open-source Codex CLI** as a second execution
engine. OpenCode stays the default; Codex is opt-in per run or per install.

This document records what was integrated, how to reproduce the benchmark, the
results actually observed on this machine, and what remains unproven.

## 1. What was integrated, and what was deliberately not

| Layer | Owner |
| --- | --- |
| Agent loop, planning, tools, sandbox, approvals, sessions | Codex (`codex exec`) |
| Launch, engine selection, diagnostics, verification gate, repair prompt, evidence | Kodevra |

The adapter is `lib/codex.js`. It invokes the installed CLI's official
non-interactive interface:

```bash
codex exec --sandbox workspace-write -C <workspace> --skip-git-repo-check \
  --json --color never [-m <model>] [-c model_provider="openai"] "<task>"
```

`--json` prints Codex's own JSONL event stream, which is the evidence Kodevra
normalises. Kodevra does not parse prose, invent tool calls, retry a tool, or
run a second agent loop.

Alternatives considered and rejected:

- **`codex app-server`** is marked experimental in the installed CLI (`0.149.1`)
  and would require a long-lived JSON-RPC client plus lifecycle management in
  Kodevra. That is a larger surface than the task needs.
- **`@openai/codex-sdk`** adds a dependency and spawns the same CLI underneath;
  it buys no behaviour the CLI does not already expose.
- **A custom Codex provider block written by Kodevra** would duplicate Codex's
  configuration system. Codex's `config.toml` remains the single source of truth
  for its providers, and Kodevra never rewrites it.

Supporting modules:

- `lib/harness.js` - registry, selection precedence, readiness per engine.
- `lib/executable.js` - shared PATH resolver (moved out of `lib/doctor.js` so
  the adapters do not import diagnostics).
- `lib/outcome.js` - `kodevra.outcome/1` normalised result.
- `bin/kodevra.js` - `--engine`, `kodevra engines`, harness-aware run/launch,
  `--outcome`.
- `lib/doctor.js` - Codex install, auth, config, Windows sandbox and provider
  reachability checks.

## 2. Selecting the harness

```bash
kodevra engines                     # readiness of opencode and codex
kodevra engines current             # active engine
kodevra engines use codex           # persist the choice in ~/.kodevra/state.json
kodevra engines use opencode        # switch back (the default)

kodevra run --engine codex "fix the failing test"
kodevra --engine codex              # interactive Codex session
```

Precedence: `--engine` > `KODEVRA_ENGINE` > `~/.kodevra/state.json` > `opencode`.
Selecting a provider and selecting an engine are independent keys in the same
state file; neither overwrites the other. Neither OpenCode's nor Codex's own
config is rewritten.

`kodevra doctor --engine codex` reports:

```
PASS  engine          codex 0.149.1 · KODEVRA_CODEX_BIN
PASS  auth            ChatGPT sign-in (codex login) · codex config provider "freedeepseek"
PASS  codex config    ~/.codex/config.toml · freedeepseek/deepseek-v4-flash
FAIL  codex provider  http://127.0.0.1:9655/v1/models unreachable (fetch failed)
PASS  codex sandbox   [windows] sandbox = elevated
```

The failing provider check is real: the local DeepSeek proxy was not running.

## 3. Authentication detection (presence only)

Codex owns its credentials. Kodevra checks presence and reports the *method*:

| Method | How Kodevra detects it | Secret read? |
| --- | --- | --- |
| ChatGPT sign-in | `codex login status` output ("Logged in using ChatGPT") | No |
| API key | `codex login status`, or `CODEX_API_KEY` / `OPENAI_API_KEY` present in the environment | No (name only) |
| Custom provider | top-level `model_provider` in `~/.codex/config.toml` | No |
| Stored but unverifiable | `auth.json` exists (stat only) | No - contents never read |

OpenCode credentials are never imported into Codex, and Codex credentials are
never imported into OpenCode. `kodevra auth login ...` still delegates to
OpenCode only; the Codex sign-in is the official `codex login`, run by the user.

No cookie scraping, browser-profile extraction, token exchange or account-level
credential handling was added.

## 4. Modes and sandbox

| Kodevra mode | Codex flag | Notes |
| --- | --- | --- |
| `read-only` | `--sandbox read-only` | inspection only |
| `workspace-write` | `--sandbox workspace-write` | default for `kodevra run` |
| `ask` (non-interactive) | refused with `HARNESS_MODE_UNSUPPORTED` | `codex exec` has no per-tool approval prompt |
| `ask` (interactive launch) | no sandbox flag | Codex's own approval UI applies |

On Windows, Codex's default sandbox blocks shell tools (`blocked by policy`) and
a run can exit 0 having changed nothing. The supported setting is Codex's own:

```toml
[windows]
sandbox = "elevated"
```

Kodevra reports this in `kodevra doctor`. It does not edit `config.toml`.

`--ignore-user-config` is deliberately not used: it removes the elevated Windows
sandbox setting and makes the silent-no-op failure more likely.

## 5. Normalised execution outcome

Every `kodevra run` now produces one record, written with

```bash
kodevra run --engine codex --outcome run.json "task"
```

and emitted as the `run_outcome` event in the run log:

```json
{
  "schema": "kodevra.outcome/1",
  "harness": "codex",
  "model": "gpt-5.6-terra",
  "provider": "openai",
  "status": "verified",
  "ok": true,
  "timing": { "duration_ms": 300478, "agent_ms": 299272, "verification_ms": 860 },
  "exit": { "code": 0, "signal": null, "timed_out": false, "timeout_reason": null },
  "error": null,
  "verification": {
    "command": "npm test",
    "ok": true,
    "exit_code": 0,
    "executor": "host",
    "sandboxed": false
  },
  "changes": { "count": 1, "files": ["src/invoice.js"] },
  "repairs": { "attempts": 0, "max": 2 },
  "evidence": {
    "events_file": "~/.kodevra/runs/run_...jsonl",
    "agent": {
      "thread_id": "01a176a5-3242-72e2-a99f-7c965b20bbae",
      "commands": [{ "command": "npm test", "exit_code": 0, "status": "completed" }],
      "failed_commands": 9,
      "file_changes": 0,
      "messages": 8,
      "tokens": { "input": 1629100, "cached_input": 1548800, "output": 6885, "reasoning_output": 2683 },
      "turn_completed": true,
      "turn_failed": false,
      "errors": []
    }
  }
}
```

`failed_commands` counts commands that failed *during* exploration, not commands
that were still failing at the end. The verification exit code is the verdict.

Statuses: `verified`, `unverified`, `verification_failed`, `failed`, `timeout`,
`approval_required`. `ok` is true only for `verified` and a clean `unverified`
run, matching Kodevra's existing reporting rules.

## 6. Benchmark suite

Five isolated scenarios, one per required category:

| Task | Category | What the agent must do |
| --- | --- | --- |
| `01-bugfix-invoice-tax` | bug-fix | `invoiceTotal` ignores the documented tax rate |
| `02-feature-csv-escape` | feature | add RFC4180-style field escaping to `toCsv` |
| `03-refactor-extract-validators` | refactoring | extract validators into `src/validators.js`, messages unchanged |
| `04-multifile-rename-currency` | multi-file | rename `formatMoney` -> `formatCurrency` in three files |
| `05-debug-async-batcher` | debugging | fix a buffer-mutation race in an async batcher |

Each fixture has `task.json`, `template/` (broken on purpose), hidden
`acceptance/` tests, and a reference `solution/`. `--check` proves the fixture is
sound: template fails, hidden test fails on the template, solution passes.

```bash
node benchmarks/codex/runner.js --list
node benchmarks/codex/runner.js --validate
node benchmarks/codex/runner.js --check          # 5/5 fixtures sound
node benchmarks/codex/runner.js --task 01-bugfix-invoice-tax --variant both
node benchmarks/codex/runner.js --all
node benchmarks/codex/runner.js --summary
```

Two comparable execution paths:

- `kodevra` - `kodevra run --engine codex --verify <task verify> --executor host --outcome <file>`
- `codex-cli` - the official `codex exec --sandbox workspace-write --json`, no
  Kodevra involvement

Both receive the same prompt, model id and starting repository. Workspaces are
disposable copies under the system temp directory, each its own git root. The
fixture directory is hashed before and after a run; a run that touches a fixture
is rejected as `fixture_tampered` rather than scored. The hidden acceptance test
is copied in only after the agent stops.

`benchmarks/lib/fixtures.js` holds the shared fixture machinery; the existing
OpenCode suite (`benchmarks/runner.js`) now uses the same implementation.

## 7. Results (actual, 2026-10-26)

Environment: Windows 11 x64, Node 24.13.1, Codex CLI **0.149.1**, model
`gpt-5.6-terra` through the ChatGPT sign-in (`codex login status`: "Logged in
using ChatGPT"). The DeepSeek proxy at `127.0.0.1:9655` was **down**, so the
shared DeepSeek model comparison could not run.

| Task | Category | `kodevra --engine codex` | official `codex-cli` |
| --- | --- | --- | --- |
| 01-bugfix-invoice-tax | bug-fix | **PASS** (306.1 s, 1 file, `npm test` exit 0) | **PASS** (127.8 s, 1 file, exit 0) |
| 02-feature-csv-escape | feature | RATE_LIMITED (15.0 s) | not run |
| 03-refactor-extract-validators | refactoring | RATE_LIMITED (16.4 s) | not run |
| 04-multifile-rename-currency | multi-file | RATE_LIMITED (13.1 s) | not run |
| 05-debug-async-batcher | debugging | RATE_LIMITED (18.6 s) | not run |

The verified Kodevra record (preserved in
`benchmarks/codex/results/reference/01-bugfix-invoice-tax.kodevra.json`, because
a later `--force` re-run overwrote its raw file):

- status `verified`, `npm test` exit 0, 1 file changed (`src/invoice.js`)
- 306.1 s total: 299.3 s agent, 0.9 s verification
- 20 commands, 9 of them failed during exploration; 8 agent messages
- 1,629,100 input tokens (1,548,800 cached), 6,885 output, 2,683 reasoning
- 0 repairs

The plain-CLI pass changed the same file and passed the same hidden test in
127.8 s (tokens for that record are `null`: it was recorded before the runner
parsed the plain CLI's JSONL usage).

**Do not read a harness ranking from this.** Two valid results out of ten
attempts is a smoke-level comparison, and both used ChatGPT, not the project's
default DeepSeek model. After the second full run the ChatGPT account hit its
usage limit, and the remaining five Kodevra runs failed in 13-25 s with
`RATE_LIMITED`. Those are quota failures, not harness results.

Re-run when quota is available:

```bash
export KODEVRA_CODEX_BIN="<path to a runnable codex>"
node benchmarks/codex/runner.js --all \
  --model openai/gpt-5.6-terra \
  --force
```

## 8. Blockers and limitations

1. **ChatGPT usage limit.** After ~1.6M tokens on task 01, every further run was
   rate-limited. The five fixture scenarios are implemented and validated, but
   only task 01 has a verified execution on both paths. No pass rate is claimed.
2. **The global npm Codex install is broken on this machine.**
   `@openai/codex@0.149.1` exists in the npm global root but its platform package
   `@openai/codex-win32-x64` is missing, and no `codex` shim is on PATH. Kodevra
   detects this and prints the reinstall command instead of crashing. The
   benchmark used a throwaway install under the temp directory and
   `KODEVRA_CODEX_BIN`; that path is machine-specific and is not committed.
3. **Windows sandbox.** Without `[windows] sandbox = "elevated"` in Codex's
   `config.toml`, Codex's shell tools are blocked by policy. A run can still exit
   0 while doing nothing. Kodevra's verification gate is what prevents that from
   being reported as success; the hidden acceptance test confirms it in the
   benchmark.
4. **`--mode ask` is unavailable non-interactively.** Codex has no per-tool
   approval prompt under `codex exec`; Kodevra refuses instead of silently
   granting `workspace-write`.
5. **Repairs are fresh runs.** `codex exec resume` has no `--sandbox` flag, so
   Kodevra's repair prompt starts a new `codex exec` with the same workspace and
   sandbox rather than resuming the Codex thread. Kodevra sessions are therefore
   not continued across repairs.
6. **Verification is executed twice for the Kodevra variant.** Kodevra runs the
   task command for its `--verify` gate, then the runner runs it again with the
   hidden test. Kodevra's recorded duration includes that extra run.
7. **No Codex-on-DeepSeek run.** The project's default provider was unavailable
   (proxy down), so Codex was exercised on ChatGPT only. `kodevra doctor
   --engine codex` correctly reported the dead provider endpoint.
8. **The multi-repair path is unexercised.** The only verified run needed zero
   repairs, and the quota then ran out.
9. **The Docker executor was not exercised with Codex.** Codex ran on the host
   and used its own sandbox; `--executor docker` remains a verification-executor
   option that was not part of these runs.
10. **Codex sessions stay in Codex's store.** `kodevra sessions --engine codex`
    points at `codex resume`; Kodevra does not copy or index them.

## 9. Unchanged behaviour

- OpenCode remains the default engine.
- Every provider, credential path and CLI feature that existed before this work
  is untouched; `kodevra doctor`, `providers`, `auth`, `sessions`, the permission
  overlay, the verification authorization gate and the Docker executor behave as
  before when `--engine` is not used.
- `npm test` covers the new selection, adapter and outcome logic.
