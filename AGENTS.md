# Kodevra - agent instructions

Kodevra is a branded entry point over the existing OpenCode agent engine.
Tagline: **Your Models. Your Code. Your Agent.**

## Architecture (do not duplicate it)

- **Engine:** OpenCode owns the agent loop, tools, permissions and sessions. Kodevra never reimplements them.
- **Model access:** FreeDeepseekAPI (`integrations/FreeDeepseekAPI`, gitignored) exposes an OpenAI-compatible
  proxy at `http://127.0.0.1:9655/v1`; model id `deepseek-v4-flash` as `freedeepseek/deepseek-v4-flash`.
- **Kodevra:** a thin launcher (`bin/kodevra.js`, `lib/*.js`). Identity, diagnostics, workspace selection.
  No terminal framework, no forked OpenCode UI.
- **Providers:** presets live in `lib/config.js` (`PROVIDER_PRESETS`). Gemini/ChatGPT are future entries there.

## Layout

- `bin/kodevra.js` - CLI: launch, `run`, `doctor`, `init`, pass-through to OpenCode
- `lib/config.js` - reads `~/.config/opencode/opencode.json`; only *adds* a missing provider block
- `lib/doctor.js` - engine/provider/model/proxy/workspace checks
- `lib/brand.js` - wordmark, tagline, colour
- `examples/agent-smoke` - disposable project used to prove the agent can read, edit and test files

## Rules

- Keep it small. No new dependencies unless unavoidable; no React/Next.js/Python/Docker/databases.
- Never rewrite a working provider config and never print or commit credentials (`.env`, `auth.json`, session tokens).
- Fix integration defects in Kodevra; leave upstream OpenCode and FreeDeepseekAPI untouched.
- Preserve upstream attribution (OpenCode MIT, FreeDeepseekAPI Apache-2.0).

## Verify before reporting

```
node bin/kodevra.js doctor                     # must be all PASS
cd examples/agent-smoke && npm test            # must pass after the agent fixes the bug
git diff -- examples                          # the real change
```

Never report PASS from generated code alone; run the command and show the output.
