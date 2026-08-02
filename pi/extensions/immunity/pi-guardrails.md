# pi-guardrails — what these packages do

`@aliou/pi-guardrails` is a **single npm package** (v0.16.1, MIT) that installs into Pi as an extension bundle. It is *not* a monorepo of three packages — it registers **four** Pi extensions:

- **guardrails** — file protection policies
- **path-access** — control over paths outside the workspace
- **permission-gate** — gating dangerous shell commands
- **herdr** — reporting approval prompts to Herdr (event adapter, added in 0.16.0)

The "three" comes from history: the first three were the original layout (the 0.15.0 changelog still calls it the "three-extension layout"); herdr arrived later. If you count npm packages rather than extensions, the trio is `@aliou/pi-guardrails` + its two runtime dependencies:

- **`@aliou/sh`** — shell AST parser used for dangerous-command detection
- **`@aliou/pi-utils-settings`** — shared config loader + settings UI infrastructure (which itself depends on `@aliou/pi-utils-ui`, a small TUI component library)

---

## @aliou/pi-guardrails

### Responsibilities

Add deterministic safety checks to Pi so an agent is less likely to, by accident:

- read or modify protected files (`.env`, keys, credentials, logs, database dumps — any path the user designates),
- access paths outside the current workspace,
- run dangerous shell commands (`rm -rf`, privileged commands, disk formatting, broad `chmod`, etc.).

Each guardrail feature owns one Pi `tool_call` hook and blocks the call by returning `{ block: true, reason }` from the hook. There is no sandboxing or containment — everything is prompt/block based, before execution.

### Exposed APIs and features

**Config file** (`guardrails.json`, global `~/.pi/agent/extensions/` or project `.pi/extensions/`), all under a `$schema`-validated schema:

| Section | What it controls |
|---|---|
| `policies.rules` | File protection rules: pattern (glob or regex), protection level (read/modify), `allowedPatterns` exceptions, `blockMessage`, `onlyIfExists` |
| `pathAccess` | `mode` (`ask` \| `allow` \| `block`) and `allowedPaths` grants: `{ kind: "file" \| "directory", path }` entries |
| `permissionGate` | `patterns` + `autoDenyPatterns` (substring or regex), `useBuiltinMatchers`, `requireConfirmation` |
| `enabled` / `features` / `envFiles` / `onboarding` | Master switch, per-feature toggles, protected env-file list, onboarding state |
| `version` | Schema version stamp for migrations |

**Slash commands** (owned by the `guardrails` extension):

- `/guardrails:settings` — interactive settings UI with scope tabs (global vs project)
- `/guardrails:onboarding` — first-run wizard to pick a starting setup
- `/guardrails:examples` — add policy/command presets without replacing existing config

**Events on Pi's shared event bus** (the extension's public integration surface):

- `guardrails:action:blocked` — a call was blocked, with the action, reason, and block source (`policy` | `permission` | `user` | `user-stop` | `nonInteractive`)
- `guardrails:risk:detected` — a dangerous action was detected but not blocked (e.g. confirmation disabled)
- `guardrails:feature:request` / `guardrails:feature:register` — feature discovery between the extensions
- `guardrails:prompt:opened` / `guardrails:prompt:closed` — correlated pair (`prompt.id`) for every approval prompt; fired in `finally` so they emit even when the UI throws
- `guardrails:action:prompted` — deprecated legacy alias of the prompt events

**Runtime prompts**:

- **path-access** prompt: allow one file or a directory — *once*, *for the session*, or *always* (persisted)
- **permission-gate** prompt: Allow once / Allow for session / Deny / **Decline and stop** (aborts the current agent turn)

### How it's implemented

**Pi APIs used:**

- `pi.on("tool_call")` — the three guardrail hooks that intercept file/command tool calls and return `{ block: true, reason }`
- `pi.events.on / pi.events.emit` — cross-extension communication and external integrations
- `ctx.ui.custom(...)` (custom TUI prompt components), `ctx.ui.select(...)` (RPC/fallback path), `ctx.ui.notify(...)` (warnings)
- `ctx.hasUI` — extensions block silently (source `nonInteractive`) when there is no UI to confirm
- `ctx.cwd` — workspace root for resolving relative paths and relative-vs-outside-workspace decisions
- `ctx.abort()` — kills the turn for "decline and stop"
- `pi.on("session_start")` / `pi.on("session_shutdown")` — feature-discovery reset and listener cleanup
- `pi.on("before_agent_start")` — reads loaded skills so their `filePath`/`baseDir` are implicitly allowed
- Extension registration via the `pi.extensions` field in `package.json`; peer-depends on `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` (both optional, for hook types and TUI components)

**External packages:**

