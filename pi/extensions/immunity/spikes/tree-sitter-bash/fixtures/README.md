# Parse-only fixtures — NEVER EXECUTED

These `.sh` files are **inert text inputs for the tree-sitter-bash spike**.
Their content looks dangerous on purpose: they are the test corpus for a
*detector* (pi-immunity). They must never be run through a shell — only
through `tree-sitter parse` (or `node --test` spawning it), which reads text
and prints a parse tree.

## Verifying the contents (byte-exact)

```bash
cat fixtures/*.sh
```

Each file holds exactly one command line (with trailing newline where noted).

## The spike

See `../README.md` for the verified `tree-sitter parse` invocation and the
AST shapes observed on this fixture set.
