# Kodevra - agent instructions

Kodevra is a branded entry point over the existing OpenCode agent engine.
Tagline: **Your Models. Your Code. Your Agent.**

## Architecture (do not duplicate it)

- **Engine:** OpenCode owns the agent loop, tools, permissions and sessions. Kodevra never reimplements them.
- **Model access:** FreeDeepseekAPI (`integrations/FreeDeepseekAPI`, gitignored) exposes an OpenAI-compatible
  proxy at `http://127.0.0.1:9655/v1`; model id `deepseek-v4-flash` as `freedeepseek/deepseek-v4-flash`.
- **Kodevra:** a thin launcher (`bin/kodevra.js`, `lib/*.js`). Identity, diagnostics, workspace selection.
  No terminal framework, no forked OpenCode UI.
- **Providers:** DeepSeek through FreeDeepseekAPI is the proven default. `lib/providers.js` discovers the engine's
  real catalog and credential store; `kodevra providers` lists what is actually ready. Only claim a provider works
  after a real run on it.
- **Gemini:** `google-api` is the supported path (AI Studio key). `gemini-web` is deliberately unsupported: the
  web-to-API adapters replay Google session cookies, which is out-of-terms access and account-level credential
  handling. Never add cookie import, browser-profile scraping or an anti-bot workaround for it.

## Layout

- `bin/kodevra.js` - CLI: launch, `run`, `doctor`, `init`, `providers`, pass-through to OpenCode
- `lib/config.js` - reads `~/.config/opencode/opencode.json`; only *adds* a missing provider block
- `lib/providers.js` - engine catalog + credential discovery, readiness, selection state (`~/.kodevra/state.json`)
- `lib/auth.js` - delegation to OpenCode's login flows; credential *presence* checks only
- `lib/doctor.js` - engine/provider/model/auth/proxy/workspace checks
- `lib/brand.js` - wordmark, tagline, colour
- `examples/agent-smoke` - disposable project used to prove the agent can read, edit and test files

## Rules

- Keep it small. No new dependencies unless unavoidable; no React/Next.js/Python/Docker/databases.
- Never rewrite a working provider config and never print or commit credentials (`.env`, `auth.json`, session tokens).
- Authentication is delegated to OpenCode. Never add a token exchanger, key store, cookie capture or password prompt.
- Fix integration defects in Kodevra; leave upstream OpenCode and FreeDeepseekAPI untouched.
- Preserve upstream attribution (OpenCode MIT, FreeDeepseekAPI Apache-2.0).

## Engineering discipline

1. **Inspect before editing.** Read the files you will touch plus their callers, tests and config. Never guess a
   file's contents or a function's signature - read it with a tool.
2. **Respect the existing architecture.** Extend what is there; do not add a second agent loop, a second config
   system or a parallel provider registry.
3. **Prefer the smallest change that fully solves the task.** No drive-by refactors, renames, dependency additions
   or formatting churn.
4. **Use real tools on real files.** Every claim about a file must come from a read, and every claim about behaviour
   from an executed command.
5. **Run relevant verification** with the repository's own commands (`kodevra doctor`, `npm test`, `node --check`).
   Passing code you only generated is not verification.
6. **Repair simple failures yourself** - a failing test, an obvious typo, a missing import - and re-run until green.
   Stop only for a real blocker: missing credentials, a destructive action, or a decision only the user can make.
7. **Never fabricate results.** Quote the actual output. If a check could not run, say so explicitly.
8. **Explain tradeoffs and remaining issues** in the final summary: what changed, what was verified, what is still
   unproven or expected to break next.

## Verify before reporting

```
node bin/kodevra.js doctor                     # must be all PASS
node bin/kodevra.js providers                  # provider readiness
cd examples/agent-smoke && npm test            # must pass after the agent fixes the bug
git diff -- examples                          # the real change
```

Never report PASS from generated code alone; run the command and show the output.
