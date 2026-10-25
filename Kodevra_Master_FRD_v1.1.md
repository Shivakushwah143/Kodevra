---
title: "KODEVRA — Master Functional Requirements & Technical Design"
subtitle: "Local-first, bring-your-own-account autonomous coding agent"
author: "Product & Technical Architecture"
date: "25 October 2026"
version: "1.1 — Architecture and Technology Stack"
---

# KODEVRA

## Master Functional Requirements Document (FRD)

**Version:** 1.1 · **Date:** 25 October 2026 · **Status:** Architecture baseline for prototype, not production approval  
**Working product name:** **Kodevra**. The final brand name, domain and trademark are **not yet locked**.  
**Primary delivery target:** a demonstrable autonomous coding loop in **three focused engineering hours**; this is a target with technical prerequisites, not a guaranteed outcome.  
**Intended audience:** product founder, architect, engineer, coding-agent implementer, designer, QA.

> **Product promise:** Your models. Your code. Your agent. A local-first coding assistant that inspects repositories, edits files, runs tests and verifies its work while the developer retains control over execution and provider accounts.

## 0. Executive summary

Kodevra is an independently branded **Codex-style local coding agent**. It does not train or host its own foundation model. It composes (a) an established agent runtime, (b) a replaceable model-provider interface, and (c) a local user-facing experience. The first implementation uses **OpenCode** as the agent harness and evaluates **FreeDeepseekAPI** as an experimental DeepSeek Web compatibility bridge. Gemini (Orcus) and ChatGPT plan-backed access are subsequent integrations subject to functional and permission checks.

The goal is **functional resemblance in the read → reason → edit → execute → test → verify workflow**, not a promise of equivalent Codex model quality, unlimited tokens, unrestricted subscription sharing, or production readiness.

**Highest-priority architecture rule:** exactly **one tool-execution owner**—the coding-agent harness. The model adapter must only return text and proposed tool calls; it must not directly modify files or execute arbitrary shell commands.

## 1. Decision register — what is and is not locked

| ID | Decision | State | Consequence |
|---|---|---|---|
| ADR-01 | Build a branded, independently positioned coding-agent product | **Locked** | Original brand and onboarding; transparent attribution to open-source dependencies. |
| ADR-02 | Local-first CLI/TUI is the first experience | **Locked** | No hosted execution service required for the prototype. |
| ADR-03 | Reuse the agent harness instead of rebuilding filesystem/terminal/testing | **Locked** | Select **OpenCode** as baseline; do not fork until unavoidable. |
| ADR-04 | Reuse an existing DeepSeek Web proxy | **Locked approach; conditional implementation** | Evaluate `dekrezz/FreeDeepseekAPI` first; `atharvotech/FreeDeepseekAPI-EN` is reference/alternative. |
| ADR-05 | Use a standard compatible-model boundary | **Locked** | Local OpenAI-compatible endpoint, adapter can be replaced later. |
| ADR-06 | Developer owns provider account and credentials | **Locked** | Local credentials; no central cookie warehouse. |
| ADR-07 | User can choose DeepSeek, Gemini, ChatGPT where permitted | **Locked product goal, staged delivery** | DeepSeek first; Gemini/ChatGPT are *not* acceptance dependencies of 3-hour prototype. |
| ADR-08 | Agent owns tools and approvals | **Locked** | Explicit permissions; proposal → validation → authorized execution. |
| ADR-09 | Three-hour proof-of-concept has one required end-to-end coding test | **Locked target** | Real file changes, real tests and evidence; no simulated success. |
| ADR-10 | Kodevra is the final brand | **Open** | Working name only; verify names, GitHub/npm/domain/trademarks before launch. |
| ADR-11 | ChatGPT plan usage can be monetized as a gated feature | **Rejected** | SIWC plan-backed usage must remain accessible without paid upgrade; separate premium functionality may require legal/product review. |
| ADR-12 | DeepSeek Web can be sold as unlimited inference | **Rejected** | Provider limits, permission and undocumented protocol make this unsubstantiated. |

### 1.1 Primary foundation assessment

- **OpenCode** — active open-source coding agent with provider configuration, tools and CLI; MIT-licensed at time of research. Primary harness. [S1], [S2]
- **dekrezz/FreeDeepseekAPI** — local DeepSeek Web proxy that *documents* OpenAI-compatible chat, tools, agent sessions, `npm run setup:agents`, and OpenCode setup. **Preferred integration experiment**, not independently validated here. Apache-2.0 license advertised. [S3]
- **atharvotech/FreeDeepseekAPI-EN** — related English adaptation of an earlier project; useful alternate/reference, not another service to run in parallel by default. [S4]
- **Orcus DeepSeek / Gemini** — documented web-session SDKs; alternative adapter family, not required for P0. [S5]
- **ChatGPT** — OpenCode documents a ChatGPT account authentication route; **our own branded app** must separately meet OpenAI SIWC eligibility, usage and branding rules. Using existing OpenCode authentication does not convey unrestricted rights to repackage or resell it. [S2], [S6], [S7]

## 2. Product vision, audience and differentiation

### 2.1 Product vision

**For** individual software developers and small engineering teams, **Kodevra** is a local-first coding agent **that** automates a verified development loop **unlike** a generic AI chatbot, **because** it operates against real repository files and returns evidence of work performed.

