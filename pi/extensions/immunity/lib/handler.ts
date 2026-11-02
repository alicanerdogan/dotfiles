/**
 * Tool-call interception flow: the single entry point
 * that runs the pipeline and turns outcomes into user-visible behavior.
 * Pure module — index.ts adapts pi events into ToolRequest and builds the
 * HandlerEnv (ui, bus, config, session state, session id, paths).
 *
 * Flow per call:
 *   pipeline → allow: return
 *           → block:  audit + blocked event + block (silent — session
 *                     statements and promptWhen='asked' denies)
 *           → prompt: enqueue the complete approval flow (dialogs never
 *                     overlap), recheck the request with the existing
 *                     verdict, then prompt:opened, hooks.afterPrompt,
 *                     decision menu — the command first, then the
 *                     suggestion step for the analyzer's flagged paths
 *                     (only after an Allow), prompt:closed in finally;
 *                     allow → decided event, block → audit + blocked
 *                     event + block. A failed analysis adds a manual
 *                     *Retry analysis* option that loops the whole
 *                     pipeline (fresh verdict trail per attempt;
 *                     uncapped, user-driven). An aborted flow returns a
 *                     block without persisting rules or auditing the
 *                     cancellation as a user decision.
 *
 * Concurrency: one ApprovalQueue serializes complete flows; the session's
 * AnalysisLimiter caps analyzer calls across preflights, nested calls and
 * retries; a refcounted StatusCounter keeps the analysis indicator visible
 * until every concurrent analysis finishes.
 *
 * Decision menus: whole commands are a plain Allow/Deny (one-shot, no
 * rules); file paths use the six-option scope menu. Suggestions are asked
 * only when execution is allowed — a Deny skips them; a Protect persists a
 * deny rule for future commands without blocking the allowed one. Session
 * choices land in the in-memory SessionState (final for the session);
 * project/global choices write rules via writeRule + reflect into the
 * in-memory merged config and the scoped rule views (effective
 * immediately).
 */
import {
  runPipeline,
  grantKey,
  type LlmStage,
  type Outcome,
  type PipelineOptions,
  type PipelineResult,
  type Suggestions,
  type ToolRequest,
} from "./pipeline.ts";
import type { SessionState } from "./session.ts";
import type { CommandRule, ImmunityConfig, PathRule } from "./config.ts";
import { expandPath } from "./paths.ts";
import type { Bus } from "./bus.ts";
import { emitBlocked, emitDecided, emitPromptClosed, emitPromptOpened, newPromptId } from "./bus.ts";
import { runPromptFlow, runSuggestionStep, runCommandPrompt, type PromptResult, type PromptUi, type SuggestionChoice } from "./prompt.ts";
import { appendAudit, blockMessage, type BlockSource } from "./audit.ts";
import { writeRule, type RuleKind } from "./rules.ts";
import { runPromptCommand } from "./notify.ts";
import type { VerdictResult } from "./llm-client.ts";
import type { ApprovalQueue } from "./queue.ts";
import type { AnalysisLimiter } from "./limiter.ts";

/** Live scoped rule views (project overrules global); index.ts keeps them in sync with the merged config. */
export interface ScopedRuleViews {
  paths: { project: PathRule[]; global: PathRule[] };
  commands: { project: CommandRule[]; global: CommandRule[] };
}

export interface HandlerEnv {
  config: ImmunityConfig;
  /** live scoped rule views (project overrules global) */
  rules: ScopedRuleViews;
  /** in-memory session statements (six-option menu "for session" choices) */
  session: SessionState;
  /** serializes complete approval flows so dialogs never overlap */
  approvals: ApprovalQueue;
  /** session-wide analyzer limiter shared by preflights, nested calls and retries */
  limiter?: AnalysisLimiter;
  bus: Bus;
  sessionId: string;
  cwd: string;
  home: string;
  ui: PromptUi & { notify(message: string, type?: "info" | "warning" | "error"): void };
  /** status line while the pipeline runs (index.ts adapts to ctx.ui.setStatus) */
  setStatus?: (label: string | null) => void;
  log?: (msg: string) => void;
  /** session abort signal → passes through to the LLM client */
  signal?: AbortSignal;
  /** injectable LLM client for tests */
  llmClient?: (command: string, opts: { cwd: string; policy: string; provider?: string; model?: string; userPrompt?: string; piPath?: string; timeoutMs?: number; signal?: AbortSignal }) => Promise<VerdictResult>;
  /** injectable gitignore check for tests; default: real `git check-ignore` */
  gitIgnoreCheck?: (path: string, cwd: string) => Promise<boolean>;
  /** audit JSONL path; null disables auditing */
  auditFile: string | null;
  /** config scope file rule writes go to (project when trusted, else global) */
  ruleScope: string;
  /** global config scope file ("… globally" menu choices write here) */
  globalRuleScope: string;
  /** kind for persisted path rules (index.ts stats the target) */
  pathKindFor?: (target: string) => "file" | "directory";
  /** override for the rule-persist hook (default: writeRule to the chosen scope) */
  saveRule?: (kind: RuleKind, value: string, scope: "project" | "global", opts?: { pathKind?: "file" | "directory" }) => boolean | Promise<boolean>;
  /** default: runPromptCommand with the 30 s kill */
  onPromptCommand?: (command: string, env: Record<string, string>) => void;
}

