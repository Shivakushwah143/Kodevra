# Kodevra vs plain OpenCode — benchmark results

Generated: 2026-10-25T11:04:12.093Z
Model (both variants): `freedeepseek/deepseek-v4-flash`
Machine: win32/x64, Node 24.13.1

## Coverage

- Tasks implemented: **20**
- Expected runs (2 variants): **40**
- Runs executed: **2** (5%)
- opencode: 1/20 executed, 0 verified success
- kodevra: 1/20 executed, 0 verified success
- Not executed: opencode/02-range-sum, kodevra/02-range-sum, opencode/03-rename-currency, kodevra/03-rename-currency, opencode/04-users-handler, kodevra/04-users-handler, opencode/05-signup-validation, kodevra/05-signup-validation, opencode/06-extract-validator, kodevra/06-extract-validator, opencode/07-retry-wrapper, kodevra/07-retry-wrapper, opencode/08-parse-duration, kodevra/08-parse-duration, opencode/09-rate-limiter, kodevra/09-rate-limiter, opencode/10-map-limit, kodevra/10-map-limit, opencode/11-average-consumers, kodevra/11-average-consumers, opencode/12-csv-fields, kodevra/12-csv-fields, opencode/13-add-days, kodevra/13-add-days, opencode/14-multi-key-sort, kodevra/14-multi-key-sort, opencode/15-title-case, kodevra/15-title-case, opencode/16-traffic-light, kodevra/16-traffic-light, opencode/17-lru-cache, kodevra/17-lru-cache, opencode/18-paginate, kodevra/18-paginate, opencode/19-escape-html, kodevra/19-escape-html, opencode/20-argv-parser, kodevra/20-argv-parser
- Fixture integrity (last check): 20/20 sound
- **Pilot note:** every executed run timed out while the local DeepSeek proxy account was in cooldown. These are infrastructure failures, not a model comparison.

## Per-task results

| Task | Category | OpenCode | Kodevra |
| --- | --- | --- | --- |
| `01-cart-total` Cart total ignores quantity | bug-fix | FAIL (verify 1) | FAIL (verify 1) |
| `02-range-sum` Inclusive range sum drops the last number | bug-fix | not run | not run |
| `03-rename-currency` Rename the money formatter across its callers | multi-file | not run | not run |
| `04-users-handler` Implement the users HTTP handler | api-implementation | not run | not run |
| `05-signup-validation` Implement signup validation | validation | not run | not run |
| `06-extract-validator` Extract reusable email validation | refactoring | not run | not run |
| `07-retry-wrapper` Retry wrapper ignores its retries option | error-handling | not run | not run |
| `08-parse-duration` Duration parser drops the minutes component | test-repair | not run | not run |
| `09-rate-limiter` Rate limiter never expires its window | backend-logic | not run | not run |
| `10-map-limit` Concurrency-limited map ignores its limit | async | not run | not run |
| `11-average-consumers` Average contract change must reach both consumers | dependency-aware | not run | not run |
| `12-csv-fields` CSV parsing ignores quoted fields | parsing | not run | not run |
| `13-add-days` addDays breaks across month and year boundaries | dates | not run | not run |
| `14-multi-key-sort` sortRows ignores direction and mutates its input | sorting | not run | not run |
| `15-title-case` titleCase mangles small words and acronyms | strings | not run | not run |
| `16-traffic-light` Traffic light transitions in the wrong order | state-machine | not run | not run |
| `17-lru-cache` Cache never evicts and ignores recency | caching | not run | not run |
| `18-paginate` Pagination metadata is wrong and inputs are unclamped | pagination | not run | not run |
| `19-escape-html` Comment rendering allows stored HTML injection | security | not run | not run |
| `20-argv-parser` CLI argument parser misses the common flag forms | cli-parsing | not run | not run |

## Fairness notes

- Both variants run the same model id, the same task prompt and the same starting repository.
- Every repository is reset from its fixture before a run; hidden acceptance tests are copied in only after the agent finishes.
- Kodevra adds a verification loop and prepends `Workspace: <dir>` to the prompt; plain OpenCode does not, so a Kodevra win can reflect the verification loop rather than model quality.
- Plain OpenCode runs with `--auto` so file edits and shell commands are approved; Kodevra's headless runs allow workspace edits but deny host bash. Tool access therefore favors OpenCode, verification favors Kodevra.
- Both variants run on the host for this comparison: Kodevra uses `--executor host`. Kodevra's `--executor docker` would run verification in a container, which is a different environment and is reported as such when used.
- Repair runs are Kodevra's bounded loop (default 2). Plain OpenCode gets one attempt.
- Token counts and costs are not reported: neither CLI exposes a reliable per-run figure here, so none are invented.

## Known gaps

- `tool_failures` is not measurable from the CLIs' output and is recorded as `null`.
- A single machine, one date and one model: this is a reproducibility harness, not a claim of general superiority.