### 2.2 Primary personas

| Persona | Goal | First-release journey |
|---|---|---|
| Solo full-stack developer | Fix bugs and ship features faster | Install → connect a permitted provider → open project → run task → inspect diff. |
| AI power user | Bring their preferred supported provider | Select provider/model → diagnose connection → run coding loop. |
| Security-conscious developer | Avoid sending credentials to a SaaS intermediary | Keep sessions local → restrict commands → review generated changes. |
| Team lead (later) | Consistent coding workflows and policy | Shared instruction templates, usage analytics and approvals. |

### 2.3 Competitive positioning

**Category:** autonomous AI coding agent / developer productivity.  
**Not:** an unlimited-tokens seller, a foundation model, a generic chat wrapper, or a copy of Codex branding.  
**Differentiation hypothesis:** local-first BYOA, provider-agnostic interface, rigorous verify-before-done workflow, transparent provider/status/error diagnosis, extensible workflows.

### 2.4 Prototype success metric

A real developer asks Kodevra to fix a known defect in a disposable Git repository. The system reads the correct files, changes code, invokes a real test command, and shows passing results plus the diff. A failed test correctly reported as failed is preferable to a fabricated green check.

## 3. Scope and release boundaries

| Capability | P0: 3-hour prototype | P1: developer alpha | V1: product |
|---|---|---|---|
| Branded launch/welcome display | Required | Polished | Full identity |
| Local repository selection | Required | Multi-workspace | Project switcher |
| DeepSeek via existing local proxy | Attempt + verify | Supported if authorization resolved | Conditional release |
| Official API provider fallback | Required for dependable baseline if available | Required | Required |
| ChatGPT through eligible sign-in | Optional existing-client validation | Eligibility review | Approved integration only |
| Gemini Orcus adapter | Not in critical path | Experimental | Conditional release |
| Read/search/edit files | Reuse, demonstrate | Harden | Full |
| Tool-call loop | Demonstrate | Reliability tests | Monitoring |
| Terminal and tests | Demonstrate | Sandboxed modes | Policies/audit |
| Change review / Git diff | Required | Rich diff | Review tooling |
| Sessions and resume | Use harness default | Explicit resume | Cross-project management |
| Premium billing / team dashboard | Out of scope | Discovery only | Compliance-gated |
| Cloud agent execution | Out of scope | Out of scope | Separate architecture |

**Non-goals for P0:** new agent framework, distributed job queue, shared inference infrastructure, proprietary model training, central authentication database, payment gateway, VS Code extension, web dashboard, vector database, automated dependency upgrades, unrestricted autonomous production deployment.

## 4. End-to-end user journeys

### J-01. First launch and onboarding

**Preconditions:** Windows PowerShell or compatible terminal, Node.js/Git, local project path, an eligible provider account or official API key.  
**Path:** 1. Developer installs Kodevra launcher. 2. Runs `kodevra`. 3. Sees brand, local-first notice and a short setup checklist. 4. Chooses model provider. 5. Kodevra invokes a provider-specific **supported authentication or configuration flow**, without collecting passwords in Kodevra's UI. 6. `doctor` checks local endpoint, credentials/config visibility and selected model. 7. Developer opens project. 8. Welcome screen confirms readiness.  
**Exceptions:** missing Node, proxy absent, sign-in unsupported, expired session, disallowed provider usage → actionable diagnosis, never silent fallback to a different account.  
**Acceptance:** developer can identify selected provider/model, endpoint class (official API or experimental web adapter), connection state and project before submitting a task.

### J-02. Developer fixes an existing bug

1. From a Git-tracked test repository, developer enters a natural-language task. 2. Harness inspects relevant files. 3. AI proposes structured tool calls. 4. Harness validates tool name, arguments and permissions. 5. Developer approves risky operations. 6. Files are read/edited. 7. Harness executes the narrow relevant test command. 8. Failed tests are returned to model for bounded repair. 9. Harness displays diff, test results and any remaining uncertainty. 10. Developer accepts or reverts changes using the underlying Git workflow.  
**Acceptance:** at least one real read, one real edit, one actual command, visible output and inspectable diff; report distinguishes tested vs untested.

### J-03. Build a new feature

1. Developer gives scope and acceptance criteria. 2. Agent scans project conventions. 3. Agent creates a concise plan (for nontrivial work). 4. Agent implements minimal changes. 5. Agent runs typecheck/tests. 6. Developer reviews diff and can request refinement.  
**Acceptance:** no irrelevant rewrite, no invented dependencies and no success claims without evidence.

### J-04. Human approval and cancellation

1. Model requests `run_command` / potentially destructive edit. 2. UI shows exact command, current directory, affected scope and risk. 3. User chooses **Allow once**, **Deny**, or **Stop task**. 4. Agent never executes denied actions. 5. Cancellation interrupts tool/model operation as supported and preserves already-completed changes for review.  
**Acceptance:** deny prevents action and is reflected in the transcript; permissions are enforced by harness, not a system prompt.

### J-05. Provider switches and authentication failure

1. Developer opens model selector. 2. UI displays provider, model, connection method, permitted status and known limitations. 3. Developer changes provider explicitly. 4. Context transfer is best-effort; the UI warns if message/tool compatibility differs. 5. If session expires, show `AUTH_EXPIRED` and exact recovery instructions. 6. Do not replay failed writes automatically.  
**Acceptance:** no silent model substitution; no credential displayed in logs.

