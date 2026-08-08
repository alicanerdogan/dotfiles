/**
 * Analysis pipeline (design §2): grant → LLM verdict → deterministic floor
 * → decision. Pure module — no pi imports, so it runs under plain
 * `node --test`; index.ts supplies pi-derived inputs (ctx.cwd, ctx.signal,
 * config paths, notify/UI wiring).
 *
 * Stage order and short-circuiting:
 *   1. grant   — session grant (allow-once/session/always) → allow
 *   2. llm     — supervision: runs for every bash command when llm.enabled
 *                and its verdict is recorded (audit trail) even when the
 *                deterministic floor later blocks or prompts
 *   3. rules   — deterministic floor: deny → block (always wins); prompt →
 *                prompt (or notify when requireConfirmation is off); allow →
 *                the LLM verdict decides — or plain allow when the LLM is
 *                disabled or the request is a file access (files stay
 *                deterministic-only in v1)
 *
 * The floor is non-negotiable: an LLM ALLOWED can never override a rule deny,
 * and an inconclusive analysis (any kind) prompts — never approval.
 */
import { analyzeCommand, type AnalyzeResult } from "./tree-sitter.ts";
import { checkCommand, type CommandMatch } from "./commands.ts";
import { evaluatePath, expandPath, type AccessKind, type PathEval } from "./paths.ts";
import { requestVerdict, type Verdict, type VerdictOptions, type VerdictResult } from "./llm-client.ts";
import { DEFAULT_CONFIG, type LlmConfig, type CommandRules, type PathnameRules, type PromptingConfig, type TreeSitterConfig } from "./config.ts";
import { MemoryGrantStore, type GrantScope, type GrantStore } from "./grants.ts";
// re-exported so pipeline users (tests, prompt flow) import grants from one place
export { MemoryGrantStore, type GrantScope, type GrantStore } from "./grants.ts";

/* ------------------------------------------------------------------ */
/* Request + grant model                                               */
/* ------------------------------------------------------------------ */

export type ToolRequest =
  | { kind: "bash"; command: string; cwd: string; home: string }
  | { kind: "file"; tool: string; target: string; access: AccessKind; cwd: string; home: string };

/** Stable identity for grant bookkeeping (same shape for session + persisted). */
export function grantKey(req: ToolRequest): string {
  if (req.kind === "bash") return `bash:${req.command}`;
  const target = evaluateTarget(req);
  return `file:${req.access}:${req.tool}:${target}`;
}

function evaluateTarget(req: ToolRequest): string {
  if (req.kind !== "file") return "";
  return expandPath(req.target, { cwd: req.cwd, home: req.home });
}

/* ------------------------------------------------------------------ */
/* Stage traces                                                        */
/* ------------------------------------------------------------------ */

export interface GrantStage {
  stage: "grant";
  grant: GrantScope | null;
}

export interface RulesStage {
  stage: "rules";
  verdict: "allow" | "prompt" | "deny";
  /** bash only: which model path produced the command model */
  modelSource?: "ast" | "words";
  degraded?: string | null;
  matches: CommandMatch[];
  path?: PathEval;
}

export interface LlmStage {
  stage: "llm";
  result: VerdictResult;
  verdict?: Verdict;
}

export type Stage = GrantStage | RulesStage | LlmStage;

/* ------------------------------------------------------------------ */
/* Outcome                                                             */
/* ------------------------------------------------------------------ */

export type BlockSource = "policy" | "autoDeny" | "llm";
export type PromptSource = "policy" | "llm";

/** Actionable suggestions the LLM returned with a rejection (menu options). */
export interface Suggestions {
  paths: string[];
  commands: { raw: string; general?: string }[];
}

export type Outcome =
  | { outcome: "allow"; reason: string }
  | { outcome: "notify"; reason: string }
  | { outcome: "prompt"; reason: string; source: PromptSource; suggestions?: Suggestions }
  | { outcome: "block"; reason: string; source: BlockSource };

export interface PipelineResult {
  outcome: Outcome;
  stages: Stage[];
}

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

export interface PipelineOptions {
  rules: CommandRules;
  pathRules: PathnameRules;
  llm: LlmConfig;
  ts: TreeSitterConfig;
  prompting: Pick<PromptingConfig, "requireConfirmation">;
  grants?: GrantStore | null;
  /** degradation warnings (tree-sitter missing) — index.ts wires ctx.ui.notify */
  notify?: (msg: string) => void;
  /** injectable LLM client for tests; defaults to the real subprocess client */
  llmClient?: (command: string, opts: VerdictOptions) => Promise<VerdictResult>;
  /** passed through to requestVerdict (ctx.signal) */
  signal?: AbortSignal;
}

function suggestionsOf(verdict: Verdict): Suggestions | undefined {
  const paths = verdict.paths?.blocked ?? [];
  const commands = verdict.commands?.blocked ?? [];
  if (!paths.length && !commands.length) return undefined;
  return { paths, commands };
}

function joinLabels(matches: CommandMatch[]): string {
  return matches.map((m) => m.label).join("; ");
}

/** Compact policy for the analysis message: what is protected, what is explicitly allowed. */
export function formatPolicy(rules: CommandRules, pathRules: PathnameRules): string {
  const parts: string[] = [];
  if (pathRules.protected.length) {
    parts.push(`paths protected [${pathRules.protected.map((r) => `${r.pattern} (${r.mode})`).join(", ")}]`);
  }
  if (pathRules.allowed.length) {
    parts.push(`paths allowed [${pathRules.allowed.map((a) => `${a.path} (${a.kind})`).join(", ")}]`);
  }
  if (rules.allowed.length) {
    parts.push(`commands allowed [${rules.allowed.join(", ")}]`);
  }
  return parts.join("; ");
}

