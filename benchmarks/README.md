# Kodevra coding benchmarks

A reproducible harness that compares Kodevra with plain OpenCode on the same
model, starting repository and task prompt. It measures **verified success** —
the hidden acceptance test decides, not the model's prose.

## Layout

```
benchmarks/
  tasks/<id>/
    task.json                  id, title, category, prompt, verify command
    template/                  starting repository (broken on purpose)
    acceptance/acceptance.test.js   hidden test copied in only after the agent finishes
    solution/                  reference solution, used to prove the fixture is solvable
  runner.js                    fixture validation, execution, results
  results/
    fixtures.json              last integrity check
    summary.md                 generated report
    raw/<variant>/<task>.json  one record per run
    runs.jsonl                 append-only log
```

Task workspaces are created under `%TEMP%/kodevra-bench` (never inside this
repository), each initialized as its own git root so workspace-scoped
permissions cannot widen and the agent has no path to the fixtures.

## Commands

```bash
node benchmarks/runner.js --list        # 20 tasks
node benchmarks/runner.js --validate    # manifests, templates, hidden tests, solutions
node benchmarks/runner.js --check       # template fails -> hidden fails -> solution passes
node benchmarks/runner.js --task 01-cart-total --variant both
node benchmarks/runner.js --all --timeout 240000
node benchmarks/runner.js --summary     # regenerate results/summary.md
```

`--check` is the integrity gate: a fixture is only usable when its template
fails, its hidden acceptance test also fails on the template, and its reference
solution makes every test pass. `--validate` additionally rejects a fixture whose
manifest, template, hidden test or solution is missing.

Results are resumable. A task with a recorded result is skipped; pass `--force`
to re-run it. Each record contains verified success, attempts, repair count,
duration, files changed, agent exit, verification exit, provider error code and
session-reset status. Token counts and costs are recorded as `null` because
neither CLI exposes a reliable per-run figure here.

## Fairness rules

- Same model id (`freedeepseek/deepseek-v4-flash`), same prompt text, same
  starting repository, same acceptance test.
- The repository is reset from its fixture before every run; hidden tests and
  solutions are copied in only after the agent has finished.
- The local DeepSeek proxy is sticky per client. The runner calls
  `POST /reset-session?agent=all&history=drop` before each run so one task
  cannot see another task's conversation (or the other variant's).
- Plain OpenCode runs with `--auto` so it can edit files and run commands.
  Kodevra's headless runs allow workspace edits but deny host bash; its
  verification loop, when used, runs the developer's command on the host
  (`--executor host`).
- A fixture hash is taken before each run. If an agent reaches back into the
  fixtures, the run is rejected as `fixture tampered during the run` instead of
  being scored.
- A timeout kills the whole process tree, so an orphaned engine cannot hold the
  proxy's chat lock and poison later runs.

## Environment differences to report, not hide

| Aspect | Plain OpenCode | Kodevra |
| --- | --- | --- |
| Tool permissions | `--auto`, everything approved | workspace edits allowed, host bash denied |
| Verification loop | none | `--verify "<task verify>"`, bounded repair (2) |
| Prompt | task prompt | `Workspace: <dir>. Use paths relative to this directory.` + task prompt |
| Execution env | host | host (`--executor host`) for this comparison |

A Kodevra win can therefore reflect the verification loop rather than model
quality. That distinction is stated in every generated summary.

## Current status

All 20 fixtures are implemented and `--check` reports 20/20 sound. The live
pilot has not produced a valid comparison yet: the local DeepSeek proxy account
went into cooldown (`failures: 6`, `cooldown_remaining_sec: 267`) during the
pilot and both variants timed out, so `results/summary.md` records those runs as
failures rather than evidence. Re-run `--task 01-cart-total --variant both` once
the proxy reports `cooldown: false` and a successful completion.