### J-06. Resume and history

1. Developer reopens workspace and selects a local harness session. 2. System shows previous user instructions, tool results and change state. 3. Developer can continue with a follow-up. 4. Prior context that may have changed is revalidated from current repository state.  
**Acceptance:** no claim that conversation memory equals live repository truth.

### J-07. Failed run / troubleshooting

1. Failed model call, malformed tool request, timeout or test failure appears with category. 2. Developer sees whether it was **provider**, **adapter**, **agent tool**, **application/test**, or **permission** failure. 3. `kodevra doctor` reports health without secrets. 4. User can retry safely after fixing the problem.  
**Acceptance:** failure origin visible; missing evidence is explicitly stated.

## 5. Functional requirements

**Priority definition:** P0 = required proof-of-concept behavior; P1 = alpha; P2 = subsequent release. *Specification means intended behavior, not already implemented.*

| ID | Priority | Functional requirement | Acceptance check |
|---|---|---|---|
| FR-001 | P0 | Launch branded Kodevra CLI/TUI | Brand, workspace, status and active model visible. |
| FR-002 | P0 | Select local Git project | Agent operates only in selected working directory by default. |
| FR-003 | P0 | Configure at least one reachable model | Real request-response confirmed, not a mocked success. |
| FR-004 | P0 | Integrate existing DeepSeek-compatible proxy experimentally | HTTP health + model response + tool round trip verified separately. |
| FR-005 | P0 | Keep agent execution under OpenCode | One tool owner; bridge never directly executes file/shell tools. |
| FR-006 | P0 | Read/search project files | Verified tool log references real repository path. |
| FR-007 | P0 | Create/edit files with diff visibility | `git diff` identifies actual changes. |
| FR-008 | P0 | Execute project-scoped terminal commands | Command + exit code/output visible. |
| FR-009 | P0 | Run tests and report evidence | Report includes exact command and pass/fail outcome. |
| FR-010 | P0 | Enforce tool approval | Denied command is not executed. |
| FR-011 | P0 | Error classification and no false completion | Specific error shown; no fabricated PASS. |
| FR-012 | P0 | Local-only secret handling | Session secrets excluded from telemetry, committed files and logs. |
| FR-013 | P0 | Connection diagnostics | Show backend/proxy availability and auth mode, with redaction. |
| FR-014 | P1 | Stream chat and tool progress | Progressive events and cancellation state. |
| FR-015 | P1 | Explicit provider/model switcher | Model capability mismatch flagged. |
| FR-016 | P1 | Resume local sessions | Restores task history without trusting stale file contents. |
| FR-017 | P1 | Scoped automation modes | Read-only, ask-to-edit, workspace-write. |
| FR-018 | P1 | Test failure repair with bounded iterations | Stops when repeated failures or max iterations reached. |
| FR-019 | P1 | Tool-call schema validator | Malformed/unknown tools rejected with no execution. |
| FR-020 | P1 | Provider-specific feature negotiation | Detect no-tools/no-stream/no-images where applicable. |
| FR-021 | P1 | Context compaction strategy | Preserve current instructions and essential tool results. |
| FR-022 | P1 | Provider health / rate limit / expiry messaging | Actionable and distinct from app test failure. |
| FR-023 | P1 | Gemini adapter evaluation | Separate pilot, only if usable and authorized. |
| FR-024 | P1 | ChatGPT integration eligibility validation | No paid gate on SIWC-backed usage; supported flow only. |
| FR-025 | P2 | Packaged Windows/macOS/Linux launcher | Supported install/update/uninstall flows. |
| FR-026 | P2 | Team policies / project instructions | Shared policies without remote model secrets. |
| FR-027 | P2 | Premium local developer workflow features | Paid services do not violate provider/SIWC terms. |
| FR-028 | P2 | Dashboard & analytics | Explicit opt-in; private content redacted. |
| FR-029 | P2 | Distribution and software updates | Signed distributions and upstream compatibility tests. |
| FR-030 | P2 | Guided rollback / checkpoints | Reliable undo semantics documented by operation. |

## 6. Non-functional requirements and guardrails

| ID | Requirement | P0 interpretation |
|---|---|---|
| NFR-01 | Local-first privacy | No default upload of credentials or complete repositories to Kodevra servers. **Prompts/code may still be sent to the selected model provider.** |
| NFR-02 | Access control | No command executed solely because the model said to execute it. |
| NFR-03 | Safety | Terminal actions in disposable workspace; destructive commands ask for approval. |
| NFR-04 | Observability | Provider ID, request ID, tool, duration, exit code, error category; never tokens/cookies. |
| NFR-05 | Maintainability | No source modification to OpenCode or proxy unless a tested API gap requires it. |
| NFR-06 | Replaceability | Swap compatibility adapter without rewriting agent tools. |
| NFR-07 | Truthful completion | PASS requires executed evidence; unknown reported UNKNOWN. |
| NFR-08 | Availability | Session expiration and upstream failures become visible degradations, not infinite retries. |
| NFR-09 | User control | Stop tasks, choose provider, inspect changes, deny commands. |
| NFR-10 | Licensing | Retain MIT/Apache notices; review trademark and redistribution obligations. |

