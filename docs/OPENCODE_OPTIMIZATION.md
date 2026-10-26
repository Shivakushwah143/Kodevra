# OpenCode harness optimisation — GPT-5.6 Terra

Date: 2026-10-26 · Branch: `sprint/opencode` · Engine: OpenCode 1.18.30 · Node 24.13.1
Machine: Windows 11, Git Bash · Target model: `openrouter/openai/gpt-5.6-terra` (catalog: *GPT-5.6 Terra*)

This document records what was measured, what changed, and what is still unproven. Kodevra is a
launcher; the agent loop, tools, permissions and sessions stay in OpenCode. Every change below is
in Kodevra and uses a capability the engine already has.

---

## 1. Audit

### What the engine already does (not duplicated)

| Capability | Owner | Kodevra's role |
| --- | --- | --- |
| Agent loop, planning, tool calls | OpenCode | launches it |
| Tool permissions, approval | OpenCode | writes a workspace-scoped permission overlay |
| Sessions, `--continue`, `--session` | OpenCode | passes the flags, never stores a transcript |
| Model catalog, capabilities, limits | OpenCode (`~/.cache/opencode/models.json`) | reads it, never invents values |
| Provider credentials, OAuth | OpenCode (`auth.json`) | presence checks only |
| Per-model reasoning effort | OpenCode (`--variant`) | chooses and validates the level |
| Per-model token limits | OpenCode model `limit` config | supplies one model block per run |
| Structured event stream | OpenCode (`--format json`) | consumes it for tracing and metrics |

Deliberately **not** added: a second agent loop, a subagent framework, a second provider registry, a
prompt-injection layer, an automatic retry policy, or a bundled model catalog.

### Defects found in the current harness

1. **The engine's workspace was the shell's directory, not the run's workspace.**
   OpenCode resolves its project root from `PWD`. `spawn(..., { cwd })` does not update `PWD`, so an
   inherited `PWD` (the Kodevra checkout) won. Every absolute path inside the real workspace was then
   "external" and was denied by Kodevra's own `external_directory: "deny"` rule. Evidence from
   `~/.local/share/opencode/log/opencode.log`:

   ```
   message=evaluated permission=external_directory pattern="C:\...\kodevra-smoke\src\*"
     action.permission=external_directory action.action=deny action.pattern=*
   ```

   Consequence: a headless run could plan but not read or edit a single file when the model used
   absolute paths. Sessions were also filed under the wrong project, so `kodevra sessions` and
   `-c` did not line up.

2. **A config model block hid the rest of the provider's catalog.** `kodevra init` writes one capped
   OpenRouter model (`google/gemini-3.6-flash`). `assessProvider` then reported *that model only* as
   the provider's list, so `kodevra doctor -m openrouter/openai/gpt-5.6-terra` failed with
   `"openai/gpt-5.6-terra" is not a openrouter model` although the engine serves it.

3. **The catalog output budget is unusable on an aggregator.** OpenRouter reserves `max_tokens` up
   front. GPT-5.6 Terra's catalog limit is 128000 output tokens; the account was told it
   "can only afford 2619". Kodevra already capped one Gemini model at 4096 in `init` for this exact
   reason, but applied nothing at run time.

4. **No per-model settings at all.** `kodevra run` passed only `-m provider/model`. The engine's
   native `--variant` (provider reasoning effort) and model `limit` were never used, and the model's
   advertised capabilities (`tool_call`, `temperature: false`, real context) were never consulted.

5. **Startup asked the engine for the same facts repeatedly.** Measured on this machine:
   `opencode --version` 2542 ms, `opencode models openai` ~4300 ms, the Docker probe ~200 ms
   (called 2–3× per run), the 5.9 MB model catalog ~130 ms per parse (parsed 3–4× per command).

6. **`--verify` runs on the host were reported as sandboxed=no but the startup panel, the
   diagnostics and the executor decision each probed Docker independently.**

