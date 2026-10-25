# Kodevra

**Your Models. Your Code. Your Agent.**

Kodevra is a thin, branded entry point for autonomous coding. It deliberately ships **no agent loop of its own**:
[OpenCode](https://opencode.ai) owns tool execution, permissions, sessions and the terminal interface, while
FreeDeepseekAPI provides OpenAI-compatible access to DeepSeek. Kodevra adds the product identity, a default model,
startup diagnostics and a one-word command.

```
  █▄▀ █▀█ █▀▄ █▀▀ █ █ █▀█ ▄▀█
  █ █ █▄█ █▄▀ ██▄ ▀▄▀ █▀▄ █▀█
  Your Models. Your Code. Your Agent.
```

## Requirements

- Node.js 20 or newer
- OpenCode 1.18+ (`npm i -g opencode-ai`)
- The FreeDeepseekAPI proxy running on `http://127.0.0.1:9655/v1` with the `deepseek-v4-flash` model

## Install

```bash
cd Kodevra
npm link                        # optional: exposes the global `kodevra` command
kodevra doctor                  # checks engine, provider, model, proxy and workspace
```

`npm link` only needs to run once. To remove it later: `npm unlink -g kodevra`.

## Launch

```bash
kodevra                              # agent in the current directory
kodevra C:/path/to/project           # agent in another workspace
kodevra run "fix the failing test"   # one headless task (tool permissions auto-approved)
kodevra doctor                       # diagnostics only
kodevra init                         # add the DeepSeek provider if it is missing
node bin/kodevra.js                  # fallback: no global install required
```

Anything after `--` is forwarded to OpenCode unchanged:

```bash
kodevra -- --continue
```

Start the model proxy before launching:

```bash
cd integrations/FreeDeepseekAPI && npm start
```

## Configuration

Kodevra reads the OpenCode config at `~/.config/opencode/opencode.json` (override with `OPENCODE_CONFIG`):

- provider `freedeepseek` -> `http://127.0.0.1:9655/v1`
- default model `freedeepseek/deepseek-v4-flash`

`kodevra init` only **adds** the provider block when it is missing; an existing, working configuration is left
untouched and backed up to `opencode.json.kodevra-backup` before any write. Provider presets live in
`lib/config.js` (`PROVIDER_PRESETS`), which is where Gemini and ChatGPT support will be added.

Environment variables: `KODEVRA_MODEL`, `KODEVRA_SKIP_DOCTOR=1`, `OPENCODE_BIN`, `OPENCODE_CONFIG`,
`KODEVRA_DEEPSEEK_BASE_URL`, `KODEVRA_DEEPSEEK_API_KEY`. Credentials belong in local files only - never commit
`.env`, `auth.json` or session tokens.

## Layout

| Path | Purpose |
| --- | --- |
| `bin/kodevra.js` | CLI: launch, `run`, `doctor`, `init`, argument pass-through |
| `lib/config.js` | OpenCode config reader, provider presets, model resolution |
| `lib/doctor.js` | startup diagnostics (node, engine, config, provider, model, proxy, workspace) |
| `lib/brand.js` | wordmark, tagline, colour |
| `AGENTS.md` | engineering instructions picked up by OpenCode's `AGENTS.md` mechanism |
| `examples/agent-smoke` | disposable project with one failing test, used to prove the agent works |

## Smoke test

`examples/agent-smoke` is the disposable harness used to prove that the agent really reads, edits and tests files.
It ships with a `slugify` implementation whose single test fails; the agent fixes it end to end:

```bash
kodevra run --workspace examples/agent-smoke "Run npm test, find the bug in src/slugify.js, fix it without touching the test, and re-run until it passes."
cd examples/agent-smoke && npm test     # 1 pass, 0 fail
```

To re-arm the demo, break the implementation again (for example drop `.toLowerCase()` from
`examples/agent-smoke/src/slugify.js`) so its test fails before the next agent run.

## Attribution

Kodevra builds on other people's work and keeps their licenses and attribution intact. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
