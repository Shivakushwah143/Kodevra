# ChatGPT Web experiment (internal dogfood)

**Status: experimental, not a supported provider. Do not publish or present it as an OpenAI integration.**

The question this branch answers is narrow:

> Can Kodevra use the developer's ordinary ChatGPT web experience as its model, while Kodevra owns the
> coding tool loop?

It does not use an OpenAI API key, OpenRouter, ChatGPT/Codex OAuth, SIWC or any cookie import. Authentication
is the developer's existing Chrome ChatGPT session, inside their own browser profile. Kodevra never asks for,
reads or stores a ChatGPT cookie, session token or password.

## Architecture

```
kodevra run -p chatgpt-web
  -> localhost chatgpt-bridge (HTTP, loopback only)
  -> Chrome MV3 extension
  -> the real ChatGPT composer in a logged-in tab
  -> assistant text back to the bridge
  -> Kodevra's textual action protocol (one JSON action per turn)
  -> Kodevra repository tools + the developer's --verify command
```

chatgpt-bridge's OpenAI shim forwards only the **last user message** and returns plain assistant text. It
ignores `tools`, `tool_choice`, system messages and history. Kodevra therefore does not pretend the bridge is
a tool-capable OpenAI provider: `lib/chatgpt-web-agent.js` owns a small controller, and the ChatGPT
conversation itself holds the history between turns.

## Prerequisites

- chatgpt-bridge running locally (`npm start` in its checkout, default `127.0.0.1:8080`).
- The bridge's Chrome extension enabled in the Chrome profile that is signed in to ChatGPT, with a ChatGPT
  tab open and selected (`http://127.0.0.1:8080/setup`).
- `KODEVRA_CHATGPT_BRIDGE_TOKEN` set to the bridge's own `API_TOKEN` (from `<bridge data dir>/.env`) for the
  run. It protects the loopback HTTP API; it is not an OpenAI credential.

Optional: `KODEVRA_CHATGPT_BRIDGE_URL` when the bridge runs elsewhere on this machine.

## Run

```bash
kodevra run -p chatgpt-web --verify "npm test" "fix the failing test"
kodevra doctor -p chatgpt-web          # one readiness question: bridge up, browser tab attached
```

`-p chatgpt-web` is only valid for `run` and `doctor`. It is never the default and cannot be combined with
`--engine codex`.

## Text action protocol

ChatGPT returns exactly one JSON object per turn; nothing else.

```json
{"action":"read","path":"src/value.js"}
{"action":"read","path":"src/value.js","offset":120,"limit":80}
{"action":"read","path":"src/value.js","startLine":400,"endLine":520}
{"action":"search","query":"value","path":"src"}
{"action":"batch","operations":[{"action":"read","path":"src/value.js"},{"action":"shell","command":"git status --short"}]}
{"action":"write","path":"src/value.js","content":"complete file content"}
{"action":"edit","path":"src/value.js","old":"exact old text","new":"replacement"}
{"action":"apply_patch","patch":"...","complete":true}
{"action":"verify"}
{"action":"finish","summary":"short result"}
```

`complete: true` is completion intent: Kodevra applies the change, runs the configured verification locally, then
returns either VERIFIED (no further turn) or compact failure evidence. It is valid on `write`, `edit`,
`apply_patch`, `shell` and `batch`, and it never claims success without a real passing verification.

After each action Kodevra sends a `KODEVRA TOOL RESULT` user message into the **same conversation**. A reply
that is not one valid action gets exactly one correction message; a second failure stops the run.

## Boundaries and budgets

- Every path is workspace-relative and resolved against the selected workspace. Absolute paths, `..`
  escapes and symlink/junction escapes are refused (`PATH_OUTSIDE_WORKSPACE`).
- The file tools never read or write credential files: `.env*`, `auth.json`, `deepseek-auth.json`,
  `.npmrc`, `.netrc`, private keys and `.git`. The shell action parses the command line (quotes,
  redirections, operators, globs, tilde, revision paths) and refuses paths that leave the workspace or
  name a sensitive file. The host shell is still not an OS sandbox: a project script can do what the
  developer's own process could do, which is why `--executor docker` exists.