export type HandlerResult = { allow: true } | { allow: false; reason: string };

/** Rewrite a resolved target as `~/…` when under home (durable rules). */
export function toHomePath(target: string, home: string): string {
  if (target === home) return "~";
  if (target.startsWith(home + "/")) return `~/${target.slice(home.length + 1)}`;
  return target;
}

function featureOf(req: ToolRequest): "bash" | "file" {
  return req.kind;
}

function actionOf(req: ToolRequest): string {
  if (req.kind === "bash") return req.command;
  return req.target;
}

function toolOf(req: ToolRequest): string {
  return req.kind === "bash" ? "bash" : req.tool;
}

function resolved(req: ToolRequest): string {
  if (req.kind !== "file") return "";
  return expandPath(req.target, { cwd: req.cwd, home: req.home });
}

/** Reason returned when the session aborts a queued or active approval flow. */
export const CANCELLED_REASON = "Blocked: immunity approval cancelled";

export async function handleToolCall(
  req: ToolRequest,
  env: HandlerEnv,
  /** verdict pre-started by the sibling batch preflight; first attempt only */
  prestartedVerdict?: Promise<VerdictResult>,
): Promise<HandlerResult> {
  const { config } = env;
  const status = env.setStatus;
  const announce = !config.llm.disabled;
  // the prestarted verdict is valid for the first attempt only — a manual
  // "Retry analysis" means a fresh verdict trail
  let prestarted = prestartedVerdict;

  // Each analysis attempt runs the pipeline once; a "Retry analysis"
  // choice loops back here for a fresh attempt (user-driven, uncapped).
  for (;;) {
    // status is refcounted in index.ts: the first concurrent handler shows
    // the indicator, the last one clears it.
    if (status && announce) status("immunity: analyzing…");
    let r: PipelineResult;
    try {
      r = await runPipeline(req, pipelineOptions(env, prestarted));
    } finally {
      if (status && announce) status(null);
    }
    prestarted = undefined;

    auditVerdict(req, env, r);
    const outcome = r.outcome;
    if (outcome.outcome === "allow") return { allow: true };
    if (outcome.outcome === "block") return blockOutcome(req, env, outcome);

    // Prompt. Complete approval flows are queued so concurrent tool calls
    // cannot compete for the UI. Before opening a dialog, recheck the request
    // — reusing the verdict already produced — against permissions or blocks
    // granted while it was waiting (or between analysis and the dialog).
    const flow = await env.approvals.run(async () => {
      const recheck = await runPipeline(req, pipelineOptions(env, prestartedOf(r)));
      if (recheck.outcome.outcome === "allow") return { allow: true } as HandlerResult;
      if (recheck.outcome.outcome === "block") return blockOutcome(req, env, recheck.outcome);
      const current = recheck.outcome;
      return runMenu(req, env, current.reason, current.suggestions, current.llmFailed);
    }, env.signal);

    if (!flow.started) return { allow: false, reason: CANCELLED_REASON };
    const menu = flow.result;
    if (menu === undefined) return { allow: false, reason: CANCELLED_REASON };
    if (menu === "retry") continue;
    return menu;
  }
}

/** Pipeline options shared by the first attempt and a queued-flow recheck. */
function pipelineOptions(env: HandlerEnv, prestartedVerdict?: Promise<VerdictResult>): PipelineOptions {
  return {
    strict: env.config.strict,
    paths: env.rules.paths,
    commands: env.rules.commands,
    promptWhen: env.config.commands.promptWhen,
    llm: env.config.llm,
    session: env.session,
    gitIgnoreCheck: env.gitIgnoreCheck,
    llmClient: env.llmClient,
    limiter: env.limiter,
    prestartedVerdict,
    signal: env.signal,
  };
}

/** Reuse the verdict from the first attempt — a recheck must not analyze again. */
function prestartedOf(result: PipelineResult): Promise<VerdictResult> | undefined {
  const stage = result.stages.find((s): s is LlmStage => s.stage === "llm");
  return stage ? Promise.resolve(stage.result) : undefined;
}

