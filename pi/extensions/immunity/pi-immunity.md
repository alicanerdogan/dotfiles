# pi-immunity — design document

A from-scratch re-imagining of `@aliou/pi-guardrails` as a **zero-dependency, inline Pi extension**: deterministic file/command safety checks, optional cheap-LLM analysis (via pi's headless mode), and a prompt/block flow built entirely on Pi's own UI primitives.

Reference: [`pi-guardrails.md`](pi-guardrails.md) documents the original this is modeled on.

---

## 1. Requirements → design mapping

| Requirement | Design |
|---|---|
| No external dependencies (exception: tree-sitter CLI for command ASTs) | Zero npm deps. Node built-ins only (`node:fs`, `node:path`, `node:child_process`, `node:crypto`). tree-sitter runs out-of-process as a CLI tool; graceful degradation with a user warning when absent |
| Cheap + fast LLM to analyze commands automatically | Optional analysis layer that calls pi in headless mode (`pi --mode json` subprocess) with configurable `llm.provider` / `llm.model` and an optional `llm.appendSystemPrompt`. Strictness comes from a custom verdict tool the model must call — schema-enforced `risk` + `outcome` (`ALLOWED` / `DENY` / `ASK_USER`) — not free-form JSON. Timeout + hard kill, never auto-denies by default |
| Global settings for pathnames + project-specific settings | Two files: `~/.pi/agent/immunity.json` (global) and `.pi/immunity.json` (project). List sections merge as unions; safety-first precedence |
| Use Pi's own UI primitives where possible | `ctx.ui.select` / `confirm` / `input` / `notify` / `setStatus` for the whole flow. No custom TUI components in the primary path |
| Hook when user input is expected | Settings-driven: `prompting.onPromptCommand` runs a user-configured bash command before an approval prompt opens (context via env vars; fire-and-forget with a 30s timeout). Same lifecycle observable via correlated bus events |
| User can give a reason for a blocked tool call | "Deny with reason" flow: `ctx.ui.input` captures the reason → attached to the block message, emitted in the block event, written to an audit log, optionally converted into a persistent rule |
| Testability | Node's built-in `node:test` runner — zero-dependency test framework: colocated `*.test.ts` with native type stripping, built-in `mock` (functions, methods, timers), `--watch`, coverage, name-pattern filtering |

---

## 2. Architecture

A multi-file **inline extension** (like the other extensions in this directory): an `index.ts` entry point plus helper modules. No `package.json`, no publishing, no `pi.extensions` field — it is installed by placing the directory in `~/.pi/agent/extensions/` or `.pi/extensions/`. The subprocess analysis file is a sibling module loaded explicitly via `--extension`. Tests use Node's built-in `node:test` runner — the zero-dependency constraint covers the test stack too.

### Analysis pipeline (per `tool_call`)

Stages run in order; the first decisive one wins. Every stage is optional and skippable — the extension is fully functional with only the deterministic checks.

```
tool_call (bash | file tools)
  │
  ├─ 1. Session grant check          allow-once / allow-session / persisted "always" grants
  ├─ 2. LLM verdict (optional)       headless pi subprocess; every bash command when llm.enabled
  │                                   (supervision: verdict recorded even when 3 blocks/prompts)
  ├─ 3. Deterministic rules          substring/regex patterns, pathname globs, built-in matchers —
  │     └─ 3b. tree-sitter AST       the floor: deny always blocks, prompt always asks
  ├─ 4. Decision                     allow │ notify │ prompt │ block
  ├─ 5. Prompt (ctx.ui primitives)   allow once/session │ deny │ deny with reason
  └─ 6. Outcome                      grant recorded, or block: { block: true, reason }
```

Key properties:

- **Interactive-only**: immunity targets interactive sessions. In no-UI runs (print/json modes, `ctx.hasUI` false) it skips its checks entirely — no prompting, no blocking. Its own analysis subprocess never loads the extension (`--no-extensions`) and has no approval flow by design.
- **LLM never auto-denies** (default): the model can flag risk; the user decides. Only deterministic rules auto-deny. Configurable via `llm.autoDeny`.
- **The deterministic floor is non-negotiable**: the rules run after the LLM and always win — an LLM `ALLOWED` can never override a rule `deny` or `prompt`. The LLM is a supervisor, not a bypass.
- **Everything observable**: every stage outcome emits on the event bus (see §5), so integrations can see *why* something passed or was blocked.

---

## 3. Settings

### Files and scopes

| Scope | Path | Honored when |
|---|---|---|
| Global | `~/.pi/agent/immunity.json` | always |
| Project | `<cwd>/.pi/immunity.json` (use `CONFIG_DIR_NAME`) | project trusted (`ctx.isProjectTrusted()`) |

### Merge semantics

- Scalar sections (`llm`, `prompting`, `treeSitter`, `audit`): project overrides global.
- **List sections are unions, global entries always apply** — a project file cannot weaken a global protection by editing its own file.
- `$schema` is stamped on save (hand-maintained `schema.json`, no codegen tooling since that would be a dev-time convenience only).

### Config

```jsonc
{
  "version": 1,
  "enabled": true,
  "pathnames": {
    "protected": [
      { "pattern": "**/.env*",            "mode": "modify", "onlyIfExists": true },
      { "pattern": "**/*.pem",            "mode": "read" },
      { "pattern": "/etc/hosts",          "mode": "read",  "regex": false }
    ],
    "allowed": [
      { "kind": "file",      "path": "~/.env.work" },
      { "kind": "directory", "path": "~/keys/test" }
    ]
  },
  "commands": {
    "patterns": ["git push --force-with-lease"],          // substring or regex
    "autoDenyPatterns": ["git push --force"],             // blocked without prompting
    "allowed": ["git push --force"],                      // exact commands always allowed (persisted always-grants)
    "useBuiltinMatchers": true
  },
  "llm": { "enabled": false, "provider": "",  // e.g. "ollama", "google" — empty = pi's default provider
           "model": "",            // e.g. "qwen3:4b" or "gemini-2.5-flash:low" — empty = provider default
           "appendSystemPrompt": "",  // extra instructions appended to the analyzer system prompt
                                       // (e.g. "never allow python") — passed via --append-system-prompt
           "piPath": "",           // pi binary path override (default: PATH lookup)
           "timeoutMs": 30000,
           "autoDeny": false },
  "treeSitter": { "binPath": "tree-sitter", "grammarDir": null },
  "prompting": { "requireConfirmation": true, "askReasonOnDeny": true,
                 "sessionGrants": true,
                 "onPromptCommand": "" },   // bash command run before an approval prompt opens
                                            // (see §5; e.g. osascript/notify-send)
  "audit": { "enabled": true, "file": "" }   // default: <project>/.pi/immunity.audit.jsonl; file can override
}
```

**Pathname precedence (safety-first):**

1. A target is protected if it matches `protected` in *either* scope.
2. It is allowed if it matches `allowed` in *either* scope.
3. Protected + not allowed → block/prompt. Protected + allowed (exact match only) → proceed.
4. Allowed without protected → proceed.
5. Relative paths resolve against `ctx.cwd`; `~/` expands to home; `file` matches exactly, `directory` matches the directory and descendants.

Glob subset (zero-dep): `*` (within a segment), `?` (single char), `**` (any number of segments, including zero). Patterns and targets are compared as resolved absolute paths; leading `**` patterns are root-agnostic by design (`**/.env*` protects `.env` anywhere — it is *not* cwd-scoped, otherwise it would never protect `/etc`). `onlyIfExists` rules fire only when the target exists on disk (creating a new file is not gated). Regex rules (`regex: true`) match the resolved target as-is, and broken regexes are dropped at config load.

Documented trade-off: a project cannot un-protect a global path, and cannot revoke a global allow (v1 simplification — global rules are the user's root of trust).

`/immunity:settings` writes to the chosen scope (global/project toggle), and "always" grants go to the scope the user picks at grant time (default: project when in a trusted project, else global).

---

## 4. Analysis stages in detail

### 4.1 Deterministic rules (no dependencies)

- **Command patterns**: substring or full-regex `patterns` (prompt-worthy) and `autoDenyPatterns` (blocked without prompting) against the raw command string. Deterministic auto-detect (lib/commands.ts): a pattern containing regex metacharacters (`.*+?^$[]{}|\` — bare parens excluded) is tested as an unanchored regex; a regex that fails to compile falls back to substring; everything else is a case-sensitive substring. A broken pattern can never silently disable protection. Footgun (by design): substrings are prefix-sensitive, so `git push --force` also matches `git push --force-with-lease` (the safe form) — write `git push --force( |$)` as a regex to disambiguate. Any `deny`-severity match (autoDeny or builtin) wins over `prompt`, which wins over allow.
- **Pathname globs**: `protected`/`allowed` matching as described in §3.
- **Built-in structural matchers** (ported from guardrails' catalog, rewritten by hand): `rm -rf` variants (grouped short flags `-rf`, `--recursive --force`), `sudo`/privileged commands, disk formatting (`mkfs`, `dd` to devices), broad `chmod -R`, `curl … | sh`, redirects to `/dev/disk*`, `> ~/.ssh/authorized_keys`, etc.
- Matching logic lives on **normalized command words** (or AST nodes, §4.2), not raw regex. The normalized model: pipeline stages, each `{ name, args, sep }` (`sep` = the operator preceding the stage: `|`, `&&`, `||`, `;`), plus redirect destinations and an error flag. The AST walker descends into lists and compound statements (`&&`/`||`/`;` chains, if/while/for/case bodies, subshells), so `echo x && rm -rf /bin` is caught, while `curl x && sh` is not mistaken for a pipeline (`curl | sh` requires an actual pipe).

### 4.2 tree-sitter AST layer (the one allowed external tool)

Purpose: replace guardrails' `@aliou/sh` dependency with the tree-sitter CLI, out of process.

- Spawn `tree-sitter` (config `treeSitter.binPath`, default on `PATH`) via `node:child_process`, parse a temp file containing the command with a **tree-sitter-bash grammar** (`treeSitter.grammarDir`, user-managed — the extension never compiles grammars itself), read the S-expression output, and walk the nodes.
- Structural matchers (4.1) can run against either the AST nodes or the flattened command words; the AST is used when available because it survives quoting/escaping that naive splitting breaks.
- **Degradation with a warning**: if the CLI or grammar is missing, parse fails, or the binary is too old, the extension falls back to word-based/substring matching **and notifies the user** (`ctx.ui.notify`, warning level) on every such event. `/immunity:status` shows availability and the last parse error.
- Implementation detail to verify against the installed CLI version: exact flags for parse-to-stdout and grammar loading (`tree-sitter parse <file>` with a local grammar scope; document the verified invocation in the README).

### 4.3 LLM verdict layer (via pi headless mode)

**Why a pi subprocess instead of direct HTTP:** `ExtensionAPI` has no model-call API, and pulling in an SDK would violate the zero-dependency constraint. But pi itself ships a headless mode, and the extension is *already running inside pi*, so the `pi` binary is guaranteed to exist. Spawning it as a child process reuses the user's pi setup (credentials, auth, model catalogue) with zero extra configuration; `llm.provider` / `llm.model` pin a cheap and fast setup for analysis when desired.

**Invocation (per analysis):**

```
pi --mode json --no-extensions --no-session \
   --no-skills --no-prompt-templates --no-context-files \
   [--provider "<provider>"] [--model "<model>[:<thinking>]"] \
   [--append-system-prompt "<user instructions from llm.appendSystemPrompt>"] \
   --extension <immunity-analysis-tool.ts> --tools immunity_verdict \
   --system-prompt "<security-analyzer persona — TBD, see §8>" \
   <prompt>    # command text passed as the prompt argument
```

- `--mode json` — the subprocess emits session events as JSON lines on stdout and exits after the run; the verdict is read from the tool-result event (§4.3 below).
- `--no-extensions` — disables discovery, but the explicit `--extension` path still loads; immunity itself never loads in the subprocess ⇒ no recursion, no re-analysis of the analysis.
- `--tools immunity_verdict` — allowlist: the subprocess has exactly **one** callable tool. No `read`/`bash`/`write`, nothing to exfiltrate or run.
- `--no-skills` / `--no-prompt-templates` / `--no-context-files` / `--no-session` — minimal startup; ephemeral; no session files written for analysis runs.
- `--provider` / `--model` — from `llm.provider` / `llm.model` (e.g. `ollama` + `qwen3:4b`, or `google` + `gemini-2.5-flash:low`); empty values fall back to pi's defaults for the subprocess.
- `--append-system-prompt` — carries `llm.appendSystemPrompt` (e.g. "never allow python") on top of the analyzer persona.
- Command text is passed as the prompt argument via `spawn(argv)` — no shell involved, so no quoting or injection issues.
- `llm.piPath` overrides PATH lookup of the `pi` binary.

**Verdict capture (strict, tool-call based):**

The extension directory ships a small second file (`analysis-tool.ts`) loaded into the subprocess via `--extension`. It registers one custom tool:

```ts
// typebox is provided by pi's runtime (documented available import), not a package dependency
Type.Object({
  risk:    Type.Enum({ none: "none", low: "low", high: "high" }),
  outcome: Type.Enum({ ALLOWED: "ALLOWED", DENY: "DENY", ASK_USER: "ASK_USER" }),
  reason:  Type.Optional(Type.String({ description: "short justification" })),
})
```

- The model **must call this tool to respond** — the system prompt says so, and it is the only tool available. Its `execute()` handler returns the (already schema-validated) parameters as its tool result: `{ content: [{ type: "text", text: JSON.stringify(verdict) }] }`.
- The parent extension scans the subprocess's JSON event stream for `tool_execution_end` where `toolName === "immunity_verdict"` and reads the verdict from `result.content[0].text`. No such event before the run ends ⇒ the model did not comply ⇒ inconclusive.
- No temp file needed. (Implementation detail to verify: exact event shape in `--mode json`; if it differs in practice, fall back to writing the verdict to a temp file.)
- Why this is strict: parameter validation happens *inside pi* against the typebox schema, the verdict never travels through free-form assistant text, and there is no JSON text parsing of the reply at all.

**When it runs:**

- Only for `bash` calls that survived stages 1–2 — no ambiguity gating or caching: every such call is analyzed when `llm.enabled`.
- Never for file-tool calls (pathnames are deterministic by nature).

**Decision mapping:**

`risk` is informational (audit + notify nuance); `outcome` drives the decision:

| Outcome | Default behavior | With `llm.autoDeny: true` | With `llm.confirm: true` |
|---|---|---|---|
| `ALLOWED` | allow; `risk: low`/`high` adds a one-time-per-session notify | same | prompts with the verdict (`LLM verdict: ALLOWED (risk …)`), user decides — debug/trust-but-verify mode |
| `DENY` | downgraded to a confirmation prompt | auto-block, source `"llm"` | same as default (autoDeny wins if both) |
| `ASK_USER` | confirmation prompt | same | same |
| no tool call / error / timeout | inconclusive → default policy (prompt) — never crashes the tool call | same | same |

**Timeout and cancellation:**

- Per-call overhead = process startup (≈0.5–1.5 s) + inference, bounded by `timeoutMs` (default 30000) with a hard kill on timeout, wired to `ctx.signal` so Esc cancels analysis. The timeout is the only bound — no caching, no ambiguity gating in v1.
- `ctx.ui.setStatus("immunity", "Analyzing…")` while in flight; cleared in `finally`.

**Trust note:** the command text is sent to the configured analysis provider — the same trust model as the main session, whose model already sees every command it runs. If `llm.provider` differs from the session model's provider, the command text is additionally visible to that provider.

---

## 5. Public surface

### Commands

| Command | Purpose |
|---|---|
| `/immunity:settings` | Menu-driven editor (scope toggle → section → `select`/`input`/`editor`); no custom TUI components |
| `/immunity:status` | *(post-POC)* Effective merged config, active session grants, tree-sitter health, LLM health (headless ping: model + latency) |
| `/immunity:audit` | *(post-POC)* Recent block entries from the audit log |

### Bus events (`pi.events`)

| Event | Payload |
|---|---|
| `immunity:action:blocked` | `{ feature, action, reason, block: { source, userReason? }, context }` — `source`: `policy` \| `autoDeny` \| `llm` \| `user` |
| `immunity:prompt:opened` / `immunity:prompt:closed` | correlated `prompt.id`; `closed` emitted in `finally` so it fires even when the UI throws |
| `immunity:grant:created` | a session/persistent grant was recorded (integration hook for dashboards) |

### "User input expected" hook (settings-driven)

No importable API. `prompting.onPromptCommand` lets the user configure a bash command that runs right before an approval prompt opens:

```jsonc
"prompting": { "onPromptCommand": "osascript -e 'display notification \"Immunity needs you\"'" }
```

- Context is passed via environment variables: `IMMUNITY_PROMPT_ID`, `IMMUNITY_FEATURE`, `IMMUNITY_REASON`, `IMMUNITY_ACTION`.
- **Exit code is ignored** — pure notification.
- Execution is fire-and-forget (`spawn`), with a **30s timeout** (the process is killed after); failures are logged, never crash the tool call.
- The correlated bus events (`prompt:opened`/`closed`) remain for extensions that want to observe the same lifecycle without configuring anything.

### Pi APIs used

- `pi.on("tool_call")` — the single interception hook (bash + file tools, typed via `isToolCallEventType`); blocking via `return { block: true, reason }`
- `pi.on("before_agent_start")` — pre-allow loaded skill `filePath`/`baseDir` (as guardrails does)
- `pi.on("session_start" / "session_shutdown")` — grants + in-memory state reset, listener cleanup
- `pi.events.on/emit` — bus events above
- `node:child_process` — spawns the headless pi analysis subprocess; the binary is resolved from PATH (override: `llm.piPath`); `--no-extensions` guarantees immunity never loads inside it
- `pi.registerTool` + typebox — used **only inside the subprocess extension** to register the schema-validated `immunity_verdict` tool; the main extension never adds tools to the user's session
- `pi.registerCommand` — `/immunity:settings` (status/audit land post-POC)
- `ctx.ui` primitives, `ctx.hasUI`, `ctx.mode`, `ctx.signal`, `ctx.cwd`, `ctx.isProjectTrusted()`, `CONFIG_DIR_NAME`

---

## 6. Prompt & block flow (Pi primitives only)

Primary flow — no `ctx.ui.custom()` anywhere:

```
risk found (deterministic or LLM-high)
  ├─ onPromptCommand (if configured)   fire-and-forget notification
  └─ ctx.ui.select("Immunity: <reason>", [
        "Allow once", "Allow for session", "Always allow", "Deny", "Deny with reason" ])
        ├─ Allow once          → proceed (this call only, no grant recorded)
        ├─ Allow for session   → memory grant, proceed
        ├─ Always allow        → persisted grant (commands.allowed / pathnames.allowed
        │                        in the scope index.ts picks — default: project when
        │                        trusted, else global), proceed
        ├─ Deny                → block, source: "user"
        └─ Deny with reason    → ctx.ui.input("Reason for blocking (optional)")
                                 → block, source: "user", userReason
```

Optional follow-up when a reason was given (`prompting.askReasonOnDeny`):

```
ctx.ui.select("Remember as a rule?", ["No", "Block this command pattern", "Protect this path"])
  → writes to commands.autoDenyPatterns / pathnames.protected in the chosen scope
```

**What happens with the reason:**

1. Returned to the agent: `block: true, reason: "Blocked by user: <reason>"` — the model learns from it and adjusts behavior.
2. Emitted in `immunity:action:blocked` (`block.userReason`).
3. Appended to the audit log (JSONL: `{ ts, sessionId, tool, action, reason, userReason, source }`).
4. Optionally converted into a persistent rule (above) — the user's intent becomes policy with their own words attached.

Low-risk notifications use `ctx.ui.notify`; the settings flow uses `select` + `input`/`editor` menus; in-flight LLM analysis shows via `ctx.ui.setStatus`. RPC mode works out of the box since all dialogs use the RPC extension UI protocol.

---

## 7. Trade-offs and open questions

**Trade-offs**

- Zero deps → hand-rolled config loader (read/merge/stamp `$schema`, ~150 lines), hand-maintained `schema.json`, no `ts-json-schema-generator`; tests use `node:test`, so the framework is dependency-free too. Acceptable for a v1 schema.
- tree-sitter CLI availability varies by machine → first-class degradation path (with user warning) + status command; structural matchers are the same code for AST and word inputs.
- LLM layer adds per-call subprocess startup (≈0.5–1.5 s) on top of inference → no caching or ambiguity gating in v1 (every bash command is analyzed when `llm.enabled`), bounded only by `timeoutMs` with a hard kill; accepted in exchange for zero configuration and credentials — the subprocess reuses the user's pi setup, with `llm.provider`/`llm.model` pinning a cheap setup for analysis when desired. Verdicts are advisory by default (`llm.autoDeny: false`).
- Strictness is enforced by the tool-call contract: schema-validated parameters, a single-tool allowlist, and no free-form text path into the verdict; a misbehaving model degrades to inconclusive, never to an unvalidated verdict.
- Audit log stores user-given reasons (project-scoped file `<project>/.pi/immunity.audit.jsonl`; privacy note in README; on by default, but reasons are only written when the user typed them).
- Global/project merge is deliberately non-symmetric (global cannot be weakened) — documented as a feature, not a bug.

**Open questions**

- Should `pathnames.allowed` support per-scope revocation (project denies a global allow)? v1: no — revisit if users need it.

**Resolved decisions**

- Interactive-only: immunity skips its checks when there is no UI (`ctx.hasUI` false, print/json modes). Its own analysis subprocess never loads the extension (`--no-extensions`) and has no approval flow by design. No `headlessMode` config.
- *Word fallback is a simple net (2025-08-02):* the degraded path splits on `|` only (`||` counts as a list separator), is quote-blind by design, and does not see `&&`/`;` chains or compound statements. Structural analysis is the AST path's job; degraded mode warns the user on every event. Rationale: quote-blind heuristics produce phantom matches (e.g. `echo "a && rm -rf /bin"`) that train users to reflexively allow prompts.
- *Obfuscation is the LLM layer's job (2025-08-02):* the deterministic layer does not chase command wrappers (`sh -c "…"`, `eval`, `xargs sh -c`, …). The LLM verdict layer sees the raw command text regardless of wrapping; per-user wrapper coverage belongs in `commands.patterns` / `autoDenyPatterns`, not in built-in arms races.
- *Built-in severity mapping (v1, 2025-08-02):* `deny` = irreversible damage (disk-format, dd-disk, redirect-disk, redirect-ssh-keys); `prompt` = destructive-but-recoverable or privileged (rm-force, sudo, chmod-recursive, curl-pipe-shell). Tunable via config later.
- *Pipeline stage semantics (2025-08-02, reordered 2025-08-06):* grant keys are `bash:<raw command>` and `file:<access>:<tool>:<resolved target>` (target resolved via expandPath so `a.env` and `./a.env` share a grant). Stage order is now **grant → LLM verdict → deterministic rules**: the LLM runs for every bash request when `llm.enabled` (supervision — its verdict is recorded in the audit trail even when the floor later blocks or prompts); file requests stay deterministic-only (v1; path rules are deterministic and complete). The rules are the non-negotiable **floor**: deterministic `deny` always blocks and `prompt` always asks (an LLM `ALLOWED` can never override either); the LLM verdict decides only what the floor allowed (`ALLOWED` → allow or confirm-prompt, `DENY` → block with autoDeny else prompt, `ASK_USER`/inconclusive → prompt). `prompting.requireConfirmation: false` downgrades deterministic prompts to `notify`; LLM prompts are unaffected (the verdict always surfaces).
- *Grant semantics (2025-08-02):* "Allow once" records nothing — it means literally one call; the next identical call prompts again. "Allow for session" records a memory grant (session store, first in the composite). "Always allow" persists to config: bash grants are exact raw-command strings in `commands.allowed` (never substring — a grant covers the exact command text, variants still prompt); path grants reuse `pathnames.allowed` kinds (file = exact, directory = descendants, access-agnostic) and are resolved against the session cwd/home. Persisted grants merge global-first like all lists; a failed persist still allows the current call (the user approved it) but reports `persisted: false` so the UI can surface the failure.
- *Audit + rule conversion (2025-08-02, amended):* the audit log records **blocks** (a JSONL line per blocked call: `ts, sessionId, tool, action, reason, userReason?, source`) **plus an LLM verdict trail** — one `event: "verdict"` line per analysis round-trip (`outcome`, `risk`, `reason`, or `failure: "<kind>: <error>"` for inconclusive, plus `llm.provider`/`llm.model`), so "why did this command pass?" is answerable from the log. Writes are synchronous append with parent-dir creation, failure-safe (false, never throws). Rule conversion (writeRule) is idempotent and never clobbers a scope file with invalid JSON — a broken config file fails the write and the UI reports it.
- *Gated tool set (2025-08-02):* v1 gates `bash`, `read`, `write`, `edit`. `grep`/`find`/`ls` and custom tools are read-only exploration — not gated (noise without risk). Deletion happens through bash `rm` in practice, which the command analysis covers. Rule conversion and always-grants write to the project scope when the project is trusted, else global, and reflect into the in-memory merged config immediately (a "Block this command pattern" or "Always allow" takes effect on the next identical call in the same session).

---

## 8. Later (post-POC)

- **Verify tree-sitter-bash parses meaningfully** — confirm the grammar produces useful ASTs for the commands we care about. Bash is the only dialect we need (the `bash` tool).
- **Analyzer system prompt specified (2025-08-05)** — `DEFAULT_SYSTEM_PROMPT` is now a full policy persona (replacing the placeholder): ALLOWED for safe read-only dev commands; DENY (with actionable reasons) for destructive/irreversible commands, curl|sh remote execution, /tmp work (use cwd instead), git writes, printing env-var secrets (existence checks fine), secret files (~/.ssh/**, .env, credentials), non-trivial python (prefer node); ASK_USER for chmod +x executables (prefer `bash -c` so the body stays LLM-visible) and package installs (npm/pip/brew/apt). Validated live: 8/8 policy probes matched (echo $TOKEN→DENY, test -n →ALLOWED, npm install→ASK_USER, touch /tmp→DENY, chmod +x→ASK_USER, cat ~/.ssh/id_rsa→DENY, git commit→DENY, trivial python one-liner→ALLOWED). The integration samples (ls -la ALLOWED; rm -rf, curl|sh, push --force NOT_ALLOWED) remain consistent.
- **`/immunity:status` and `/immunity:audit`** — diagnostics commands deferred from v1.
- **Warm analysis subprocess** — keep one persistent `pi --mode rpc` subprocess and stream analyses to it, amortizing per-call startup to zero — more valuable now that v1 has no per-call caching. Priority after the POC proves the LLM layer is worth keeping.
- **Git write-command matcher** — decide which git subcommands to flag (routine vs destructive/remote) and at what level (confirmation vs auto-deny). Deferred: not needed for the POC.
- **Integration tests for the analysis subprocess** — real `pi --mode json` runs (`*.integration.ts`, run explicitly), once the subprocess contract is verified.
- **Secret redaction for the analysis prompt** — v1 sends the command text to the analysis provider as-is (same trust model as the main session). If the analysis provider ever differs from the session model's provider, add an optional scrubber (`KEY=value` assignments, token-like strings) — only for the analysis subprocess, never altering pi's default behavior.

---

## 9. Testing (`node:test`)

Node's built-in test runner keeps the zero-dependency constraint — no vitest/jest, nothing to install.

**Runner & discovery**

- `node --test` from the extension directory. TypeScript runs directly via native type stripping (default `*.test.ts` globs; no build step).
- Colocated `*.test.ts` files next to the modules they test. Shared helpers (fake `ctx.ui`, fake `pi`, tmp dirs via `fs.mkdtemp`) live in `tests/helpers.ts`.
- Structure with `describe`/`it` and subtests (`t.test()`); `t.plan()` where assertion counts matter.

**Built-in mocking** (no framework needed)

- `t.mock.method()` — stub `ctx.ui.select`/`input`/`notify`, `pi.on`/`registerCommand`/`registerTool`, `child_process.spawn` (both the LLM client and the tree-sitter bridge).
- `mock.timers` — verify the `onPromptCommand` 30s kill and the LLM `timeoutMs` kill without waiting.
- `mock.module` (flag: `--experimental-test-module-mocks`) if module-level mocking is ever needed.

**Covered areas**

- Config loader: scope merge (list unions, scalar override), pathname precedence rules 1–5, `CONFIG_DIR_NAME`, trust gating, `$schema` stamping.
- Path engine: glob semantics, `~/` expansion, `file` vs `directory` kinds, relative resolution against cwd.
- Command engine: substring/regex compilation, `autoDenyPatterns`, built-in matchers (grouped short flags `-rf`, `chmod -R`, `curl | sh`, redirects).
- tree-sitter bridge: spawn arguments, S-expr walking over fixtures, degradation → warning notify (mocked spawn failure).
- LLM client: subprocess args (`--mode json`, `--tools immunity_verdict`, provider/model/append flags), `tool_execution_end` parsing, missing verdict → inconclusive, timeout → kill.
- Prompt flow: each `select` outcome → grant/block/reason; skip when no UI; `onPromptCommand` env vars + 30s kill.
- Reason pipeline: audit JSONL entries written to a tmp dir, rule-conversion writes to the chosen scope.
- Analysis tool (`analysis-tool.ts`): tool registration with the typebox schema, `execute()` returns the validated verdict.

**Focused runs** — all built-in:

- `node --test --test-name-pattern="path engine"` — run a subset
- `node --test --watch` — rerun on change
- `node --test --experimental-test-coverage` — coverage report
- `node --test --test-rerun-failures <state-file>` — rerun only failed tests

**Integration tests** (real `pi --mode json` subprocess): named `*.integration.ts` so the default globs skip them; run explicitly with `node --test integration/`. Deferred until the POC stabilizes the subprocess contract (see §8).

---

## 10. Implementation checklist (v1)

- [ ] Extension layout: `index.ts` entry + helper modules in an extensions directory; no package.json, no publishing
- [ ] Config loader: global+project read, union merge, `$schema` stamp, `CONFIG_DIR_NAME`, trust gating
- [ ] Path engine: glob matching, `~/` expansion, `file`/`directory` kinds, precedence (3)
- [ ] Command engine: pattern compilation (substring/regex), built-in matchers on words
- [ ] tree-sitter bridge: spawn, temp-file parse, S-expr walk, degradation warning
- [ ] LLM client: headless `pi --mode json` spawn (`-ne --no-session`, `-e <analysis-tool.ts> -t immunity_verdict`, optional `--provider`/`--model`/`--append-system-prompt`), verdict from `tool_execution_end`, timeout/kill
- [ ] Analysis subprocess extension: `immunity_verdict` tool (typebox schema, optional reason), verdict returned as tool result
- [ ] Prompt flow: `select`/`input` flow, session grants, persist-grant-to-scope
- [ ] Reason pipeline: capture, block message, event, audit JSONL, rule conversion
- [ ] `onPromptCommand` hook (env vars, fire-and-forget, 30s timeout) + bus events (`action:blocked`, `prompt:opened/closed`, `grant:created`)
- [ ] `/immunity:settings`
- [ ] `schema.json` + README (tree-sitter grammar setup, headless LLM setup)
- [ ] Test harness: `node --test`, colocated `*.test.ts`, shared helpers (fake `ctx.ui`, tmp dirs via `fs.mkdtemp`); integration tests as `*.integration.ts` (run explicitly)
- [ ] Test coverage: config/scope merge, pathname precedence, pattern compilation, built-in matchers, tree-sitter degradation warning, LLM client (args, verdict parsing, timeout/kill), prompt outcomes, reason pipeline, `onPromptCommand`, analysis tool verdict
