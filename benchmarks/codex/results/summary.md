# Kodevra Codex harness benchmark

Generated: 2026-10-26T06:27:55.284Z
Requested model (both variants): `openai/gpt-5.6-terra`
Machine: win32/x64, Node 24.13.1
Codex CLI: `0.149.1` (KODEVRA_CODEX_BIN)

## Coverage

- Scenarios implemented: **5** (bug-fix, feature, refactoring, multi-file, debugging)
- kodevra: 5/5 executed, 0 verified success
- codex-cli: 1/5 executed, 1 verified success
- Not executed: codex-cli/02-feature-csv-escape, codex-cli/03-refactor-extract-validators, codex-cli/04-multifile-rename-currency, codex-cli/05-debug-async-batcher
- Fixture integrity (last --check): 5/5 sound
- A verified Codex-adapter run is preserved in `results/reference/` because a later `--force` re-run overwrote its raw record with a quota failure. `runs.jsonl` holds every attempt.
- **5 run(s) hit the provider usage limit** (kodevra). Those are quota failures, not harness results; re-run them when the account has quota with `node benchmarks/codex/runner.js --all`.

## Per-task results

| Task | Category | kodevra | codex-cli |
| --- | --- | --- | --- |
| `01-bugfix-invoice-tax` Invoice total ignores sales tax | bug-fix | FAIL (rate_limit) 24.4s verify=1 | PASS 127.8s verify=0 |
| `02-feature-csv-escape` CSV export does not escape fields | feature | FAIL (rate_limit) 15.0s verify=1 | not run |
| `03-refactor-extract-validators` Extract reusable signup validators | refactoring | FAIL (rate_limit) 16.4s verify=1 | not run |
| `04-multifile-rename-currency` Rename the money formatter across consumers | multi-file | FAIL (rate_limit) 13.1s verify=1 | not run |
| `05-debug-async-batcher` Async batcher loses buffered items | debugging | FAIL (rate_limit) 18.6s verify=1 | not run |

## What each variant did

- `kodevra`: `kodevra run --engine codex --verify <task verify> --executor host` - the Codex adapter, a pre-flight run of the same verification command feeding a workspace-facts block into Codex's prompt, Kodevra's verification gate, bounded repair (2) and a normalised outcome file (`--outcome`). `--no-context` removes the facts block for an A/B baseline.
- `codex-cli`: the official `codex exec --sandbox workspace-write --json` with the same prompt, model and starting repository, and no Kodevra involvement.
- Both are judged afterwards by the same hidden acceptance test, copied in only after the agent stops.

## Fairness notes

- Same model id, same task text, same starting repository, same acceptance test. The task text is byte-identical in both variants; the kodevra variant adds a one-line `<kodevra_context>` block of measured facts (root, file list, the pre-flight result of the same verify command, shell notes), and `--no-context` runs the earlier, context-free baseline.
- Every repository is reset from its fixture before a run, and its own git root is created under the system temp directory.
- The fixture directory is hashed before and after; a run that touches a fixture is rejected as `fixture_tampered` instead of scored.
- A Kodevra PASS requires both its own verification and the hidden acceptance test to pass. Plain Codex gets one attempt; Kodevra may run up to two repairs, so a Kodevra win can reflect the repair loop rather than the harness.
- Codex runs under its own sandbox (`workspace-write`) and its own credentials. On Windows the `[windows] sandbox = "elevated"` setting in Codex's config is required for shell tools to run at all; without it Codex can exit 0 while doing nothing, and the hidden test catches that.
- Token counts come from Codex's `turn.completed` usage event (Kodevra's outcome file, or the plain CLI's own JSONL). They are never estimated; a record made before that extraction shows `null`.

## Known gaps

- A single machine, one date and one model: this is a reproducibility harness, not a claim of superiority.
- Plain Codex gets no `--verify` loop, so the comparison measures the whole Kodevra path (gate + repair + outcome) against the raw CLI, not the two harnesses' reasoning in isolation.
- Kodevra's `--verify` runs the task suite inside the run and the runner runs it again with the hidden test; Kodevra's recorded duration therefore includes one extra suite run, plus the pre-flight run when `--context` is on.