/** Verdict trail: one line per LLM analysis attempt (retries included). */
function auditVerdict(req: ToolRequest, env: HandlerEnv, result: PipelineResult): void {
  if (!env.auditFile) return;
  const stage = result.stages.find((s): s is LlmStage => s.stage === "llm");
  if (!stage) return;
  const res = stage.result;
  appendAudit(
    {
      event: "verdict",
      ts: new Date().toISOString(),
      sessionId: env.sessionId,
      tool: toolOf(req),
      action: actionOf(req),
      risk: res.ok ? res.verdict.risk : null,
      outcome: res.ok ? res.verdict.outcome : null,
      reason: res.ok ? res.verdict.reason : undefined,
      suggestedPaths: res.ok ? res.verdict.paths?.blocked : undefined,
      suggestedCommands: res.ok ? res.verdict.commands?.blocked : undefined,
      failure: res.ok ? undefined : `${res.kind}: ${res.error}`,
      llm: {
        provider: env.config.llm.provider || undefined,
        model: env.config.llm.model || undefined,
      },
    },
    env.auditFile,
  );
}

/** Silent block: audit entry + blocked event + block message. */
function blockOutcome(req: ToolRequest, env: HandlerEnv, outcome: Extract<Outcome, { outcome: "block" }>): HandlerResult {
  const source: BlockSource = outcome.source;
  if (env.auditFile) {
    appendAudit(
      {
        event: "block",
        ts: new Date().toISOString(),
        sessionId: env.sessionId,
        tool: toolOf(req),
        action: actionOf(req),
        reason: outcome.reason,
        source,
      },
      env.auditFile,
    );
  }
  emitBlocked(env.bus, {
    feature: featureOf(req),
    action: actionOf(req),
    reason: outcome.reason,
    block: { source },
    context: { sessionId: env.sessionId },
  });
  return { allow: false, reason: blockMessage(source, outcome.reason) };
}

async function runMenu(
  req: ToolRequest,
  env: HandlerEnv,
  reason: string,
  suggestions?: Suggestions,
  /** the analysis failed → the command menu adds a manual *Retry analysis* option */
  llmFailed?: boolean,
): Promise<HandlerResult | "retry"> {
  const promptId = newPromptId();
  const feature = featureOf(req);
  emitPromptOpened(env.bus, { prompt: { id: promptId, feature, reason } });
  try {
    const onPrompt = env.onPromptCommand ?? runPromptCommand;
    onPrompt(env.config.hooks.afterPrompt, {
      IMMUNITY_PROMPT_ID: promptId,
      IMMUNITY_FEATURE: feature,
      IMMUNITY_REASON: reason,
      IMMUNITY_ACTION: actionOf(req),
    });

    const scopePath = (scope: "project" | "global") =>
      scope === "global" ? env.globalRuleScope : env.ruleScope;
    const saveRuleImpl =
      env.saveRule ??
      ((kind: RuleKind, value: string, scope: "project" | "global", opts?: { pathKind?: "file" | "directory" }) =>
        writeRule(scopePath(scope), kind, value, opts));

    const action = actionOf(req);
    const tool = toolOf(req);

    /* Step 1 — the command decision. Whole commands are a plain Allow/Deny
     * (scope choices make sense only for flagged subsections); file paths
     * keep the six-option scope menu — a path is a durable rule target.
     * Denying the command ends here: flagged-path suggestions are only
     * asked once execution is allowed. When the analysis failed, a manual
     * *Retry analysis* option loops back to re-run it. */
    if (req.kind === "bash") {
      const result = await runCommandPrompt({ ui: env.ui, reason, retryable: llmFailed, signal: env.signal });
      if (result.action === "cancel") return { allow: false, reason: CANCELLED_REASON };
      if (result.action === "retry") return "retry";
      if (result.action === "block") {
        // user denied the command — one-shot; no rule, no session statement
        return blockCall(req, env, feature, action, tool, reason, result.userReason);
      }
      if (env.auditFile) {
        appendAudit(
          {
            event: "decision",
            ts: new Date().toISOString(),
            sessionId: env.sessionId,
            tool,
            action,
            kind: "allow",
            scope: "call",
            reason,
          },
          env.auditFile,
        );
      }
      emitDecided(env.bus, { feature, action, decision: { kind: "allow", scope: "call" } });

      /* Step 2 — execution allowed (bash): settle the analyzer's flagged
       * paths into durable rules for future commands. Protecting a path
       * writes a deny rule but does not block — the command was already
       * allowed. A failed/dismissed suggestion prompt never undoes the
       * explicit Allow. */
      if (suggestions) {
        const sug = await runSuggestionStep({
          ui: env.ui,
          reason,
          suggestions,
          session: env.session,
          saveRule: saveRuleImpl,
          pathKindFor: env.pathKindFor,
          signal: env.signal,
        });
        for (const choice of sug.choices) auditSuggestionChoice(req, env, choice);
        if (sug.cancelled) return { allow: false, reason: CANCELLED_REASON };
      }
      return { allow: true };
    }

    // file paths — the six-option scope menu
    const path = toHomePath(resolved(req), env.home);
    const result = await runPromptFlow({
      ui: env.ui,
      reason,
      sessionKey: grantKey(req),
      session: env.session,
      saveRule: saveRuleImpl,
      path,
      pathKind: env.pathKindFor?.(path) ?? "file",
      signal: env.signal,
    });

    // a cancelled dialog is not a user decision — nothing to audit or emit
    if (result.cancelled) return { allow: false, reason: CANCELLED_REASON };

    // audit the choice + emit the decided event
    if (env.auditFile) {
      if (result.scope === "session") {
        appendAudit(
          {
            event: "session",
            ts: new Date().toISOString(),
            sessionId: env.sessionId,
            tool,
            action,
            kind: result.action === "allow" ? "sessionAllow" : "sessionDeny",
            value: action,
            scope: "session",
            pathKind: result.pathKind,
          },
          env.auditFile,
        );
      } else {
        appendAudit(
          {
            event: "rule",
            ts: new Date().toISOString(),
            sessionId: env.sessionId,
            tool,
            action,
            kind: result.action === "allow" ? "pathAllow" : "pathDeny",
            value: result.pathValue ?? path ?? req.target,
            scope: result.scope,
            source: "menu",
            persisted: result.persisted ?? false,
            pathKind: result.pathKind,
          },
          env.auditFile,
        );
      }
    }

    emitDecided(env.bus, {
      feature,
      action,
      decision: {
        kind: result.action,
        scope: result.scope,
        persisted: result.scope === "session" ? undefined : result.persisted,
      },
    });

    if (result.action === "allow") {
      return { allow: true };
    }

    // user blocked — reason overwrites the model's reason
    const entry = auditEntry(req, env, "user", reason, result.userReason);
    if (env.auditFile) appendAudit(entry, env.auditFile);
    emitBlocked(env.bus, {
      feature,
      action,
      reason,
      block: { source: "user", userReason: result.userReason },
      context: { sessionId: env.sessionId },
    });
    return { allow: false, reason: blockMessage("user", reason, result.userReason) };
  } finally {
    emitPromptClosed(env.bus, { prompt: { id: promptId, feature, reason } });
  }
}