**Do not set invented model context windows, speed SLAs, or unlimited quotas.** Read actual capabilities from configured adapter/provider when available; otherwise use conservative caps and surface uncertainty.

## 7. Technical design

### 7.0 Technology stack, rationale, and selection status

**Design objective:** prioritize an end-to-end verified coding loop in three focused engineering hours. Reuse mature agent tools; do not introduce infrastructure solely for theoretical future scale. Node.js is the runtime for *Kodevra-owned integration scripts and the DeepSeek proxy*, not a claim that the installed OpenCode executable is implemented on Node.js.

| Layer | Selected technology | Reason / boundary | Delivery status |
|---|---|---|---|
| Language for new glue code | **TypeScript** | Shared types for configuration, adapters, validation, CLI scripts. Avoid introducing Python for the same responsibilities. | Locked for any new application code; minimize P0 code |
| Integration runtime | **Node.js 22+ LTS** | Meets the proxy's documented Node.js 18+ minimum; mature Windows tooling and ecosystem. | Locked P0 tooling; preflight-check installed version |
| Dependency/package manager | **npm** | Matches proxy scripts (`npm run auth`, `npm run setup:agents`) and minimizes setup steps. | Locked P0 |
| Agent runtime / tools | **OpenCode, pinned compatible release** | Already provides coding loop, workspace access, commands, approvals, sessions, git-aware workflows. | Locked foundation; exact major/version resolved in preflight |
| Local DeepSeek adapter | **dekrezz/FreeDeepseekAPI** | Existing loopback proxy, OpenAI-compatible API, documented OpenCode profile setup. | First experimental candidate; live tests required |
| Model protocol | **HTTP JSON, OpenAI-compatible requests + SSE** | Standard boundary for the harness; supports a replaceable model/provider implementation. | Locked architectural interface; test actual request/tool schemas |
| Gemini adapter | **Orcus Gemini** | Avoid custom web request reverse engineering. | P1 candidate, contingent on terms and reliable tool calls |
| ChatGPT adapter | **Official supported sign-in/API flows** | Do not collect ChatGPT browser cookies; respect eligible subscription/provider policies. | P1; support depends on product eligibility and permissions |
| Terminal experience | **Existing OpenCode TUI, Kodevra launcher/theme/config** | Fast usable keyboard-first UI without writing our own rendering engine. | Locked P0 prototype approach; full white-label branding not guaranteed |
| Persistent state | **Local filesystem + harness-native sessions** | No separate database for one local developer. | Locked P0 |
| Secrets | **Provider-specific local protected storage** | Keep account tokens/cookies on developer workstation, never in Git or transmitted to Kodevra backend. | Security requirement |
| Source control | **Git** | Real diffs, review, optional safe rollback and test verification. | Locked |
| Tests | **Node built-in tests plus disposable repo fixture** | Minimal tooling overhead; validate actual write → test → fix flow. | Locked P0 |
| Containerization | **None for P0; sandbox/container later** | Avoid Docker setup in initial demonstration; add isolation before running untrusted work. | Deferred |
| Database/server backend | **None for P0** | Multi-user accounts, payments, syncing and telemetry are out of MVP scope. | Deferred |
| Marketing and future UI | **React + Vite + Tailwind, only if justified** | Fast responsive design after the agent is demonstrably useful. | Candidate, not locked and not P0 |

**Version compatibility decision:** OpenCode currently has V1 and V2 provider configuration variants. The FreeDeepseekAPI-generated profile must be tested against the *installed and pinned* OpenCode version. Do not copy V1 `provider` / `@ai-sdk/openai-compatible` snippets into a V2 `providers` / `@opencode/ai/providers/openai-compatible` installation without checking its documented schema. Prefer the upstream `setup:agents` generation and verify the resulting config. See [S2], [S3], and [S9].

**Branding honesty:** a themed launcher in front of unmodified OpenCode is an early Kodevra prototype, not a fully independently branded TUI. A deeply white-labeled distribution may require a supported embedded interface or a maintained fork after checking notices, licenses and trademark use.

**Local runtime inventory (P0):** Windows PowerShell, Git, Node.js 22+ LTS, Google Chrome for supported DeepSeek account sign-in, OpenCode installed at an explicitly recorded version, FreeDeepseekAPI bound to `127.0.0.1:9655`; developer-owned provider account. No React/Next.js frontend, Docker, hosted backend or SQL database.

### 7.1 Logical architecture

```text
                       KODEVRA (local developer machine)
        +-----------------------------------------------------------+
        | Kodevra launcher / brand / onboarding / doctor            |
        |                       |                                   |
        |                  OpenCode Harness                         |
        |   task context | session | permissions | file/terminal    |
        |                       | model request / tool results       |
        |              Provider-compatible boundary                |
        |                       |                                   |
        |       +---------------+------------------+                |
        |       |               |                  |                |
        | DeepSeek proxy    Gemini adapter    OpenAI official*      |
        | (experimental)    (experimental)    (eligible flows)     |
        +-------|---------------|------------------|----------------+
                |               |                  |
         DeepSeek Web       Gemini Web        OpenAI service
       * Official API fallback available separately where configured.
```

**Architectural separation:** the compatibility proxy owns provider transport/session translation; OpenCode owns developer task state, tool execution, approvals, diff and test results. The launcher owns product identity and setup, not agent intelligence.

### 7.2 Physical deployment (P0)

