/**
 * Sibling-verdict preflight.
 *
 * pi runs the tool_call handlers of one assistant message sequentially
 * ("preflighted sequentially, then executed concurrently"), so awaiting
 * the LLM analysis inline serializes sibling commands: N bash calls cost
 * N verdict latencies. But the full assistant message — all sibling tool
 * calls — is already in the session manager when the first handler runs
 * (pi drains Agent events through AgentSession before tool_call fires).
 * The first handler therefore starts a verdict subprocess for EVERY bash
 * sibling; the later handlers consume their already-running verdict and
 * the batch costs roughly one analysis latency in total.
 *
 * Batch bookkeeping: entries are keyed by toolCallId; a later handler
 * finds its id in the map and skips the preflight. Entries the pipeline
 * never consumes (session-resolved siblings are marked null) are dropped
 * when the next batch starts. `null` marks "deliberately not started" so
 * a session-resolved sibling does not re-trigger the preflight.
 */
import { requestVerdict, type VerdictOptions, type VerdictResult } from "./llm-client.ts";
import { grantKey } from "./pipeline.ts";
import type { LlmConfig } from "./config.ts";
import type { SessionState } from "./session.ts";

/** One bash sibling tool call of the current assistant message. */
export interface BashSibling {
  id: string;
  command: string;
}

/**
 * Extract the bash tool calls of the assistant message containing
 * toolCallId. Structural typing keeps this module pure — the message
 * shape is pi's AgentMessage (role + content blocks of type "toolCall").
 * Returns null when toolCallId is not in the last assistant message
 * (unexpected state — the caller falls back to inline analysis).
 */
export function bashSiblings(messages: readonly unknown[], toolCallId: string): BashSibling[] | null {
  let last: { content?: unknown } | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown } | undefined;
    if (m?.role === "assistant") {
      last = m as { content?: unknown };
      break;
    }
  }
  if (!Array.isArray(last?.content)) return null;
  const siblings: BashSibling[] = [];
  let found = false;
  for (const block of last.content) {
    const tc = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: { command?: unknown } } | null;
    if (tc?.type !== "toolCall" || typeof tc.id !== "string") continue;
    if (tc.id === toolCallId) found = true;
    if (tc.name === "bash" && typeof tc.arguments?.command === "string" && tc.arguments.command.trim()) {
      siblings.push({ id: tc.id, command: tc.arguments.command });
    }
  }
  return found ? siblings : null;
}

export interface PreflightEnv {
  /** session statements — resolved siblings are marked null, not analyzed */
  session?: SessionState | null;
  cwd: string;
  home: string;
  llm: LlmConfig;
  /** compact policy feed (same construction as the inline path) */
  policy: string;
  /** max analyzer subprocesses running at once (llm.maxParallel, default 8) */
  maxParallel: number;
  /** session abort signal (ctx.signal) */
  signal?: AbortSignal;
  /** injectable for tests */
  request?: typeof requestVerdict;
}

/**
 * Start a verdict for every bash sibling the pipeline would actually
 * analyze (session-resolved siblings are marked null — the pipeline
 * short-circuits before the LLM). Returns this call's verdict promise,
 * or undefined when this sibling is session-resolved (its handler will
 * short-circuit too, so no verdict is needed).
 */
export function startSiblingVerdicts(
  siblings: readonly BashSibling[],
  toolCallId: string,
  env: PreflightEnv,
  batch: Map<string, Promise<VerdictResult> | null>,
): Promise<VerdictResult> | undefined {
  batch.clear();
  const request = env.request ?? requestVerdict;

  /** verdict jobs in sibling order; session-resolved siblings are marked null — the pipeline short-circuits before the LLM */
  const jobs: { id: string; command: string; opts: VerdictOptions }[] = [];
  for (const s of siblings) {
    const key = grantKey({ kind: "bash", command: s.command, cwd: env.cwd, home: env.home });
    if (env.session && (env.session.isAllowed(key) || env.session.isDenied(key))) {
      batch.set(s.id, null);
      continue;
    }
    jobs.push({
      id: s.id,
      command: s.command,
      opts: {
        provider: env.llm.provider,
        model: env.llm.model,
        userPrompt: env.llm.userPrompt,
        piPath: env.llm.piPath,
        timeoutMs: env.llm.timeoutMs,
        signal: env.signal,
        cwd: env.cwd,
        policy: env.policy,
      },
    });
  }

  // concurrency cap: at most maxParallel subprocesses at once, the rest
  // queue and start as slots free. Batches never overlap (every handler
  // of a batch resolves before the next assistant message preflights),
  // so a per-batch scheduler is equivalent to a global one.
  const max = Math.max(1, env.maxParallel);
  const deferred = jobs.map(() => Promise.withResolvers<VerdictResult>());
  let next = 0;
  let active = 0;
  const pump = () => {
    while (active < max && next < jobs.length) {
      const i = next++;
      active++;
      request(jobs[i].command, jobs[i].opts).then((r) => {
        active--;
        deferred[i].resolve(r);
        pump();
      });
    }
  };
  pump();

  for (const [i, job] of jobs.entries()) batch.set(job.id, deferred[i].promise);
  return batch.get(toolCallId) ?? undefined;
}