/** Zero-config pipeline (all-default rules) — used when no options are given. */
const DEFAULT_PIPELINE_OPTIONS: PipelineOptions = {
  rules: DEFAULT_CONFIG.commands,
  pathRules: DEFAULT_CONFIG.pathnames,
  llm: DEFAULT_CONFIG.llm,
  ts: DEFAULT_CONFIG.treeSitter,
  prompting: DEFAULT_CONFIG.prompting,
};

export async function runPipeline(req: ToolRequest, opts: PipelineOptions = DEFAULT_PIPELINE_OPTIONS): Promise<PipelineResult> {
  const stages: Stage[] = [];

  /* 1. Grant check — fastest path, short-circuits everything. */
  const key = grantKey(req);
  const grant = opts.grants?.check(key) ?? null;
  stages.push({ stage: "grant", grant });
  if (grant) {
    return { outcome: { outcome: "allow", reason: `granted (${grant})` }, stages };
  }

  /* 2. LLM verdict — supervision: every bash command when enabled. The verdict
   * is recorded even when the deterministic floor later blocks or prompts. */
  let llmStage: LlmStage | undefined;
  if (req.kind === "bash" && opts.llm.enabled) {
    const client = opts.llmClient ?? requestVerdict;
    const result = await client(req.command, {
      piPath: opts.llm.piPath,
      provider: opts.llm.provider,
      model: opts.llm.model,
      appendSystemPrompt: opts.llm.appendSystemPrompt,
      timeoutMs: opts.llm.timeoutMs,
      signal: opts.signal,
      cwd: req.cwd,
      policy: formatPolicy(opts.rules, opts.pathRules),
    });
    llmStage = { stage: "llm", result, verdict: result.ok ? result.verdict : undefined };
    stages.push(llmStage);
  }

  /* 3. Deterministic rules — the floor. */
  let floor: "allow" | "prompt" | "deny" = "allow";
  let floorReason = "no rule matched";
  let floorSource: BlockSource | undefined;

  if (req.kind === "file") {
    const path = evaluatePath(req.target, {
      kind: req.access,
      cwd: req.cwd,
      home: req.home,
      rules: opts.pathRules,
    });
    // precedence: protected rules > explicit allows > outside-cwd boundary > allow;
    // the boundary is implicit (prompt) — no config knob, users steer it via allowed
    const verdict = path.protected && !path.allowed ? "prompt" : path.allowed ? "allow" : path.outside ? "prompt" : "allow";
    stages.push({ stage: "rules", verdict, matches: [], path });
    if (verdict === "prompt") {
      floor = "prompt";
      floorReason = path.rule?.pattern
        ? `protected path matches ${path.rule.pattern}`
        : `outside project cwd: ${req.target}`;
    }
  } else {
    const analysis: AnalyzeResult = analyzeCommand(req.command, opts.ts, opts.notify);
    const decision = checkCommand(analysis.model, opts.rules);
    stages.push({
      stage: "rules",
      verdict: decision.verdict,
      modelSource: analysis.source,
      degraded: analysis.degraded,
      matches: decision.matches,
    });

    if (decision.verdict === "deny") {
      const deny = decision.matches.find((m) => m.severity === "deny");
      floor = "deny";
      floorReason = joinLabels(decision.matches);
      floorSource = deny?.source === "autoDeny" ? "autoDeny" : "policy";
    } else if (decision.verdict === "prompt") {
      floor = "prompt";
      floorReason = joinLabels(decision.matches);
    }
  }

  /* 4. Decision — the floor wins; the LLM decides only what the floor allowed. */
  if (floor === "deny") {
    return { outcome: { outcome: "block", reason: floorReason, source: floorSource ?? "policy" }, stages };
  }
  if (floor === "prompt") {
    if (opts.prompting.requireConfirmation) {
      return { outcome: { outcome: "prompt", reason: floorReason, source: "policy" }, stages };
    }
    return { outcome: { outcome: "notify", reason: floorReason }, stages };
  }

  // floor allow — file requests and disabled-LLM sessions end here
  if (!llmStage) {
    return { outcome: { outcome: "allow", reason: "no rule matched" }, stages };
  }

  const { result } = llmStage;
  if (!result.ok) {
    return {
      outcome: {
        outcome: "prompt",
        reason: `LLM analysis inconclusive (${result.kind}): ${result.error}`,
        source: "llm",
      },
      stages,
    };
  }

  const { verdict } = result;
  switch (verdict.outcome) {
    case "ALLOWED":
      if (opts.llm.confirm) {
        // debug mode: surface the verdict and let the user decide instead of auto-allowing
        return {
          outcome: {
            outcome: "prompt",
            reason: `LLM verdict: ALLOWED (risk ${verdict.risk})${verdict.reason ? ` — ${verdict.reason}` : " — run anyway?"}`,
            source: "llm",
            suggestions: suggestionsOf(verdict),
          },
          stages,
        };
      }
      return { outcome: { outcome: "allow", reason: verdict.reason ?? "LLM: allowed" }, stages };
    case "DENY":
      if (opts.llm.autoDeny) {
        return { outcome: { outcome: "block", reason: verdict.reason ?? "LLM: deny", source: "llm" }, stages };
      }
      return {
        outcome: {
          outcome: "prompt",
          reason: verdict.reason ?? "LLM: high risk",
          source: "llm",
          suggestions: suggestionsOf(verdict),
        },
        stages,
      };
    case "ASK_USER":
      return {
        outcome: {
          outcome: "prompt",
          reason: verdict.reason ?? "LLM: asks user",
          source: "llm",
          suggestions: suggestionsOf(verdict),
        },
        stages,
      };
  }
}