Single Windows developer workstation: Node.js + Git + local OpenCode installation + local DeepSeek proxy bound to `127.0.0.1:9655` + local Kodevra launcher/config files. No backend cluster, Docker requirement, SQL/NoSQL DB or public API server. [S3]

**Loopback rule:** proxy binds to localhost. If optional `PROXY_API_KEY` is configured, it protects the local proxy endpoint; it is **not** a provider API key. Do not expose the proxy publicly. Chrome/browser sessions are handled by the adapter's documented local process.

### 7.3 Runtime state and data ownership

| Artifact | Owner | Location / rule |
|---|---|---|
| Repository files | Developer | Selected workspace; never globally writable by default. |
| Agent conversation/tool history | OpenCode harness | Existing local session mechanism. |
| Proxy-to-DeepSeek conversation mapping | DeepSeek adapter | Local adapter state; never treat as source of truth for files. |
| Model connection parameters | Kodevra configuration | Local project/user settings; secret references rather than values. |
| Login/session cookies | Provider adapter/supported auth flow | Protected local storage only; excluded from commits, UI and crash reports. |
| Product branding | Kodevra | Launcher copy/themes/config; preserve open-source notices. |
| Test logs | Harness | Local, redacted if exported. |

### 7.4 Provider contract (canonical internal adapter shape)

```ts
// Logical interface, not an assertion about OpenCode's current SDK types.
type ProviderCapabilities = {
  text: boolean;
  streaming: boolean;
  nativeToolCalling: boolean;
  emulatedToolCalling: boolean;
  imageInput: boolean;
  contextLimit?: number;
};

type ProviderStatus = {
  id: string;
  model: string;
  connected: boolean;
  mode: 'official-api' | 'authorized-subscription' | 'experimental-web';
  capabilities: ProviderCapabilities;
};
```

**Rule:** do not build a second agent runtime around this shape. Use OpenCode provider configuration first. A custom adapter module exists only if live contract tests fail and a small compatibility shim demonstrably resolves them.

### 7.5 Model tool-call protocol

1. OpenCode supplies conversation messages and available tool schemas.
2. Compatible provider endpoint converts those into the upstream protocol.
3. Upstream response is normalized into `assistant` text or structured tool-call proposal(s).
4. OpenCode validates named tool and JSON arguments, applies permission rules, and executes the allowed tool.
5. Tool output and correlation IDs return to OpenCode and through provider to the model.
6. Repeated loop stops on successful completion, denial, cancellation, timeout or bounded repair threshold.

**DeepSeek Web caveat:** the selected proxy describes **prompt-emulated**, not native web-provider function calling. Incorrect JSON, truncated tool calls and mixed model commentary are expected failure classes. The harness must not interpret arbitrary text as executable commands. [S3]

### 7.6 Model endpoint integration — reference configuration

The preferred proxy documents a loopback OpenAI-compatible URL and a setup script. **Use its generated OpenCode configuration rather than hardcoding a possibly stale schema**:

```powershell
# In a disposable working directory, AFTER reviewing the repository and license:
git clone --branch stable https://github.com/dekrezz/FreeDeepseekAPI.git
cd FreeDeepseekAPI
npm run auth
npm run dashboard
npm run doctor
npm run setup:agents -- --target opencode
```

The README states the proxy base URL is `http://127.0.0.1:9655/v1` and describes its `setup:agents` configuration flow. These commands are **documented upstream**, not verified in the user's workstation. [S3]

The OpenCode docs distinguish `@ai-sdk/openai-compatible` for chat-completions-style endpoints from `@ai-sdk/openai` for Responses-style endpoints. The exact model mapping must be taken from the installed proxy's capabilities list, not invented. [S2]

### 7.7 Request lifecycle and evidence

```text
User prompt → harness context → provider request → AI tool proposal
             → schema validation → permission decision
             → tool execution → stdout/stderr + exit code
             → model continuation → final summary
             → test result + git diff + unresolved issues
```

Minimum event fields: `run_id`, `timestamp`, `provider_id`, `model_id`, `tool`, `permission`, `duration_ms`, `exit_code`, `failure_origin`, `failure_code`, `evidence_ref`. Do not log prompt bodies by default.

### 7.8 Failure taxonomy

| Code | Origin | Product behavior |
|---|---|---|
| `PROXY_UNAVAILABLE` | Adapter | Show local startup/health instructions. |
| `AUTH_EXPIRED` | Provider auth | Request supported re-authentication; preserve task. |
| `RATE_LIMITED` | Upstream | Explain restriction; retry only per policy. |
| `MODEL_UNAVAILABLE` | Provider | Offer explicitly approved model alternative. |
| `MALFORMED_TOOL_CALL` | Adapter/model | Reject execution; bounded retry and clear report. |
| `TOOL_DENIED` | User/harness | No command execution; continue or stop as appropriate. |
| `COMMAND_FAILED` | Project environment | Show exit code/stderr; offer fix iteration. |
| `TEST_FAILED` | Code under test | Distinguish from adapter errors. |
| `CONTEXT_EXHAUSTED` | Model/proxy | Compact context with preservation rules or stop. |
| `CANCELLED` | Developer | Stop eligible operations and show partial changes. |
| `PROVIDER_NOT_PERMITTED` | Compliance gate | Disable unsupported adapter path; provide approved alternative. |

