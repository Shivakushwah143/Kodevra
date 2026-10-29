# Preserved reference run

`01-bugfix-invoice-tax.kodevra.json` is a verbatim copy of the first verified
Codex-adapter run, extracted from `../runs.jsonl`:

```bash
node -e "const fs=require('fs');const rows=fs.readFileSync('benchmarks/codex/results/runs.jsonl','utf8').trim().split('\n').map(JSON.parse);console.log(JSON.stringify(rows.find(r=>r.variant==='kodevra'&&r.task==='01-bugfix-invoice-tax'&&r.ok===true),null,2))"
```

It is kept because `results/raw/kodevra/01-bugfix-invoice-tax.json` was later
overwritten by a `--force` re-run that hit the ChatGPT usage limit. The
append-only `runs.jsonl` remains the authoritative log of every attempt; this
file exists so the one verified Codex-adapter result is not lost.

Recorded: 2026-10-26T05:18:14Z · `openai/gpt-5.6-terra` · Codex CLI 0.149.1 ·
306.1 s · 1 file changed · `npm test` exit 0 · 20 commands (9 failed during
exploration) · thread `01a176a5-3242-72e2-a99f-7c965b20bbae`.
