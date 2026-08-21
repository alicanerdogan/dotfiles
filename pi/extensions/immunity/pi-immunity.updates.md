# pi-immunity — design updates (2025-08)

The POC is complete. These updates re-shape it into a maintainable product. **Start from scratch** — the previous config shape (`patterns`/`autoDenyPatterns`/`allowed`, `prompting` section, tree-sitter layer, `llm.enabled`/`autoDeny`/`confirm`) is discarded, not migrated. No version 2, no `version` field, **no `$schema` entry yet** (added once the shape stabilizes).

See [`pi-immunity.reflection.md`](pi-immunity.reflection.md) for the full rationale; this file records the agreed outcomes.

## Guiding principles

- One rules shape everywhere: `{ action, ... }` — paths and commands share the mental model.
- Session statements overrule all config; project overrules global. Conflicts → safest action (block).
- Non-configurable safety defaults: outside-cwd access and gitignored files are **blocked** unless an explicit allow rule covers them.
- The LLM is the primary judge for shell commands; deterministic matching (regex, then string) is a fallback for when the LLM is unavailable. LLM output is assumed correct.
- LLM suggestions never write rules themselves — only the user's menu choice writes, and rule writes are exact-string.
- No globbing anywhere. `~` is allowed; relative paths must start with `./`.

## Path access

- `paths.rules`: `{ action: "ask"|"allow"|"deny", kind: "file"|"directory", path }`.
- `kind: "directory"` is **recursive** — covers all descendants, including files created later.
- Hard defaults (not configurable): outside cwd → block; gitignored → block. Explicit allow rules override.
- **Skill reads are never supervised**: `read` calls whose target lies under a directory named `skills` (every discovery root — agent dir, `~/.agents`, project `.pi`/`.agents`, packages, settings) bypass the pipeline entirely. Skill *loading* must not prompt, regardless of path rules or the hard defaults.
- Future (low priority): read vs read/write access levels.

## Shell execution

- `commands.rules`: `{ action: "allow"|"deny"|"ask", exact?: boolean, raw: string, regex?: string }`.
  - `raw` is fed into the LLM prompt; `regex` is deterministic-only, never fed.
  - `exact: true` → full-string match; default (false) → partial (substring) match.
- `commands.promptWhen`: `"asked"` | `"blocked"` | `"everytime"`.
  - `asked` — only ask-rules prompt; LLM DENY blocks silently.
  - `blocked` — asks *and* blocks prompt (LLM DENY shows the menu). **Default.**
  - `everytime` — prompt after every verdict (debugging).
- Pipeline: session exemption (exact match, in-memory) short-circuits before the LLM → LLM decides with rules fed in order **project rules first, then global** (order = priority; the LLM resolves conflicts) → if the LLM is unavailable, deterministic fallback: `regex` if present, else string match per `exact`.
- Analyzer policy (system prompt): temporary files belong in `./.tmp` under the project cwd (`mkdir -p ./.tmp`); `/tmp`/`$TMPDIR` stays DENY. `rm -rf` confined to the project's own `./.tmp` is ALLOWED (temp cleanup); anywhere else it stays DENY. Note: if `.tmp` is gitignored, `read`/`write`/`edit` tool access to it hits the gitignored hard default — allowlist `./.tmp` in `paths.rules` when you gitignore it.
- LLM unavailable *and* no rule match: `strict: true` (default) prompts; `false` allows.
- Tree-sitter is dropped entirely.

## Handling blocked requests

**Whole commands** prompt with a plain Allow/Deny — a one-shot call decision, never scope-persisted (no rules, no session statements). The command decision comes **first**; scope choices are reserved for the LLM's flagged subsections, asked only when execution is allowed:

- **Denying the command ends the prompt** — flagged-path suggestions are never asked.
- Suggestion step (bash, after an Allow, when the LLM verdict flagged paths): one dialog per flagged path: *Allow for session / Allow for project / Allow globally / Protect for project / Protect for global / Skip*. Allow writes `paths.rules {action: "allow"}` (session → in-memory statement); Protect writes `{action: "deny"}` (protect = deny). Protecting a path persists a deny rule **for future commands** — it never blocks the already-allowed command; a failed/dismissed suggestion prompt never undoes an explicit Allow. `commands.blocked` suggestions stay audit-only.