### 7.9 Security and permission boundaries

- Treat web-session cookies and bearer authorization as **password-equivalent secrets**; use supported auth mechanisms and minimum necessary permissions.
- Never collect provider credentials on a hosted website or commit them to Git.
- Bind the proxy to loopback; reject externally reachable startup defaults.
- Workspace allowlist for file tools; ask before editing outside workspace.
- Ask before destructive shell, package installation, network side effects, deployment, force pushes and credential reads.
- Recognize untrusted repository text, web results and logs as data rather than higher-priority instructions.
- Scrub credentials, tokens and secrets from transcripts, error reports, telemetry and shared demos.
- DeepSeek/Orcus web adapters require separate rights/terms review; do not add account rotation or techniques designed to bypass rate limits.
- ChatGPT SIWC tokens use supported OAuth only, remain in user-controlled storage, and cannot be resold/pooled or gated behind payment. [S6]

### 7.10 Repo architecture — thin product shell

```text
kodevra/
├── README.md
├── LICENSES/                       # upstream attribution
├── apps/
│   └── cli-launcher/               # Kodevra brand, onboarding, doctor
├── config/
│   ├── model-profiles.example.json
│   └── engineering-rules.md
├── integrations/
│   ├── opencode/                   # generated/provider config integration
│   └── deepseek-proxy/             # bootstrap scripts, not proxy fork
├── docs/
│   ├── FRD.md
│   └── provider-policy.md
├── scripts/
│   ├── doctor.ps1
│   └── smoke.ps1
└── test-fixtures/
    └── auth-bug-demo/              # disposable seeded failing test
```

Subdirectories are **planned organization**, not claims that source files exist yet. Keep node dependencies and repository forks external until needed.

## 8. Visual and interaction design

### 8.1 Brand direction

**Positioning:** minimal technical product like Codex/Cursor with a distinctive premium futuristic edge.  
**Working wordmark:** `kodevra` (lowercase) and a restrained geometric `K` terminal icon.  
**Voice:** precise, factual, calm, engineer-focused. Avoid exaggerated AI/robot/cyberpunk visuals and false green success states.

| Design token | Value | Usage |
|---|---|---|
| Surface / shell | `#0B1018` | Primary dark application background |
| Elevated surface | `#131D2B` | Panels and dialogs |
| Border | `#293548` | Dividers and tool rows |
| Accent | `#79A6FF` | Active model, links, selected states |
| Text primary | `#F1F5FC` | Main content |
| Text muted | `#A8B6C9` | Metadata and descriptions |
| Success | `#47C695` | **Verified** events only |
| Warning | `#F0BF65` | Approval/recoverable warning |
| Error | `#F17D8C` | Failure and denied actions |
| Font | Inter / system sans; JetBrains Mono / system mono | Body and code/terminal |
| Radius / spacing | 8–12 px; 8 px spacing grid | Restrained, consistent rhythm |

**Accessibility:** keyboard-first; no color-only status; WCAG AA contrast objective for key text; command focus visible; compact terminals supported by line wrapping rather than clipping.

### 8.2 Screen inventory

| Screen | Purpose | Critical elements |
|---|---|---|
| V-01 Welcome | Identify product and readiness | Brand, workspace, provider, connect/new task |
| V-02 Connect provider | Select owned account/connection | Official vs experimental label, permissions, link to terms |
| V-03 Task workspace | Execute coding task | Prompt, live events, active model, working directory |
| V-04 Tool approval | Enforce control | Exact command/path, allow once, deny, stop |
| V-05 Verification | Confirm result | Tests/command output, changed files, diff, unresolved issues |
| V-06 Doctor/errors | Resolve failures | Origin, diagnostic evidence, recovery steps |

### 8.3 Terminal wireframes

**V-01 — Welcome / setup**

```text
┌─────────────────────────────────────────────────────┐
│ K  kodevra                             local-first  │
│                                                     │
│ Your models. Your code. Your agent.                  │
│                                                     │
│ Workspace  C:\projects\demo-api                      │
│ Provider   DeepSeek / experimental-web              │
│ Status     Connection check required                │
│                                                     │
│  [Connect provider]   [Run diagnostics]              │
│                                                     │
│ > Describe a coding task...                         │
└─────────────────────────────────────────────────────┘
```

**V-03 / V-04 — Active task and approval**

```text
┌─────────────────────────────────────────────────────┐
│ kodevra  / demo-api        model: deepseek-v4-flash  │
├─────────────────────────────────────────────────────┤
│ > Fix auth bug and run the relevant tests            │
│ ✓ Read src/auth.ts                                   │
│ ✓ Read test/auth.test.ts                             │
│ ● Proposed command: npm test -- auth.test.ts         │
│   Working dir: C:\projects\demo-api                  │
│                                                     │
│  [Allow once]    [Deny]    [Stop task]                │
├─────────────────────────────────────────────────────┤
│ Explain changes...                                  │
└─────────────────────────────────────────────────────┘
```

**V-05 — Verified completion**

```text
┌─────────────────────────────────────────────────────┐
│ TASK RESULT                                          │
│                                                     │
│ ✓ Changed: src/auth.ts                               │
│ ✓ Tests: 8 passed / 0 failed                         │
│   Command: npm test -- auth.test.ts                  │
│   Diff: 1 file changed                              │
│                                                     │
│ Review diff  ·  Run more tests  ·  Continue          │
│                                                     │
│ Note: Only the specified test suite was run.         │
└─────────────────────────────────────────────────────┘
```