7. **Failure text was generic for two real provider answers**: an expired API key ("Signing in again
   will not renew this key") was answered with "sign in again", and a credits shortfall produced no
   actionable flag.

8. **A flaky unit test** (`file metadata speaks for workspaces git cannot see`) rewrote a file with
   the same size inside one system clock tick; measured on this machine, two back-to-back writes
   carry identical `mtimeMs`/`ctimeMs`, so the snapshot could not see the change.

---

## 2. What changed

| File | Change |
| --- | --- |
| `lib/engine.js` | sets `PWD` to the spawn cwd (fix 1); optional `onLine`/`forwardStdout` for the engine's JSON stream |
| `bin/kodevra.js` | same `PWD` fix for interactive launch; `--reasoning`, `--output-tokens`, `--trace`; model profile line; trace sink; metrics in the summary; cached engine version; honest doctor summary |
| `lib/model-profile.js` | **new** — catalog-driven profile, effort validation, output-budget resolution, model config block |
| `lib/trace.js` | **new** — parses `--format json` step/tool/token events into one line per step plus totals |
| `lib/cache.js` | **new** — tiny on-disk cache keyed by binary/credential identity with a TTL |
| `lib/providers.js` | config models add to the catalog (fix 2); catalog parsed once per process; authenticated model list cached |
| `lib/doctor.js` | cached engine version (invalidated by binary size+mtime); refuses a model that declares no tool calls; model list check |
| `lib/docker-executor.js` | Docker probe memoized per process |
| `lib/permissions.js` | overlay may carry the selected model's `limit`, and refuses anything that could hold a credential |
| `lib/failures.js` | `CONFIG_INVALID`; expired-key vs sign-in; credits shortfall names the exact affordable `--output-tokens` |
| `lib/verify.js` | summary reports steps, tool calls, model time, tokens and cost when `--trace` was used |
| `lib/events.js` | `model_metrics` event |
| `benchmarks/runner.js` | `PWD` per task; a remote provider has no local session to reset (was an automatic infra failure) |
| `test/*` | 27 new tests; the flaky metadata test made deterministic |

### New flags

```
--reasoning <level>    # engine --variant; validated against the catalog (none|low|medium|high|xhigh|max)
--output-tokens <n>    # OpenCode model limit for this run; also KODEVRA_OUTPUT_TOKENS
--trace                # engine --format json -> steps, tool calls, tokens, cost in the summary
```

Environment: `KODEVRA_REASONING`, `KODEVRA_OUTPUT_TOKENS`, `KODEVRA_MODEL_LIMITS=0` (disable the
aggregator cap), `KODEVRA_NO_CACHE=1`, `KODEVRA_CACHE_DIR`, `KODEVRA_ENGINE_VERSION_TTL_MS`,
`KODEVRA_MODELS_TTL_MS`.

### Feature-flag / rollback

* The aggregator output cap is the only behaviour change on by default. `KODEVRA_MODEL_LIMITS=0`
  restores the previous behaviour exactly (verified below — it reproduces the pre-fix 402 failure).
* The caches can be disabled wholesale with `KODEVRA_NO_CACHE=1`; a stale entry is impossible for
  the engine version because the key includes the binary's size and mtime, and the model list is
  keyed on the credential file's identity with a 10-minute TTL.
* `--trace` changes only what Kodevra reads, never what the model is asked.
* Reasoning effort is opt-in: nothing is passed unless `--reasoning` or `KODEVRA_REASONING` is set.

---

## 3. Measurements

All numbers are wall-clock on the machine above, measured in this session. `avg` is 3 runs.

### CLI startup (warm cache)

| Command | Before | After | Change |
| --- | --- | --- | --- |
| `kodevra version` | 1828 ms | 231 ms | −87% |
| `kodevra providers` | 13478 ms | 313 ms | −98% |
| `kodevra doctor` (warm) | 2942 ms | 593 ms | −80% |
| `kodevra doctor` (cold cache) | 2942 ms | 1706 ms | −42% |

`providers` was dominated by one `opencode models openai` spawn (~4.3 s each, plus repeated engine
work); `version`/`doctor` by `opencode --version` (2542 ms measured directly).

### Pre-model overhead of one `kodevra run`

Component costs measured directly on this machine: engine version spawn 2542 ms, Docker probe
~200 ms (called 3× when `--verify` is used), catalog parse ~130 ms (called 3–4×). Removing the
duplicates takes ~2.6 s out of every run before the model is contacted. This is a sum of measured
components, not a single stopwatch on the run path.

### Real coding-agent runs

Workspace: a copy of `examples/agent-smoke` with `.toLowerCase()` removed from `src/slugify.js`
(one test fails). Task: *"src/slugify.js fails its test because it strips uppercase letters. Fix the
implementation so the test passes; do not edit the test."* Verification: `npm test -- --executor host`.

| Run | Model | Result | Duration | Model steps | Tokens | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| Baseline (`KODEVRA_MODEL_LIMITS=0`, pre-fix behaviour) | `openrouter/openai/gpt-5.6-terra` | FAILED `RATE_LIMITED` — "can only afford …" before any step | 14.3 s | 0 | 0 | $0 |
| After the fixes, `--output-tokens 2000` | `openrouter/openai/gpt-5.6-terra` | 1 step completed (3 tool calls, all previously denied paths now allowed), then the account ran out of credit for step 2 | 15.2 s | 1 | 3 in / 181 out | $0.0217 |
| After the fixes, `--trace`, default cap | `openrouter/cohere/north-mini-code:free` | **VERIFIED** — read source + test, edited the implementation, `npm test` exit 0 | 31.5 s (repeat: 41.6 s) | 5 (6 tool calls, 2 failed) | 41 638 in / 265 out / 388 reasoning | $0 (free model) |

The free-model run is the end-to-end proof of the harness itself: workspace-correct tool access,
file edit, engine's own JSON tracing, Kodevra's verification deciding PASS, and the `bash` denial
for an unattended run reported as a denied tool call rather than a silent failure.

### What the trace reports now

```
  trace    read slugify.js (completed)
  trace    edit slugify.js (completed)
  trace    step 3 - 354 output tok - $0.00000
  ...
  Model steps      4 (6 tool calls, 1 failed)
  Tokens           33214 in / 207 out / 438 reasoning
```

---

## 4. Blockers and limitations

* **No FreeDeepseekAPI proxy in this worktree.** `integrations/FreeDeepseekAPI` is gitignored and
  absent, so the documented default provider (`freedeepseek`) cannot run here; `kodevra doctor`
  reports `FAIL proxy` (environmental, unchanged by this work).
* **Docker is not running**, so `--executor docker` and `sandbox_exec` could not be exercised. All
  runs above used the explicit `--executor host` opt-in; `doctor` reports the sandbox check as
  failed-but-optional.
* **The OpenRouter account cannot fund a multi-step Terra run.** The key is free-tier with zero
  credits; it affords roughly 1900 reserved output tokens per request. Terra's first step (three file
  reads) succeeded and cost $0.0217; the next request was rejected. A full Terra fix-and-verify run
  needs credits, not a code change.