**File paths** keep the six-option scope menu — a path is a durable rule target:

- Allow for session / Allow for project / Allow globally
- Block for session / Block for project / Block globally

- Session options are in-memory (allow-exempt and deny-exempt arrays, exact match).
- Project/global options write rules: paths → `paths.rules` (action allow/deny, kind inferred or file); commands → `commands.rules` with `exact: true`, raw = the exact command string. (Command rules can no longer be written from the menu — whole commands are binary by design.)
- When the user picks a block option (or Deny on a command), they are asked whether they want to provide a reason (built-in, not configurable); a user-provided reason overwrites the model's reason; without one, the model's reason is kept in the block message.
- Path rules: after an Allow/Block choice on a **file target**, one follow-up select asks *Just this file* vs *The whole directory (recursive)* (directory targets skip it — kind is inferred). A directory choice on a file target applies to the containing directory. Session directory statements are prefix-matching (covers descendants).
- One-shot command Allows are audited as `event: "decision"` with `scope: "call"`; binary Denies are block entries (source: user).
- Only the user's click writes — suggestions never apply themselves; `commands.blocked` suggestions are audit-only.

## LLM config

```jsonc
"llm": {
  "disabled": false,        // opt-out; enabled by default
  "provider": "opencode-go",
  "model": "deepseek-v4-flash",
  "timeoutMs": 30000,
  "userPrompt": "",         // user-authored policy text appended to the system prompt
  "piPath": ""
}
```

`autoDeny` and `confirm` are gone (absorbed into `promptWhen`). `appendSystemPrompt` renamed to `userPrompt`.

No-response handling is **manual, no config**: when the analysis fails (timeout, no verdict, spawn, parse, output), the command prompt adds a *Retry analysis* option that re-runs the analyzer on demand — uncapped, user-driven; each attempt is a fresh subprocess with its own `timeoutMs` and its own verdict-trail audit line. The deterministic fallback (rules, then strict) only applies when the user does not retry, and an aborted signal never re-runs.

## Hooks

- `onPromptCommand` moved to root: `hooks.afterPrompt` — a user-configured command run when a prompt opens.
- The `prompting` section is dissolved: `sessionGrants` removed (session options are always available), `askReasonOnDeny` became the built-in reason-ask above, `requireConfirmation` dropped (prompts always block in interactive sessions; non-interactive sessions are gated off by `hasUI`).

## Audit

- `audit.enabled` toggle, default **on**.
- Location unchanged: project-local `.pi/immunity.audit.jsonl`. No auto-gitignore behavior.

## Final config shape

```jsonc
{
  "strict": true,                       // LLM down + no rule match → prompt (false: allow)
  "paths": {
    "rules": [
      { "action": "ask",  "kind": "file",      "path": "./.env" },
      { "action": "deny", "kind": "directory", "path": "~/.ssh" },
      { "action": "allow","kind": "directory", "path": "~/repos" }
    ]
    // no globs; ~ allowed; relative must start with ./
    // directory = recursive; hard defaults: outside cwd + gitignored = block
  },
  "commands": {
    "rules": [
      { "action": "deny", "exact": true,  "raw": "git push --force" },
      { "action": "ask",  "exact": false, "raw": "npm install", "regex": "^npm (install|i)\\b" }
    ],
    "promptWhen": "blocked"               // 'asked' | 'blocked' | 'everytime'
  },
  "llm": {
    "disabled": false,
    "provider": "opencode-go",
    "model": "deepseek-v4-flash",
    "timeoutMs": 30000,
    "userPrompt": "",
    "piPath": ""
  },
  "hooks": { "afterPrompt": "" },
  "audit": { "enabled": true }
}
```

## Future / open items

- Read vs read/write access levels for paths.
- Basename-style matching for "all .env anywhere" (no-glob rule currently requires per-directory entries).
- Gitignored-file handling maturity in the global config (avoiding chatty prompts).
- Revisiting headless (non-interactive) enforcement — currently gated off entirely via `hasUI`.
