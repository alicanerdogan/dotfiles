/**
 * pi-immunity LLM verdict client.
 *
 * Spawns a headless `pi --mode json` subprocess (contract verified in
 * spike 2, spikes/pi-subprocess/README.md) that analyzes a command through
 * the immunity_verdict tool, and reads the verdict from the
 * `tool_execution_end` event.
 *
 * Failure handling is asymmetric by design: only a schema-valid verdict
 * counts as a result; every other outcome — spawn error, no verdict before
 * the stream ends, malformed verdict, timeout, abort — is inconclusive and
 * the caller's default policy is to prompt. A missing verdict is never
 * treated as approval (the spike showed models cannot be relied on to
 * follow "don't call the tool" instructions; absence detection +
 * timeout/kill are the enforcement).
 */
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

export type Risk = "none" | "low" | "high";
export type Outcome = "ALLOWED" | "DENY" | "ASK_USER";

export interface Verdict {
  risk: Risk;
  outcome: Outcome;
  reason?: string;
}

export type VerdictResult =
  | { ok: true; verdict: Verdict }
  | {
      ok: false;
      kind: "spawn" | "timeout" | "no-verdict" | "parse" | "output";
      error: string;
    };

export interface VerdictOptions {
  /** pi binary (default `pi` on PATH) */
  piPath?: string;
  provider?: string;
  model?: string;
  /** analyzer persona — placeholder until §8 of the design doc */
  systemPrompt?: string;
  /** carried via `--append-system-prompt` (llm.appendSystemPrompt) */
  appendSystemPrompt?: string;
  /** path to subprocess/analysis-tool.ts (default: resolved next to this module) */
  analysisToolPath?: string;
  timeoutMs?: number;
  /** session abort signal (ctx.signal); abort behaves like a timeout */
  signal?: AbortSignal;
  /** injectable for tests */
  spawn?: SpawnFn;
}

/** Minimal child-process surface the client needs (narrow enough for fakes). */
export interface VerdictChild {
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null;
  signalCode: string | null;
  kill(signal?: string): boolean;
  on(event: "error" | "close", listener: (arg?: unknown) => void): unknown;
}

export type SpawnFn = (
  cmd: string,
  args: string[],
  options: { stdio: readonly ["ignore", "pipe", "pipe"] },
) => VerdictChild;

const RISKS = ["none", "low", "high"] as const;
const OUTCOMES = ["ALLOWED", "DENY", "ASK_USER"] as const;

export const DEFAULT_SYSTEM_PROMPT =
  "You are the security analyzer for an agentic coding assistant. The agent wants to run a shell command; you issue the verdict. " +
  "You MUST call immunity_verdict with risk (none|low|high), outcome (ALLOWED|DENY|ASK_USER) and a short reason that tells the agent what to do instead; never respond in plain text.\n\n" +
  "Policy:\n" +
  "- ALLOWED (risk none|low): safe read-only and ordinary dev commands — listing/reading non-secret files, grep, git status/log/diff, node, builds, tests.\n" +
  "- DENY (risk high), reason explains the alternative:\n" +
  "  • destructive/irreversible commands: rm -rf, dd to devices, disk formatting\n" +
  "  • remote code execution patterns: curl/wget | sh/bash, eval of fetched content\n" +
  "  • working in /tmp (creating, modifying, deleting files there, running scripts from there): the agent must use the project cwd for temporary files\n" +
  "  • any git write: commit, push (incl. --force), reset, checkout, stash, branch -D, merge, rebase, clean, tag, remote changes — git state is sensitive\n" +
  "  • printing secret values from environment variables (echo $TOKEN, printenv TOKEN, env | grep TOKEN): checking existence (test -n \"$TOKEN\", ${TOKEN:+set}) is fine\n" +
  "  • reading secret files: ~/.ssh/**, id_rsa/id_ed25519, .env files, credentials, keychains\n" +
  "  • python for anything beyond a trivial one-liner: prefer node\n" +
  "- ASK_USER (delegate the decision, risk low|high), with context in the reason:\n" +
  "  • chmod/chmod +x creating an executable (ad-hoc scripts): the agent should prefer `bash -c '...'` so the script body stays visible to the LLM\n" +
  "  • installing packages: npm install/add, pnpm add, pip install, brew install, apt-get install and similar";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_STDOUT_BYTES = 1 << 20; // 1 MiB cap on the event stream
const MAX_STDERR_BYTES = 4 << 10;

export function defaultAnalysisToolPath(): string {
  return new URL("../subprocess/analysis-tool.ts", import.meta.url).pathname;
}

