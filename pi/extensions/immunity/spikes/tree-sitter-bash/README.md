# Spike: tree-sitter-bash parse contract (pi-immunity P0-1)

**Verdict: PASS — commit to the tree-sitter path.** The grammar produces
useful ASTs for all target categories (rm -rf variants, curl|sh pipelines,
redirects, quoting). The CLI is a viable out-of-process parser with a
6 ms fast path.

Verified against: `tree-sitter` CLI **0.26.11** (`/opt/homebrew/bin/tree-sitter`)
and `tree-sitter/tree-sitter-bash` (latest, cloned 2025-08-02).

---

## Verified invocation

### Fast path (6 ms / parse) — `-l`, compiled grammar library

```bash
# one-time compile (needs clang; the tree-sitter CLI compiles it, we don't)
tree-sitter build -o ~/.config/tree-sitter/lib/bash.dylib ~/.config/tree-sitter/tree-sitter-bash

# per-parse
tree-sitter parse -l ~/.config/tree-sitter/lib/bash.dylib <file>
```

The CLI's own cache (`~/.cache/tree-sitter/lib/bash.dylib`, produced by any
`-p` parse) is equivalent and also works with `-l`.

### Self-contained path (1 s / parse) — `-p`, grammar directory

```bash
tree-sitter parse -p ~/.config/tree-sitter/tree-sitter-bash <file>
```

`-p` **implies `--rebuild`**: the CLI recompiles the grammar on every call
(~1 s each, clang required). Use only as a fallback when no dylib exists.

### Non-verified alternatives

- `--json-summary`/`-j` — **stats only** (success flag, timing, bytes). No tree.
  Not useful for AST walking.
- `-c` (CST) — ANSI-colorized, harder to parse than the S-expression.
- `--dot`, `-x` (XML) — not evaluated; S-expression is the canonical format.

---

## Output contract (for the bridge)

| Condition | stdout | stderr | exit |
|---|---|---|---|
| Clean parse | S-expression | — | 0 |
| Parse error | S-expression **with `ERROR` nodes** + one stats line appended (`<file>\tParse: … (ERROR …)`) | — | 1 |
| Missing grammar lib | — | `Error: Failed to load language …` (ANSI-colored) | 1 |
| Missing binary | — | spawn `ENOENT` | — |

Bridge rules:

- Strip lines matching `/\tParse:/` from stdout before parsing the S-expression
  (they only appear on error parses).
- Exit code 1 ≠ fatal: the tree is still walkable (`ERROR` nodes present) —
  treat as "parse had errors", degrade structural confidence, don't drop the tree.
- Pass the file path as a plain argv element — no shell, no quoting issues.
- The S-expression is the only structured tree output; parse it with a small
  recursive-descent parser (tokenizer regex + node walker, ~90 lines, no deps).

---

## AST findings → matcher implications

| Target | AST shape | Matcher implication |
|---|---|---|
| `rm -rf /path` | `(command name: (command_name (word "rm")) argument: (word "-rf") argument: (word "/path"))` | `command_name` distinguishes the command from args |
| `rm -rfv /path` (grouped short flags) | `-rfv` is a **single `word` arg** | short flags need prefix matching (`-rf*`), not exact words |
| `rm --recursive --force /path` | long flags are separate exact `word` args | exact word match works |
| `curl … \| sh` / `\| bash` | `(pipeline (command…) (command…))` | pipeline node → inspect 2nd command name for `sh`/`bash` |
| `echo … > ~/.ssh/authorized_keys` | `(redirected_statement body: (command…) redirect: (file_redirect destination: (word)))` | redirect target = `redirect` field → `destination` field text |
| `sudo mkfs.ext4 /dev/sdb1` | `(command name: (word "sudo") …)` | `sudo` + first arg = elevated command |
| `dd if=… of=/dev/disk2 bs=1m` | `of=` operand is a plain `word` arg | `/dev/disk*` as arg value, any command |
| `chmod -R 777 …` | flag, mode, path as separate args (`777` parses as `number`) | `-R` + `777`-style modes |
| `rm -rf "/tmp/my dir"` | arg = `(string (string_content))` | **space inside quotes never splits the arg** — the core win over naive word-splitting |
| `rm -rf '/tmp/x y'` | arg = `(raw_string)` | same |
| `rm -rf /tmp/a\ b` | arg = `(word "/tmp/a\\ b")` — escape preserved in text | matcher must account for backslash escapes (unescape before path matching) |
| `echo "unterminated` / `if then` | `(ERROR …)` node, exit 1 | error presence = lowered parse confidence; tree still walkable |

Node positions are row/col pairs into the source file — matchers can slice the
original text for exact semantics.

---

## Grammar setup (user-managed, documented for the README)

```bash
git clone https://github.com/tree-sitter/tree-sitter-bash ~/.config/tree-sitter/tree-sitter-bash
tree-sitter build -o ~/.config/tree-sitter/lib/bash.dylib ~/.config/tree-sitter/tree-sitter-bash
```

The extension never compiles grammars itself — it only spawns the CLI with
`-l` (dylib) falling back to `-p` (grammar dir). Missing CLI/grammar →
word-based fallback + warning notify (degradation path, per design §4.2).

---

## Fixtures & spike test

`fixtures/*.sh` — 16 inert text files, **parse-only, never executed**. One
command line each; content is dangerous-looking on purpose (detector test
corpus). See `fixtures/README.md`.

```bash
node --test "pi/extensions/immunity/spikes/tree-sitter-bash/**/*.test.ts"
# or from inside the spike dir:
#   cd pi/extensions/immunity/spikes/tree-sitter-bash && node --test spike.test.ts
```

Env overrides: `IMMUNITY_TS_BIN` (binary), `IMMUNITY_TS_LIB` (dylib path).
Test auto-skips with setup instructions when no grammar is found.
