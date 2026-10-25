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
kodevra providers                    # provider readiness, credentials and default models
kodevra providers use openai         # select a provider (Kodevra state, not OpenCode config)
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

`kodevra init` is merge-only and backs the config up to `opencode.json.kodevra-backup` before any write:

- adds the `freedeepseek` provider when it is missing (an existing block is left byte-for-byte untouched);
- caps `openrouter/google/gemini-3.6-flash` at **4096 output tokens** using OpenCode's model-level `limit` config,
  keeping its real 1,048,576-token context and its capabilities. OpenRouter reserves `max_tokens` up front, so the
  catalog default of 65,536 can exceed a small balance even for a one-line answer. Nothing else in the config is
  touched, and no credits are ever purchased automatically.

Provider discovery and presets live in `lib/providers.js`; new providers are added by registering them there, never
by editing your working config.

Environment variables: `KODEVRA_MODEL`, `KODEVRA_SKIP_DOCTOR=1`, `OPENCODE_BIN`, `OPENCODE_CONFIG`,
`KODEVRA_STATE`, `KODEVRA_DEEPSEEK_BASE_URL`, `KODEVRA_DEEPSEEK_API_KEY`. Credentials belong in local files only -
never commit `.env`, `auth.json` or session tokens.

## Providers

`kodevra providers` lists what this machine can actually run. Readiness comes from the engine's own model catalog and
credential store, so nothing is advertised that is not configured:

```
provider               state        credential              default model
freedeepseek           ready        local proxy             deepseek-v4-flash
deepseek               ready        opencode auth           deepseek-v4-flash
openrouter             ready        env OPENROUTER_API_KEY  openai/gpt-5
gemini-web             unsupported  none                    -
google-api             needs auth   none                    gemini-2.5-pro
openai                 needs auth   none                    gpt-5
```

Kodevra keeps **official API access** and **experimental web access** strictly separate: `google-api` is the
supported Gemini path, `gemini-web` is registered but explicitly unsupported (see below).

- **DeepSeek through FreeDeepseekAPI is the default** and the only provider proven with the full coding loop.
- Pick a provider for one run: `kodevra run -p <provider> "<task>"`.
- Make it the default: `kodevra providers use <provider>` (or `<provider>/<model>`). Selection is stored in
  `~/.kodevra/state.json`; **OpenCode's config is never rewritten**. `kodevra providers use freedeepseek` restores
  the shipping default, and `kodevra providers current` shows the active model and where it came from.
- Credentials come from the environment (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, ...) or from
  OpenCode's own credential store via `opencode auth login`. Kodevra never asks for account passwords or browser
  cookies, and never prints a key: it reports only that credentials exist.
- A provider without credentials fails at `kodevra doctor` with the exact command or variable to set, and the agent is
  not launched.

## Authentication

Kodevra delegates every sign-in to OpenCode's own authentication flow. It never runs an OAuth exchange, never
asks for a password or cookie, and never stores a key itself - it only checks that a credential *exists* afterwards
and refreshes provider readiness.

```bash
kodevra auth status                    # provider, auth state, model, missing-credential guidance
kodevra auth login openai              # ChatGPT Plus/Pro sign-in on the official OpenAI page
kodevra auth login openai --headless   # same flow, paste the code manually
kodevra auth login google-api          # AI Studio key, pasted into OpenCode's prompt
kodevra auth login deepseek            # direct DeepSeek platform key
```

- **ChatGPT** uses OpenCode's supported OAuth (`ChatGPT Pro/Plus (browser)`), which redirects to
  `auth.openai.com` and returns to a local callback. If the installed OpenCode cannot do this, Kodevra says so
  instead of building an unofficial workaround.
- **Gemini** has two names, and only one works. `google-api` uses a Google AI Studio key
  (`https://aistudio.google.com/apikey`) entered through OpenCode's prompt.
- Signing in never changes the default provider. Opt in with `kodevra providers use openai` afterwards.

### Why `gemini-web` is unsupported

A Gemini consumer web session has no authorized API surface. Every web-to-API adapter surveyed
(`qutek/gemini-web-api`, `n0madic/go-gemini-web2api`, `@orcushq/gemini`) authenticates by replaying Google
**session cookies** - `__Secure-1PSID` / `__Secure-1PSIDTS`, or cookies scraped from a local Chrome profile -
against `gemini.google.com`. That is automated access outside Google's terms, it hands over account-level
credentials rather than a scoped key, and it breaks whenever Google rotates the flow.

Kodevra therefore does not ship that bridge: `kodevra auth login gemini-web` reports **BLOCKED** with the reason,
and `kodevra run -p gemini-web` refuses to start. There is no one-click OAuth to claim. Supported paths to Gemini
models are `kodevra auth login google-api`, or a Gemini model through the already-credentialed `openrouter`
provider (`-m openrouter/google/gemini-3.6-flash`, capped at 4096 output tokens by `kodevra init`).

## Layout

| Path | Purpose |
| --- | --- |
| `bin/kodevra.js` | CLI: launch, `run`, `doctor`, `init`, argument pass-through |
| `lib/config.js` | OpenCode config reader, DeepSeek preset, merge-only provider and model-limit writes |
| `lib/providers.js` | provider catalog discovery, readiness, credential diagnostics, selection state |
| `lib/auth.js` | delegates sign-in to OpenCode and verifies credential presence only |
| `lib/doctor.js` | startup diagnostics (node, engine, config, provider, model, auth, proxy, workspace) |
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