/** The verified subprocess invocation (spike 2 README, verbatim flag order). */
export function buildArgs(command: string, opts: VerdictOptions = {}): string[] {
  const args = [
    "--mode", "json",
    "--no-extensions",
    "--no-session",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--extension", opts.analysisToolPath ?? defaultAnalysisToolPath(),
    "--tools", "immunity_verdict",
  ];
  if (opts.provider) args.push("--provider", opts.provider);
  if (opts.model) args.push("--model", opts.model);
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  args.push("--system-prompt", opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT, command);
  return args;
}

function isRisk(x: unknown): x is Risk {
  return typeof x === "string" && (RISKS as readonly string[]).includes(x);
}

function isOutcome(x: unknown): x is Outcome {
  return typeof x === "string" && (OUTCOMES as readonly string[]).includes(x);
}

/** Validate the tool result payload; `content[0].text` is JSON.stringify(verdict). */
function parseVerdict(result: unknown): { ok: true; verdict: Verdict } | { ok: false; error: string } {
  const content = (result as { content?: unknown } | null)?.content;
  const first = Array.isArray(content) ? content[0] : undefined;
  const text = (first as { text?: unknown } | null)?.text;
  if (typeof text !== "string") return { ok: false, error: "tool result has no text content" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: `verdict is not JSON: ${text.slice(0, 120)}` };
  }
  const v = parsed as Record<string, unknown>;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return { ok: false, error: "verdict is not an object" };
  }
  if (!isRisk(v.risk)) return { ok: false, error: `invalid risk: ${JSON.stringify(v.risk)}` };
  if (!isOutcome(v.outcome)) return { ok: false, error: `invalid outcome: ${JSON.stringify(v.outcome)}` };
  if (v.reason !== undefined && typeof v.reason !== "string") {
    return { ok: false, error: "reason must be a string" };
  }
  const verdict: Verdict = { risk: v.risk, outcome: v.outcome };
  if (v.reason !== undefined) verdict.reason = v.reason;
  return { ok: true, verdict };
}

/**
 * Analyze one command. Resolves with the verdict, or with an inconclusive
 * failure (caller's default policy: prompt). The child is SIGKILLed as soon
 * as the verdict is in or the run fails — the subprocess is disposable.
 */
export function requestVerdict(command: string, opts: VerdictOptions = {}): Promise<VerdictResult> {
  return new Promise((resolve) => {
    const doSpawn: SpawnFn = opts.spawn ?? (spawn as SpawnFn);
    // empty string from config defaults must mean "pi on PATH", not spawn("")
    const piPath = opts.piPath?.trim() ? opts.piPath : "pi";
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let child: VerdictChild;
    try {
      child = doSpawn(piPath, buildArgs(command, opts), { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, kind: "spawn", error: String(err) });
      return;
    }

    let settled = false;
    let startCallId: string | null = null;
    let pending = "";
    let stderrTail = "";
    let killTimer: ReturnType<typeof setTimeout>;

    function finish(result: VerdictResult) {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve(result);
    }

    function onAbort() {
      finish({ ok: false, kind: "timeout", error: "analysis aborted" });
    }

    killTimer = setTimeout(() => {
      finish({ ok: false, kind: "timeout", error: `no verdict within ${timeoutMs}ms` });
    }, timeoutMs);
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort);

    function handleLine(line: string) {
      if (settled) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return; // non-JSON noise on the stream — ignored
      }
      if (event.type === "tool_execution_start" && event.toolName === "immunity_verdict") {
        if (typeof event.toolCallId === "string") startCallId = event.toolCallId;
        return;
      }
      if (event.type !== "tool_execution_end" || event.toolName !== "immunity_verdict") return;
      if (startCallId !== null && event.toolCallId !== startCallId) {
        finish({
          ok: false,
          kind: "parse",
          error: `tool call id mismatch (start ${startCallId}, end ${String(event.toolCallId)})`,
        });
        return;
      }
      const parsed = parseVerdict(event.result);
      if (parsed.ok) finish({ ok: true, verdict: parsed.verdict });
      else finish({ ok: false, kind: "parse", error: parsed.error });
    }

    child.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      if (pending.length > MAX_STDOUT_BYTES) {
        finish({ ok: false, kind: "output", error: "analysis output exceeded 1 MiB" });
        return;
      }
      let nl: number;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (line) handleLine(line.replace(/\r$/, ""));
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-MAX_STDERR_BYTES);
    });

    child.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      finish({ ok: false, kind: "spawn", error: `failed to spawn ${piPath}: ${message}` });
    });

    child.on("close", () => {
      if (settled) return;
      const tail = stderrTail.trim();
      finish({
        ok: false,
        kind: "no-verdict",
        error: `subprocess exited without a verdict${tail ? `; stderr: ${tail.slice(0, 200)}` : ""}`,
      });
    });
  });
}