These are **proposed visual contracts**, not screenshots of implemented software. The proof of concept may use OpenCode's existing TUI with a Kodevra wrapper/banner; replacing its full interface is deferred.

### 8.4 Interaction behavior

- Brand appears at entry/launcher; never claim OpenCode is independently authored by Kodevra.
- Provider badges show `OFFICIAL`, `ELIGIBLE SIGN-IN`, or `EXPERIMENTAL WEB` distinctly; do not use bright decorative badges everywhere.
- Tool execution runs show: **Requested → Approved/Denied → Running → Exit result**.
- Completion indicators appear only when backed by actual tool/test evidence.
- Switching models does not change provider silently during a running task.
- Error panels favor a one-line cause and one next action; detailed logs expand on demand.
- Use native CLI keyboard patterns (Enter submit, Esc cancel/close when supported, arrows select); adapt to underlying harness commands rather than promising custom interactions not implemented.

### 8.5 Future web marketing surface (not P0)

Dark hero: restrained K glyph, one-line promise, terminal screenshot/mockup, provider choice and local-first assurance; below: three-step workflow, verification proof, pricing/product differentiation (no promise of unlimited free AI). A web dashboard is **not** required for the initial end-to-end success.

## 9. Engineering roadmap, split into executable steps

### P0 — Three-hour assembly sprint

| Step / window | Work | Checkpoint / evidence | Gate |
|---|---|---|---|
| 0 · 00:00–00:15 | Inspect licensing, versions, machine prerequisites, official OpenCode baseline. | `opencode` runs in a disposable Git workspace. | Stop if runtime can't launch. |
| 1 · 00:15–00:35 | Run existing DeepSeek proxy locally using documented setup, inspect health/auth status. | Proxy reachable on loopback; no secrets logged. | If forbidden/blocked, use authorized official API fallback. |
| 2 · 00:35–01:00 | Use `setup:agents` or equivalent to configure OpenCode; test one real model completion. | Explicit provider/model recorded; actual response. | Don't implement extra provider. |
| 3 · 01:00–01:35 | Validate model → tool-call → harness read flow. | Real tool read, proper schema, no proxy tool execution. | No tool loop = blocker, do not claim agent works. |
| 4 · 01:35–02:15 | Execute known failing fixture, edit code, invoke real test. | Git diff and executed test output. | No fake success. |
| 5 · 02:15–02:45 | Fix critical integration failures; verify denial, missing auth, malformed response. | Short smoke results with PASS/FAIL. | Document unresolved blockers. |
| 6 · 02:45–03:00 | Minimal brand wrapper, setup/readme and recorded end-to-end proof. | One command launch + evidence summary. | Ship honest prototype status. |

**Timebox policy:** if the DeepSeek Web integration is unavailable, not permitted, or unstable at its checkpoint, retain a **working agent baseline on an authorized official provider** and mark the web adapter as `BLOCKED`. That is a useful partial result, not a successful DeepSeek BYOA integration.

### P1 — Usable developer alpha (after P0)

1. Package branded launcher + diagnostics across supported developer operating systems.
2. Add deliberate provider/model selector, capabilities checks and clear experimental badges.
3. Test streaming, structured tool-call idempotency/correlation, interrupted sessions and bounded retries.
4. Add file-path policy, approval UX and safe stop semantics.
5. Run at least 20 independently defined coding tasks against a stable baseline and compare functional success, time and cost.
6. Evaluate Gemini adapter and eligible ChatGPT sign-in separately; retain official API fallback.

### P2 — Commercial readiness (conditional)

1. Resolve distribution, license attribution, provider authorization and SIWC pricing restrictions.
2. Complete threat model, secret storage, terminal sandbox, credential revocation and incident procedures.
3. Confirm upstream version pinning/upgrade strategy and graceful provider fallback.
4. Implement optional paid **independent** enhancements only after validating what may legally be charged for.
5. Beta test on varied real repositories; publish transparent reliability numbers.

### Suggested first implementation branch plan

```text
main                         baseline/docs
feat/local-agent-foundation  stock OpenCode + disposable repo
feat/deepseek-adapter        local experimental provider config
feat/tool-loop-smoke         read → edit → test acceptance script
feat/kodevra-launcher        brand + doctor (only after working loop)
```

## 10. QA, UAT and definition of done

### 10.1 Mandatory P0 end-to-end scenario

**Fixture:** disposable Git repository with a deliberately broken Node.js authentication function and a failing automated test; no production credentials.

**Instruction:** “Inspect the authentication module, determine why the test fails, make the smallest fix, run the relevant tests, and explain the change with evidence.”

| ID | Observable proof | Required result |
|---|---|---|
| UAT-01 | Local Kodevra launcher enters agent interface | PASS |
| UAT-02 | Provider/model actually returns a non-mock response | PASS, provider named |
| UAT-03 | Harness reads the specific source/test files | PASS |
| UAT-04 | Harness writes/edits a real file | PASS |
| UAT-05 | `git diff` records intended change | PASS |
| UAT-06 | A real test command runs and produces exit code | PASS |
| UAT-07 | Failing test turns passing after change | PASS for full P0 success |
| UAT-08 | Denied command stays unexecuted | PASS |
| UAT-09 | Auth failure and tool format failures are truthful | PASS |
| UAT-10 | No secrets appear in logs or Git diff | PASS |