- `@aliou/sh` — parses bash commands into a typed AST; the permission gate matches dangerous patterns **structurally** against parsed words (e.g. grouped short flags `-rf`, long options) instead of regexing raw strings
- `@aliou/pi-utils-settings` — config loading, deep merge of global+project scopes, versioned migrations, `$schema` stamping, settings UI scaffolding
- `@aliou/pi-utils-ui` — TUI components used by the settings editors

**Key implementation decisions:**

- **Uniform safety pipeline**: every feature funnels through one `checkAction(action, rules)` primitive — rules receive an action (`file` or `command`) and return `safe` or `dangerous` with a reason + metadata. Prompts, events, and block reasons all derive from that result.
- **One shared config, three consumers**: all guardrail extensions load the *same* config singleton, so one settings UI edits everything.
- **Feature discovery over the event bus**: the `guardrails` extension broadcasts `feature:request` on session start; path-access and permission-gate answer with `feature:register` — the settings UI only shows features that are actually loaded, and per-session resets are handled.
- **Blocking semantics**: deny = return `{ block: true, reason }` from the `tool_call` hook; "decline and stop" additionally calls `ctx.abort()` and emits a `user-stop` block event so the agent stops, not just the command.
- **Grants model** (path-access): session grants live in memory, "always" grants persist to config as `{ kind, path }` entries; directory grants are rejected as "too broad" above a safety threshold (e.g. home). Pi's own docs paths and loaded skill paths are auto-allowed.
- **Config robustness**: JSON schema generated from TS types (`ts-json-schema-generator`, committed and CI-checked), migrations for format evolution (e.g. `allowedPaths` migrated from trailing-slash strings to `{kind, path}` objects in 0.14.0), and startup warnings surfaced via `ctx.ui.notify`.
- **Herdr integration is side-effect free**: the adapter emits `herdr:blocked` events with no Herdr dependency — if Herdr isn't active, nothing happens.

---

## @aliou/sh

### Responsibilities

A TypeScript shell parser inspired by `mvdan/sh` — parses POSIX/Bash/mksh/zsh command strings into a typed AST. It exists to give guardrails a reliable, grammar-aware view of what a command actually does.

### Exposed APIs and features

- **One exported function**: `parse(command) → { ast }` — a `Program` node of typed statements
- AST covers `SimpleCommand`, `Pipeline`, `Logical` (`&&`/`||`), conditionals (`if`/`while`/`for`/`case`/`select`), `FunctionDecl`, subshells, blocks, `[[ ]]` tests, `(( ))` arithmetic, `declare`/`local`/`export` clauses, `let`, c-style loops, coprocs, `time`
- Words contain typed parts: literals, single/double quotes, `$VAR` parameter expansions, command substitution, arithmetic expansion, process substitution
- Zero dependencies, ~28 KB bundled

### How it's implemented

- Hand-written tokenizer + recursive-descent parser (no parser generator), supporting multiple shell dialects
- Guardrails consumes it by walking the AST for `SimpleCommand` nodes and normalizing words to strings, then applying **structural matchers** (e.g. detect `-rf` inside grouped short options, or `--recursive` long forms) — far more robust than regex against quoting, escapes, and shell syntax

---

## @aliou/pi-utils-settings

### Responsibilities

Shared settings infrastructure for Pi extensions: JSON config management (global + project scopes) and a settings UI. A utility library, not an extension itself.

### Exposed APIs and features

- **`ConfigLoader<TConfig, TResolved>`** — loads `~/.pi/agent/extensions/<name>.json` + `.pi/extensions/<name>.json`, deep-merges them over defaults, and exposes `getConfig()`, `save()`, `drainMessages()` (surfacing migration warnings)
- **Versioned migrations** — `Migration[]` with `shouldRun`/`run`; migrations can attach user-facing messages
- **`buildSchemaUrl(pkg, version)`** — builds unpkg/raw schema URLs; when a `schemaUrl` is set, `save()` writes `$schema` as the first key and `load()` strips it before returning config
- **Settings UI** — registers a settings slash command with scope tabs (global/project) plus optional extra tabs, reusing `@aliou/pi-utils-ui` TUI components

### How it's implemented

- Generic over the extension's own `TConfig`/`TResolved` types; defaults merging is centralized so extensions stay thin
- `$schema` stamping pairs with `ts-json-schema-generator` so editors autocomplete extension configs
- Depends only on `@aliou/pi-utils-ui` (TUI components) and peer-depends on the pi coding agent for `ExtensionAPI` types

---

## How they fit together

```
pi-guardrails (extension bundle, 4 extensions)
 ├── guardrails ......... file policies + commands ──┐
 ├── path-access ....... outside-workspace control ──┼─► all share checkAction()
 ├── permission-gate ... dangerous commands ─────────┘   and one configLoader
 └── herdr ............. prompt lifecycle → herdr:blocked
        │
        ├── @aliou/sh ........................ parse bash → AST → structural matchers
        └── @aliou/pi-utils-settings .......... config load/merge/migrate/schema + settings UI
             └── @aliou/pi-utils-ui .......... TUI components
```
