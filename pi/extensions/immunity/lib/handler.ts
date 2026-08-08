/**
 * Tool-call interception flow (design §2): the single entry point that
 * runs the pipeline and turns outcomes into user-visible behavior.
 * Pure module — index.ts adapts pi events into ToolRequest and builds the
 * HandlerEnv (ui, bus, config, grants, session id, paths).
 *
 * Flow per call:
 *   pipeline → allow: return
 *           → notify: ui.notify(reason), return
 *           → prompt: prompt:opened event, onPromptCommand, runPromptFlow,
 *                      prompt:closed in finally; allow → grant event,
 *                      deny → audit + blocked event + block
 *           → block:  audit + blocked event + block
 */
import { runPipeline, grantKey, type Suggestions, type ToolRequest } from "./pipeline.ts";
import type { GrantStore } from "./grants.ts";
import type { ImmunityConfig } from "./config.ts";
import { expandPath } from "./paths.ts";
import type { Bus } from "./bus.ts";
import { emitBlocked, emitGrantCreated, emitPromptClosed, emitPromptOpened, newPromptId } from "./bus.ts";
import { runPromptFlow, type PromptResult, type PromptUi } from "./prompt.ts";
import { appendAudit, blockMessage, type BlockSource } from "./audit.ts";
import { writeRule } from "./rules.ts";
import { runPromptCommand } from "./notify.ts";
import type { VerdictOptions, VerdictResult } from "./llm-client.ts";
import type { MemoryGrantStore } from "./grants.ts";

export interface HandlerEnv {
  config: ImmunityConfig;
  /** grant checks for the pipeline (session + persisted composite) */
  grants: GrantStore;
  /** session grant store the prompt flow writes "Allow for session" into */
  sessionGrants: Pick<MemoryGrantStore, "add">;
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
  llmClient?: (command: string, opts: VerdictOptions) => Promise<VerdictResult>;
  /** audit JSONL path; null disables auditing */
  auditFile: string | null;
  /** config scope file that rule conversion + always-grants write to */
  ruleScope: string;
  /** global config scope file ("… (global)" suggestion options write here) */
  globalRuleScope?: string;
  /** kind for persisted path allows (index.ts stats the target) */
  pathKindFor?: (target: string) => "file" | "directory";
  /** overrides for the deny-rule / always-grant persist hooks (default: writeRule to ruleScope) */
  saveRule?: (kind: "autoDeny" | "path", value: string, scope?: "project" | "global") => boolean | Promise<boolean>;
  persistGrant?: (kind: "command" | "path", value: string, scope?: "project" | "global") => boolean | Promise<boolean>;
  /** default: runPromptCommand with the 30 s kill */
  onPromptCommand?: (command: string, env: Record<string, string>) => void;
}

export type HandlerResult = { allow: true } | { allow: false; reason: string };

/** Rewrite a resolved target as `~/…` when under home (durable grants). */
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
  return `${req.access} ${req.target}`;
}

function auditEntry(req: ToolRequest, env: HandlerEnv, source: BlockSource, reason: string, userReason?: string) {
  return {
    event: "block" as const,
    ts: new Date().toISOString(),
    sessionId: env.sessionId,
    tool: req.kind === "bash" ? "bash" : req.tool,
    action: actionOf(req),
    reason,
    userReason,
    source,
  };
}

export async function handleToolCall(req: ToolRequest, env: HandlerEnv, retries = 0): Promise<HandlerResult> {
  const { config } = env;
  const status = env.setStatus;
  try {
    if (status && config.llm.enabled) status("immunity: analyzing…");
    const r = await runPipeline(req, {
      rules: config.commands,
      pathRules: config.pathnames,
      llm: config.llm,
      ts: config.treeSitter,
      prompting: config.prompting,
      grants: env.grants,
      notify: (msg) => env.ui.notify(`immunity: ${msg}`, "warning"),
      llmClient: env.llmClient,
      signal: env.signal,
    });
    const { outcome, stages } = r;

    // verdict trail: one line per LLM analysis, so "why did this pass?"
    // is answerable from the audit log (ALLOWED, DENY, ASK_USER, or failure)
    if (env.auditFile) {
      const llmStage = stages.find((s): s is { stage: "llm"; result: VerdictResult } => s.stage === "llm");
      if (llmStage) {
        const res = llmStage.result;
        appendAudit(
          {
            event: "verdict",
            ts: new Date().toISOString(),
            sessionId: env.sessionId,
            tool: req.kind === "bash" ? "bash" : req.tool,
            action: actionOf(req),
            risk: res.ok ? res.verdict.risk : null,
            outcome: res.ok ? res.verdict.outcome : null,
            reason: res.ok ? res.verdict.reason : undefined,
            suggestedPaths: res.ok ? res.verdict.paths?.blocked : undefined,
            suggestedCommands: res.ok ? res.verdict.commands?.blocked : undefined,
            failure: res.ok ? undefined : `${res.kind}: ${res.error}`,
            llm: {
              provider: config.llm.provider || undefined,
              model: config.llm.model || undefined,
            },
          },
          env.auditFile,
        );
      }
    }

    if (outcome.outcome === "allow") return { allow: true };

    if (outcome.outcome === "notify") {
      env.ui.notify(`immunity: ${outcome.reason}`, "warning");
      return { allow: true };
    }

    if (outcome.outcome === "prompt") {
      return prompt(req, env, outcome.reason, outcome.source, outcome.suggestions, retries);
    }

    // block (deterministic deny or llm autoDeny)
    const source: BlockSource = outcome.source;
    const entry = auditEntry(req, env, source, outcome.reason);
    if (env.auditFile) appendAudit(entry, env.auditFile);
    emitBlocked(env.bus, {
      feature: featureOf(req),
      action: actionOf(req),
      reason: outcome.reason,
      block: { source },
      context: { sessionId: env.sessionId },
    });
    return { allow: false, reason: blockMessage(source, outcome.reason) };
  } finally {
    if (status) status(null);
  }
}

