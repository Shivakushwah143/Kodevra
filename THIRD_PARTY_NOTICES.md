# Third-party notices

Kodevra is a launcher. It does not vendor, fork or modify the upstream projects it drives, and their licenses
continue to apply to their own code.

## OpenCode

- Role: agent engine - tool execution, permissions, sessions, terminal UI
- License: MIT
- Project: https://opencode.ai
- Installed as a separate CLI (`opencode-ai`); not included in this repository.

## Codex CLI

- Role: optional second execution engine - agent loop, tools, sandbox, sessions
- License: Apache-2.0
- Project: https://github.com/openai/codex
- Installed as a separate CLI (`@openai/codex`); not included in this repository. Kodevra invokes its documented
  `codex exec --json` interface and does not modify or vendor it.

## FreeDeepseekAPI

- Role: OpenAI-compatible proxy that connects OpenCode to DeepSeek
- License: Apache-2.0 (see `integrations/FreeDeepseekAPI/LICENSE`)
- Project: https://github.com/dekrezz/FreeDeepseekAPI
- Located locally at `integrations/FreeDeepseekAPI`, which is git-ignored so upstream sources and credentials are
  never committed here. Unmodified.

## DeepSeek

DeepSeek model access is provided by the user's own DeepSeek account through FreeDeepseekAPI. DeepSeek's terms and
usage policies apply to model traffic.