- `shell` runs one bounded command through the selected executor. With `--executor docker` it runs in
  the executor's ephemeral snapshot and its file changes are discarded; with the host executor it runs
  directly on the host and is not an OS sandbox. Verification still runs through the same authorization
  gate and executor.
- `--mode read-only` refuses `write`/`edit` instead of applying them.
- `read` accepts an optional `offset` (1-based line) and `limit` (lines); a result reports the next
  offset when more of the file remains, so a large file can be read in ranges instead of re-reading its
  head. A single read is bounded to 400 lines / 6,000 characters.
- Defaults: 8 model turns, 1 protocol repair, 2 verification repairs, 40 search results, 200 list
  entries, 12 KB per tool result. Exhausting a budget fails the run with an explicit code.
- Before the first model call, Kodevra gathers a bounded deterministic bootstrap locally (`inspect` with the task
  as focus: project type, layout, entry points, test files, symbols, git status, candidate verification commands)
  and sends it once. The model does not spend turns asking for the tree and manifests.
- Mutations are counted from what the tool actually changed, not from the action name: a `write`,
  `edit` or `apply_patch` always reports its files, `shell` diffs a workspace fingerprint before and
  after the command, and `batch` unions its operations' real changes. An inspection command is not a
  mutation, so it never invalidates a passing verification or uses a repair attempt.
- Repairs are coalesced: verification runs on an explicit `verify`, on `finish`, or when an action
  carries `complete: true`, not after every edit, so a multi-step repair does not exhaust verification
  attempts. Changing files resets the attempt budget; only repeated failures against the same workspace
  make it terminal. A passing completion ends the run immediately.
- Model turns are the expensive resource. Bootstrap, batched inspection, ranged reads, multi-file
  patching, patch summaries, verification and output compaction all happen locally; `economy` in the run
  result/outcome records model turns, local operations, verification runs and bootstrap cost.
- The deduped TASK STATE block carries only substantive changes; the changing turn/repair budget rides as
  one short line so it cannot force the whole block to be resent every turn.
- The turn budget is per run and adjustable: `--max-turns <n>` accepts 1-40, so a complex task can use
  20 turns while the hard ceiling keeps the browser loop finite. Values outside that range are refused
  before the run starts rather than silently clamped.
- Verification stays Kodevra-owned: `--verify` is authorized before the run, and a successful verification
  is reused only while the workspace has not been edited since. Any later edit forces the gate to run again.
- Test files and test-runner config may be changed by the agent. Under balanced/autonomous policy Kodevra
  re-authorizes that test surface (bounded, with a `verification_reauthorized` event in the run log);
  strict runs and manifest/lockfile changes still require an explicit `--reapprove <fingerprint>`.
- A new run starts a fresh ChatGPT conversation (`newSession`). `kodevra run -c` reuses the conversation
  recorded for that workspace in `~/.kodevra/chatgpt-web-sessions.json` (an opaque id only).

## What the branch proves, and what it does not

Proven in this checkout, without ChatGPT:

- the strict action parser, one-shot correction, repository tools, traversal and sensitive-file refusal,
  read-only refusal, turn/verification budgets, continuation mapping, session-store contents and
  bridge auth/health handling (`test/chatgpt-web.test.js`);
- a full offline run against a scripted bridge on loopback: read -> write -> verify -> finish, real file
  change, `PASS (exit 0)` and `Status VERIFIED` (`kodevra run -p chatgpt-web`).

Not proven here:

- a real ChatGPT conversation. This machine has the real bridge running, but no browser extension client
  is attached and no signed-in ChatGPT tab was driven by this session. `kodevra doctor -p chatgpt-web`
  therefore reports `No selected browser extension client connected` and the run stops before any model
  call.
- reliability. chatgpt-bridge is browser automation and breaks when ChatGPT's DOM changes. It is not an
  OpenAI-supported interface, and normal ChatGPT product limits still apply.
