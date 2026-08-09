# pi-immunity — Design Reflection (2025-08)

Status: the POC is complete. This document captures the reflection that re-shapes it into a maintainable product. **We start from scratch** — the previous config shape (patterns/autoDenyPatterns/allowed, prompting section, tree-sitter layer, llm.enabled/autoDeny/confirm) is discarded, not migrated. There is no version 2.

## Guiding principles

- One rules shape everywhere: `{ action, ... }` — paths and commands share the mental model.
- Session statements overrule all config; project overrules global. Conflicts → safest action (block).
- Non-configurable safety defaults: outside-cwd access and gitignored files are **blocked** unless an explicit allow rule covers them.
- The LLM is the primary judge for shell commands; deterministic matching (regex, then string) is a fallback for when the LLM is unavailable. We assume LLM output is correct.
- LLM suggestions never write rules themselves — only the user's menu choice writes, and rule writes are exact-string.
- No globbing anywhere. `~` is allowed; relative paths must start with `./`.

## Path access

- Controlled by `paths.rules`: `{ action: "ask"|"allow"|"deny", kind: "file"|"directory", path }`.
- `kind: "directory"` is **recursive** — covers all descendants, including files created later.
- Hard defaults (not configurable): outside cwd → block; gitignored → block. Explicit allow rules override.
- Future (low priority): two access levels — read vs read/write.

## Shell execution

- `commands.rules`: `{ action: "allow"|"deny"|"ask", exact?: boolean, raw: string, regex?: string }`.
  - `raw` is fed into the LLM prompt; `regex` is deterministic-only, never fed.
  - `exact: true` → full-string match; default (false) → partial (substring) match.
- `commands.promptWhen`: `"asked"` (default was discussed; we chose `"blocked"`) | `"blocked"` | `"everytime"`.
  - `asked` — only ask-rules prompt; LLM DENY blocks silently.
  - `blocked` — asks *and* blocks prompt (LLM DENY shows the menu). **Default.**
  - `everytime` — prompt after every verdict (debugging).
- Pipeline: session exemption (exact match, in-memory) short-circuits before the LLM → LLM decides with rules fed in order **project rules first, then global** (order = priority; the LLM resolves conflicts) → if the LLM is unavailable, deterministic fallback: `regex` if present, else string match per `exact`.
- LLM unavailable *and* no rule match: `strict: true` (default) prompts; `false` allows.
- Tree-sitter is dropped entirely.

## Handling blocked requests (unified menu)

The user is prompted for each blocked command and file path with exactly six options:

- Allow for session / Allow for project / Allow globally
- Block for session / Block for project / Block globally

- Session options are in-memory (allow-exempt and deny-exempt arrays, exact match).
- Project/global options write rules: paths → `paths.rules` (action allow/deny, kind inferred or file); commands → `commands.rules` with `exact: true`, raw = the exact command string.
- When the user picks a block option, they are asked whether they want to provide a reason (built-in, not configurable); a user-provided reason overwrites the model's reason.
- LLM suggestions (paths.blocked, commands.blocked) are **audit-only** — never rendered as menu options, never applied automatically.

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

## Hooks

- `onPromptCommand` moved to root: `hooks.afterPrompt` — a user-configured command run when a prompt opens.
- The `prompting` section is dissolved: `sessionGrants` removed (session options are always available), `askReasonOnDeny` became the built-in reason-ask described above, `requireConfirmation` dropped (prompts always block in interactive sessions; non-interactive sessions are gated off by `hasUI`).

## Audit

- `audit.enabled` toggle, default **on**.
- Location unchanged: project-local `.pi/immunity.audit.jsonl` (no auto-gitignore behavior).

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

No `$schema` entry for now (to be added once the shape stabilizes). No `version` field.

## Future / open items

- Read vs read/write access levels for paths.
- Basename-style matching for "all .env anywhere" (no-glob rule currently requires per-directory entries).
- Gitignored-file handling maturity in the global config (avoiding chatty prompts).
- Revisiting headless (non-interactive) enforcement — currently gated off entirely via `hasUI`.