* **The `opencode` gateway key stored on this machine is expired** (`api_key_expired`, 401), so
  `opencode/gpt-5.6-terra` is not a usable path here. Kodevra now names that condition instead of
  advising a sign-in that would not help.
* **The effect of `--reasoning` on task success is not measured.** The plumbing is implemented and
  validated against the catalog, but measuring medium/high on a multi-step task needs a funded
  account. No speed or quality claim is made for it.
* **No live benchmark comparison.** `benchmarks/runner.js` now supports remote providers, but the
  existing 20-task suite could not be run: the proxy account is unavailable and Terra is unfunded.
* Token and cost figures come from the engine's own `step_finish` events; they are absent unless
  `--trace` is used, and Kodevra never estimates them.

---

## 5. Reproducing this

```bash
# 1. Unit and integration tests (105 tests)
npm test

# 2. Diagnostics for the target model (proxy/docker are environmental)
node bin/kodevra.js doctor -m openrouter/openai/gpt-5.6-terra

# 3. Startup timings
for cmd in version providers doctor; do
  /usr/bin/time -f "$cmd %es" bash -c "node bin/kodevra.js $cmd >/dev/null 2>&1"
done

# 4. The pre-fix failure, reproduced on demand (no model call succeeds)
KODEVRA_MODEL_LIMITS=0 node bin/kodevra.js run --no-doctor --executor host -w <workspace> \
  -m openrouter/openai/gpt-5.6-terra --verify "npm test" "fix the failing test"

# 5. The same run with the fix, traced
node bin/kodevra.js run --no-doctor --executor host -w <workspace> \
  -m openrouter/openai/gpt-5.6-terra --output-tokens 2000 --trace \
  --verify "npm test" "fix the failing test"

# 6. The land the fix was proven on, without spending credits
node bin/kodevra.js run --no-doctor --executor host -w <workspace> \
  -m "openrouter/cohere/north-mini-code:free" --trace \
  --verify "npm test" "fix the failing test"

# 7. A workspace whose tests fail (fixture re-arm)
cd examples/agent-smoke && npm test        # currently passes; remove .toLowerCase() to re-arm
```

---

## 6. Suggested Terra command line

```bash
# One-off, cheapest safe configuration for a funded account:
kodevra run --no-doctor -m openrouter/openai/gpt-5.6-terra \
  --reasoning high --output-tokens 16000 --trace \
  --verify "npm test" "<task>"
```

`--reasoning high` is a deliberate choice for coding, not a measured optimum here (see limitations).
`--output-tokens` only matters for aggregators, where the reservation is what the balance must cover.