async function prompt(
  req: ToolRequest,
  env: HandlerEnv,
  reason: string,
  source: "policy" | "llm",
  suggestions: Suggestions | undefined,
  retries = 0,
): Promise<HandlerResult> {
  const promptId = newPromptId();
  const feature = featureOf(req);
  emitPromptOpened(env.bus, { prompt: { id: promptId, feature, reason } });
  try {
    const onPrompt = env.onPromptCommand ?? runPromptCommand;
    onPrompt(env.config.prompting.onPromptCommand, {
      IMMUNITY_PROMPT_ID: promptId,
      IMMUNITY_FEATURE: feature,
      IMMUNITY_REASON: reason,
      IMMUNITY_ACTION: actionOf(req),
    });

    const key = grantKey(req);
    const protectPath = req.kind === "file" ? toHomePath(resolved(req), env.home) : undefined;
    const command = req.kind === "bash" ? req.command : undefined;
    const scopePath = (scope: "project" | "global" | undefined) =>
      scope === "global" ? env.globalRuleScope ?? env.ruleScope : env.ruleScope;
    const saveRuleImpl =
      env.saveRule ??
      ((kind: "autoDeny" | "path", value: string, scope?: "project" | "global") =>
        writeRule(scopePath(scope), kind === "autoDeny" ? "autoDeny" : "path", value));
    const persistGrantImpl =
      env.persistGrant ??
      ((kind: "command" | "path", value: string, scope?: "project" | "global") =>
        writeRule(
          scopePath(scope),
          kind === "command" ? "commandAllow" : "pathAllow",
          value,
          kind === "path" ? { pathKind: env.pathKindFor?.(value) ?? "file" } : undefined,
        ));

    const result = await runPromptFlow({
      ui: env.ui,
      reason,
      grantKey: key,
      grants: env.sessionGrants,
      prompting: env.config.prompting,
      command,
      protectPath,
      saveRule: saveRuleImpl,
      persistGrant: persistGrantImpl,
      suggestions,
    });

    if (result.action === "suggestion") {
      return applySuggestion(req, env, result, reason, retries, saveRuleImpl, persistGrantImpl);
    }

    if (result.action === "allow") {
      if (result.grant !== "once") {
        emitGrantCreated(env.bus, {
          feature,
          action: actionOf(req),
          grant: { scope: result.grant, persisted: result.grant === "always" ? result.persisted : undefined },
        });
      }
      return { allow: true };
    }

    const userReason = result.userReason;
    const entry = auditEntry(req, env, "user", reason, userReason);
    if (env.auditFile) appendAudit(entry, env.auditFile);
    emitBlocked(env.bus, {
      feature,
      action: actionOf(req),
      reason,
      block: { source: "user", userReason },
      context: { sessionId: env.sessionId },
    });
    return { allow: false, reason: blockMessage("user", reason, userReason) };
  } finally {
    emitPromptClosed(env.bus, { prompt: { id: promptId, feature, reason } });
  }
}

function resolved(req: ToolRequest): string {
  if (req.kind !== "file") return "";
  return expandPath(req.target, { cwd: req.cwd, home: req.home });
}

/**
 * A suggestion-driven rule write: audit the user's choice, persist the rule
 * to the chosen scope, then: allow → retry the pipeline once (the LLM must
 * see the updated policy); protect/block → block the call (deterministic).
 */
async function applySuggestion(
  req: ToolRequest,
  env: HandlerEnv,
  result: Extract<PromptResult, { action: "suggestion" }>,
  reason: string,
  retries: number,
  saveRuleImpl: (kind: "autoDeny" | "path", value: string, scope?: "project" | "global") => boolean | Promise<boolean>,
  persistGrantImpl: (kind: "command" | "path", value: string, scope?: "project" | "global") => boolean | Promise<boolean>,
): Promise<HandlerResult> {
  const action = actionOf(req);
  const tool = req.kind === "bash" ? "bash" : req.tool;
  if (env.auditFile) {
    appendAudit(
      {
        event: "rule",
        ts: new Date().toISOString(),
        sessionId: env.sessionId,
        tool,
        action,
        kind: result.kind,
        value: result.value,
        scope: result.scope,
        source: "suggestion",
      },
      env.auditFile,
    );
  }

  if (result.kind === "path") {
    await saveRuleImpl("path", result.value, result.scope);
  } else if (result.kind === "autoDeny") {
    await saveRuleImpl("autoDeny", result.value, result.scope);
  } else {
    await persistGrantImpl("path", result.value, result.scope);
  }

  // allow → retry once (the LLM must see the updated policy); the retry may
  // prompt again if the rule did not cover the command (honest loop)
  if (result.kind === "pathAllow") {
    if (retries >= 2) return { allow: true }; // explicit override, twice confirmed
    return handleToolCall(req, env, retries + 1);
  }

  // protect/block → the call stays blocked
  const entry = auditEntry(req, env, "user", reason);
  if (env.auditFile) appendAudit(entry, env.auditFile);
  emitBlocked(env.bus, {
    feature: featureOf(req),
    action,
    reason,
    block: { source: "user", userReason: `saved rule (${result.kind} ${result.value}, ${result.scope})` },
    context: { sessionId: env.sessionId },
  });
  return { allow: false, reason: blockMessage("user", reason) };
}