**Final output:** `PASS / FAIL / BLOCKED` per scenario; exact command/output; failing category; list of modified files; direct statement of what was not checked. A demonstration that only chats is **not** an end-to-end coding-agent proof.

### 10.2 Minimum benchmark after MVP

Use 20 tasks across fixing existing defects, adding bounded features, refactoring, and writing tests. Hold tasks, repos, time budgets and model/provider configurations constant. Score verified functional completion (primary), approval safety violations (hard fail), number of unnecessary files changed, latency, manual interventions, and error provenance. Compare against a reference agent; no unsupported claim of Codex equivalence.

## 11. Risks, dependencies and release gates

| Risk | Likelihood / impact | Mitigation / decision |
|---|---|---|
| DeepSeek Web protocol changes | High / High | Adapter isolation; quick diagnostic; approved API fallback. |
| Prompt-emulated tool calls malformed | Medium–High / High | Schema validation, fail closed, bounded repair. |
| Terms prohibit commercial web use | High / High | **Release gate:** written permission/legal review or remove adapter from paid product. |
| ChatGPT SIWC paid-gating violation | High / High | **Release gate:** never charge for plan-backed access; check official eligibility and branding. |
| OpenCode upstream breaking changes | Medium / Medium | Version pin, compatibility smoke, avoid invasive fork. |
| Model hallucinated tool success | Medium / High | Tool execution evidence and exit codes authoritative. |
| Credential leakage | Medium / Critical | Local storage, redaction, auth review, no hosted cookie vault. |
| Destructive terminal output | Medium / Critical | Scoped permissions, approval, disposable repos. |
| Three-hour target missed | Medium / Medium | Focus one provider/one fixture; visible blocker status. |
| Brand/domain collision | Unknown / Medium | Trademark/npm/domain search before final name approval. |

**Commercial release gate checklist:** selected model usage authorized; dependency licenses and trademarks checked; SIWC subscription rules respected; security and privacy reviewed; truthful marketing (no “unlimited free tokens”); clear evidence-based benchmarks.

## 12. Business model boundaries

The product may eventually monetize its independent engineering features: workflow templates, premium diagnostics, workspace management, enterprise policies, team collaboration and support. **No revenue projection is a product requirement.** BYOA is a cost-structure hypothesis, not a guarantee of zero inference cost.

Under the published OpenAI SIWC terms, users must be able to use their eligible ChatGPT plans through a connected application **without paying or upgrading** to a paid version of that application; tokens cannot be pooled or resold. For commercial proprietary integrations, confirm program eligibility and obligations before launch. [S6], [S7]

For DeepSeek Web, local individual-account integration demonstrated technically in an open-source proxy does **not** prove authorization for paid distribution or automated resale. DeepSeek's Terms of Use restrict certain automated copying/reverse engineering and unauthorized redistribution. [S8]

## 13. Open decisions — explicitly NOT locked

| ID | Decision pending | Owner / closure point |
|---|---|---|
| OD-01 | Final product name Kodevra / alternative | Founder, before public launch |
| OD-02 | One local proxy (`dekrezz`) vs compatible alternative | Architect, after live smoke results |
| OD-03 | DeepSeek Web adapter permitted in a paid commercial product? | Provider/legal, pre-release |
| OD-04 | Eligible ChatGPT sign-in in our own branded distribution? | Product/legal, pre-release |
| OD-05 | Gemini Orcus tool-call reliability/permissions? | Engineering, P1 validation |
| OD-06 | Whether to fork OpenCode for deep rebranding | Engineering/legal, only if wrapper insufficient |
| OD-07 | Paid plan packaging | Product, after legal review and user validation |
| OD-08 | Branding domains/package identifiers | Product, before publishing |

## 14. Reference sources (verified against public pages 25 October 2026)

- **[S1]** OpenCode GitHub: https://github.com/anomalyco/opencode
- **[S2]** OpenCode providers and compatible-provider guidance: https://opencode.ai/docs/providers
- **[S3]** dekrezz FreeDeepseekAPI repository, documented local endpoint and agent setup: https://github.com/dekrezz/FreeDeepseekAPI
- **[S4]** FreeDeepseekAPI-EN alternative: https://github.com/atharvotech/FreeDeepseekAPI-EN
- **[S5]** Orcus DeepSeek documentation: https://www.orcus.site/docs/deepseek
- **[S6]** OpenAI Sign in with ChatGPT Terms (29 September 2026): https://openai.com/policies/sign-in-with-chatgpt-terms/
- **[S7]** OpenAI open-source SIWC integration overview: https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt
- **[S8]** DeepSeek Terms of Use (27 March 2026): https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html
- **[S9]** OpenCode V2 current custom-provider reference (verify installed major): https://dev.opencode.ai/v2/docs/providers/

**Evidence quality note:** repository READMEs document claimed capabilities. This document did not independently authenticate to DeepSeek, execute OpenCode in the user's environment, or establish commercial permissions. These remain explicit verification and release tasks.

---

**End of FRD v1.1.** Locked product requirements and preferred architecture are defined above. Open decisions and provider permission constraints remain deliberately visible so implementers do not mistake a feasible prototype for an approved commercial system.
