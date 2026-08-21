/**
 * Analysis pipeline (design updates doc): session statements → LLM (bash)
 * or deterministic rules (files) → fallback/strict.
 *
 * Session statements are checked first and are final: an allow short-
 * circuits everything (no LLM call), a deny blocks silently.
 *
 * Files are deterministic-only: project rules → global rules → hard
 * defaults (outside cwd / gitignored = blocked). Every non-allow outcome
 * surfaces as a prompt with the six-option menu — ask and deny rules both
 * prompt (blocked requests are prompted); they differ in reason text and
 * in the LLM policy feed.
 *
 * Commands are LLM-judged when the LLM layer is enabled: the rules are fed
 * to the analyzer as context (project first, then global; the LLM resolves
 * conflicts). `commands.promptWhen` maps verdicts to behavior:
 *   asked     — only ask-rule requests prompt; DENY verdicts block silently
 *   blocked   — asks and blocks prompt (default)
 *   everytime — prompt after every verdict (debugging)
 * When the LLM is disabled or inconclusive, the deterministic fallback
 * decides: regex if present, else string matching per `exact`. With no
 * rule match, `strict` decides — prompt (default) or allow.
 */
import { matchRules } from "./commands.ts";
import { evaluatePath, expandPath, scopeDecision, type PathEval } from "./paths.ts";
import { requestVerdict, type Verdict, type VerdictOptions, type VerdictResult } from "./llm-client.ts";
import type { CommandRule, LlmConfig, PathRule, PromptWhen } from "./config.ts";
import { SessionState } from "./session.ts";

/* ------------------------------------------------------------------ */
/* Request model                                                       */
/* ------------------------------------------------------------------ */

export type ToolRequest =
  | { kind: "bash"; command: string; cwd: string; home: string }
  | { kind: "file"; tool: string; target: string; cwd: string; home: string };

/** Stable session-statement key (same shape for bash and file requests). */
export function grantKey(req: ToolRequest): string {
  if (req.kind === "bash") return `bash:${req.command}`;
  return `file:${expandPath(req.target, { cwd: req.cwd, home: req.home })}`;
}

/* ------------------------------------------------------------------ */
/* Stage traces + outcomes                                             */
/* ------------------------------------------------------------------ */

export interface SessionStage {
  stage: "session";
  denied: boolean;
  allowed: boolean;
}

export interface LlmStage {
  stage: "llm";
  result: VerdictResult;
  verdict?: Verdict;
}

export interface RulesStage {
  stage: "rules";
  /** deterministic fallback decision (commands) or file evaluation */
  decision: { action: "allow" | "ask" | "deny"; scope: "project" | "global" | "default"; rule?: CommandRule | PathRule } | null;
  path?: PathEval;
}

export type Stage = SessionStage | LlmStage | RulesStage;

export type BlockSource = "session" | "policy" | "llm";
export type PromptSource = "policy" | "llm" | "default";

/** Actionable suggestions the LLM returned with a rejection (path step). */
export interface Suggestions {
  paths: string[];
  commands: { raw: string; general?: string }[];
}

export type Outcome =
  | { outcome: "allow"; reason: string }
  | { outcome: "prompt"; reason: string; source: PromptSource; suggestions?: Suggestions; llmFailed?: boolean }
  | { outcome: "block"; reason: string; source: BlockSource };

export interface PipelineResult {
  outcome: Outcome;
  stages: Stage[];
}

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

export interface PipelineOptions {
  strict: boolean;
  paths: { project: PathRule[]; global: PathRule[] };
  commands: { project: CommandRule[]; global: CommandRule[] };
  promptWhen: PromptWhen;
  llm: LlmConfig;
  session?: SessionState | null;
  /** gitignore check for file requests; default: real `git check-ignore` */
  gitIgnoreCheck?: (path: string, cwd: string) => Promise<boolean>;
  /** injectable LLM client for tests; defaults to the real subprocess client */
  llmClient?: (command: string, opts: VerdictOptions) => Promise<VerdictResult>;
  /** passed through to requestVerdict (ctx.signal) */
  signal?: AbortSignal;
}

/** Compact policy feed for the analyzer: scoped rules, project (higher priority) first. */
export function formatPolicy(paths: { project: PathRule[]; global: PathRule[] }, commands: { project: CommandRule[]; global: CommandRule[] }): string {
  const parts: string[] = [];
  const scopePart = (label: string, pathRules: PathRule[], commandRules: CommandRule[]) => {
    const bits: string[] = [];
    if (pathRules.length) {
      bits.push(`paths [${pathRules.map((r) => `${r.action} ${r.kind} ${r.path}`).join(", ")}]`);
    }
    if (commandRules.length) {
      bits.push(`commands [${commandRules.map((r) => `${r.action}${r.exact ? " (exact)" : ""} ${r.raw}`).join(", ")}]`);
    }
    if (bits.length) parts.push(`${label}: ${bits.join("; ")}`);
  };
  scopePart("project rules (higher priority)", paths.project, commands.project);
  scopePart("global rules", paths.global, commands.global);
  return parts.join(" | ");
}

function commandReason(rule: CommandRule): string {
  return `command rule: ${rule.action} ${rule.raw}`;
}