/** Block the call: audit entry + blocked event + block message. */
function blockCall(
  req: ToolRequest,
  env: HandlerEnv,
  feature: "bash" | "file",
  action: string,
  tool: string,
  reason: string,
  userReason?: string,
): HandlerResult {
  if (env.auditFile) {
    appendAudit(
      {
        event: "block",
        ts: new Date().toISOString(),
        sessionId: env.sessionId,
        tool,
        action,
        reason,
        userReason,
        source: "user",
      },
      env.auditFile,
    );
  }
  emitBlocked(env.bus, {
    feature,
    action,
    reason,
    block: { source: "user", userReason },
    context: { sessionId: env.sessionId },
  });
  return { allow: false, reason: blockMessage("user", reason, userReason) };
}

/** Audit one suggestion-step choice (rule or session statement). */
function auditSuggestionChoice(req: ToolRequest, env: HandlerEnv, choice: SuggestionChoice): void {
  if (!env.auditFile || choice.action === "skip") return;
  const ts = new Date().toISOString();
  if (choice.scope === "session") {
    appendAudit(
      {
        event: "session",
        ts,
        sessionId: env.sessionId,
        tool: toolOf(req),
        action: actionOf(req),
        kind: "sessionAllow",
        value: choice.value,
        scope: "session",
        pathKind: choice.pathKind,
      },
      env.auditFile,
    );
    return;
  }
  appendAudit(
    {
      event: "rule",
      ts,
      sessionId: env.sessionId,
      tool: toolOf(req),
      action: actionOf(req),
      kind: choice.action === "protect" ? "pathDeny" : "pathAllow",
      value: choice.value,
      scope: choice.scope,
      source: "suggestion",
      persisted: choice.persisted ?? false,
      pathKind: choice.pathKind,
    },
    env.auditFile,
  );
}

function auditEntry(
  req: ToolRequest,
  env: HandlerEnv,
  source: BlockSource,
  reason: string,
  userReason?: string,
): { event: "block"; ts: string; sessionId: string; tool: string; action: string; reason: string; userReason?: string; source: BlockSource } {
  return {
    event: "block",
    ts: new Date().toISOString(),
    sessionId: env.sessionId,
    tool: toolOf(req),
    action: actionOf(req),
    reason,
    userReason,
    source,
  };
}