/** Deterministic fallback: project matches → global matches → strict/default. */
function fallbackDecision(
  project: CommandRule[],
  global: CommandRule[],
  command: string,
): { decision: { action: "allow" | "ask" | "deny"; scope: "project" | "global"; rule: CommandRule } | null } {
  const projectMatch = scopeDecision(project.filter((r) => matchRules([r], command).length));
  if (projectMatch) {
    return { decision: { action: projectMatch.decision, scope: "project", rule: projectMatch.rule as CommandRule } };
  }
  const globalMatch = scopeDecision(global.filter((r) => matchRules([r], command).length));
  if (globalMatch) {
    return { decision: { action: globalMatch.decision, scope: "global", rule: globalMatch.rule as CommandRule } };
  }
  return { decision: null };
}

function suggestionsOf(verdict: Verdict): Suggestions | undefined {
  const paths = verdict.paths?.blocked ?? [];
  const commands = verdict.commands?.blocked ?? [];
  if (!paths.length && !commands.length) return undefined;
  return { paths, commands };
}

export async function runPipeline(req: ToolRequest, opts: PipelineOptions): Promise<PipelineResult> {
  const stages: Stage[] = [];

  /* 1. Session statements — final for the session, no LLM. */
  const key = grantKey(req);
  const denied = opts.session?.isDenied(key) ?? false;
  const allowed = opts.session?.isAllowed(key) ?? false;
  stages.push({ stage: "session", denied, allowed });
  if (denied) {
    return { outcome: { outcome: "block", reason: "blocked for session", source: "session" }, stages };
  }
  if (allowed) {
    return { outcome: { outcome: "allow", reason: "allowed for session" }, stages };
  }

  /* 2. Files — deterministic only. */
  if (req.kind === "file") {
    const path = await evaluatePath(req.target, {
      cwd: req.cwd,
      home: req.home,
      project: opts.paths.project,
      global: opts.paths.global,
      gitIgnoreCheck: opts.gitIgnoreCheck,
    });
    const decision =
      path.scope === "default"
        ? null
        : { action: path.decision as "allow" | "ask" | "deny", scope: path.scope as "project" | "global", rule: path.rule };
    stages.push({ stage: "rules", decision, path });

    if (path.decision === "allow") {
      return { outcome: { outcome: "allow", reason: path.rule ? `allowed by rule: ${path.rule.path}` : "in project cwd" }, stages };
    }
    let reason: string;
    let source: PromptSource;
    if (path.rule) {
      reason = `${path.rule.action === "ask" ? "path requires permission" : "path denied by rule"}: ${path.rule.path} (${path.scope})`;
      source = "policy";
    } else {
      reason = `${path.defaultReason}: ${req.target}`;
      source = "default";
    }
    return { outcome: { outcome: "prompt", reason, source }, stages };
  }

  /* 3. Commands — LLM when enabled, else deterministic fallback. */
  let llmStage: LlmStage | undefined;
  let llmFailed = false;
  if (!opts.llm.disabled) {
    const client = opts.llmClient ?? requestVerdict;
    const result = await client(req.command, {
      piPath: opts.llm.piPath,
      provider: opts.llm.provider,
      model: opts.llm.model,
      userPrompt: opts.llm.userPrompt,
      timeoutMs: opts.llm.timeoutMs,
      signal: opts.signal,
      cwd: req.cwd,
      policy: formatPolicy(opts.paths, opts.commands),
    });
    llmStage = { stage: "llm", result, verdict: result.ok ? result.verdict : undefined };
    stages.push(llmStage);
    if (!result.ok) llmFailed = true; // no response — the prompt may offer a manual re-run

    if (result.ok) {
      const { verdict } = result;
      switch (verdict.outcome) {
        case "ALLOWED":
          if (opts.promptWhen === "everytime") {
            return {
              outcome: {
                outcome: "prompt",
                reason: `LLM verdict: ALLOWED (risk ${verdict.risk})${verdict.reason ? ` — ${verdict.reason}` : ""}`,
                source: "llm",
              },
              stages,
            };
          }
          return { outcome: { outcome: "allow", reason: verdict.reason ?? "LLM: allowed" }, stages };
        case "DENY":
          if (opts.promptWhen === "asked") {
            return { outcome: { outcome: "block", reason: verdict.reason ?? "LLM: deny", source: "llm" }, stages };
          }
          return {
            outcome: { outcome: "prompt", reason: verdict.reason ?? "LLM: high risk", source: "llm", suggestions: suggestionsOf(verdict) },
            stages,
          };
        case "ASK_USER":
          return { outcome: { outcome: "prompt", reason: verdict.reason ?? "LLM: asks user", source: "llm", suggestions: suggestionsOf(verdict) }, stages };
      }
    }
    // inconclusive — fall through to the deterministic fallback
  }

  // deterministic fallback (LLM disabled, unavailable, or inconclusive)
  const { decision } = fallbackDecision(opts.commands.project, opts.commands.global, req.command);
  stages.push({ stage: "rules", decision });
  const failedKind = () => (llmStage && !llmStage.result.ok ? ` (${llmStage.result.kind})` : "");
  if (decision) {
    const reason = commandReason(decision.rule);
    if (decision.action === "allow") {
      return { outcome: { outcome: "allow", reason }, stages };
    }
    if (decision.action === "deny") {
      if (opts.promptWhen === "asked") {
        return { outcome: { outcome: "block", reason, source: "policy" }, stages };
      }
      return { outcome: { outcome: "prompt", reason, source: "policy", llmFailed }, stages };
    }
    return { outcome: { outcome: "prompt", reason, source: "policy", llmFailed }, stages };
  }

  if (opts.strict) {
    return {
      outcome: {
        outcome: "prompt",
        reason: `no rule matched; no LLM analysis available${failedKind()}`,
        source: "default",
        llmFailed,
      },
      stages,
    };
  }
  return { outcome: { outcome: "allow", reason: "no rule matched" }, stages };
}
