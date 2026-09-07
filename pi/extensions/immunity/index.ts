/**
 * pi-immunity extension entry — the only file pi's discovery loads from
 * this directory. Discovery covers flat extension files and subdirectory
 * index files; every other module lives in lib/ and subprocess/ so it
 * stays inert (no "not a factory" load diagnostics, no stray tools in the
 * main session).
 *
 * Wiring:
 *   session_start    → load merged, trust-gated config; build scoped rule
 *                      views; clear session statements
 *   tool_call        → interactive-only gate → adapt to ToolRequest →
 *                      handleToolCall (pipeline → six-option menu →
 *                      block/audit/bus)
 *   session_shutdown → clear session statements
 *
 * Menu rule writes (handler hooks) go to the chosen scope — project when
 * trusted, else global — and reflect into the in-memory merged config and
 * the scoped rule views so they are effective immediately.
 *
 * The analysis subprocess extension (subprocess/analysis-tool.ts) is never
 * loaded here — the client passes it explicitly via `--extension` to a
 * headless `pi --mode json` process that also gets `--no-extensions`, so
 * immunity never loads inside the analyzer.
 */
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { statSync } from "node:fs";
import { loadConfig, type ImmunityConfig, type LoadResult } from "./lib/config.ts";
import { handleToolCall, type HandlerEnv, type ScopedRuleViews } from "./lib/handler.ts";
import { SessionState } from "./lib/session.ts";
import { defaultAuditPath } from "./lib/audit.ts";
import { isSkillPath } from "./lib/paths.ts";
import { writeRule, type RuleKind } from "./lib/rules.ts";
import { shouldEnforce } from "./lib/gate.ts";
import { bashSiblings, startSiblingVerdicts } from "./lib/preflight.ts";
import { formatPolicy, type ToolRequest } from "./lib/pipeline.ts";
import type { VerdictResult } from "./lib/llm-client.ts";

const HOME = homedir();

let loaded: LoadResult | null = null;
const session = new SessionState();

/** Latest merged config; null before the first session_start. */
export function getLoadedConfig(): ImmunityConfig | null {
  return loaded?.config ?? null;
}

function globalConfigPath(): string {
  return join(getAgentDir(), "immunity.json");
}

/** Adapt a pi tool-call event to an immunity request; null = not gated. */
export function toRequest(event: ToolCallEvent, cwd: string): ToolRequest | null {
  switch (event.toolName) {
    case "bash":
      return { kind: "bash", command: event.input.command, cwd, home: HOME };
    case "read":
      // skill reads are never supervised — they resolve outside the cwd in
      // most projects (the agent dir is a symlink elsewhere) and would
      // otherwise prompt on every skill load
      if (isSkillPath(event.input.path, { cwd, home: HOME })) return null;
      return { kind: "file", tool: "read", target: event.input.path, cwd, home: HOME };
    case "write":
      return { kind: "file", tool: "write", target: event.input.path, cwd, home: HOME };
    case "edit":
      return { kind: "file", tool: "edit", target: event.input.path, cwd, home: HOME };
    default:
      return null; // grep/find/ls and custom tools are read-only — not gated
  }
}

function pathKindOf(value: string): "file" | "directory" {
  const expanded = value === "~" ? HOME : value.startsWith("~/") ? join(HOME, value.slice(2)) : value;
  try {
    return statSync(expanded).isDirectory() ? "directory" : "file";
  } catch {
    return "file";
  }
}

export default function (pi: ExtensionAPI) {
  /** sibling-batch verdicts keyed by toolCallId; null = session-resolved, deliberately not started */
  const pendingVerdicts = new Map<string, Promise<VerdictResult> | null>();

  /**
   * Sibling preflight: pi runs the tool_call handlers of one assistant
   * message sequentially, so awaiting the analysis inline would serialize
   * the LLM verdicts. The full message (all sibling calls) is already in
   * the session manager when the first handler fires — start a verdict
   * for every bash sibling in parallel there; the later handlers consume
   * their already-running verdict (their toolCallId is already pending).
   */
  const preflightVerdict = (toolCallId: string, ctx: ExtensionContext, load: LoadResult): Promise<VerdictResult> | undefined => {
    if (pendingVerdicts.has(toolCallId)) return pendingVerdicts.get(toolCallId) ?? undefined;
    let siblings;
    try {
      // the assistant message carrying the sibling calls is the session leaf
      // by the time tool_call handlers run (pi drains Agent events first)
      const leaf = ctx.sessionManager.getLeafEntry();
      const messages = leaf?.type === "message" ? [leaf.message] : [];
      siblings = bashSiblings(messages, toolCallId);
    } catch {
      return undefined; // unexpected session-manager shape — fall back to inline analysis
    }
    if (!siblings) return undefined;
    return startSiblingVerdicts(
      siblings,
      toolCallId,
      {
        session,
        cwd: ctx.cwd,
        home: HOME,
        llm: load.config.llm,
        policy: formatPolicy(load.rules.paths, load.rules.commands),
        maxParallel: load.config.llm.maxParallel,
        signal: ctx.signal,
      },
      pendingVerdicts,
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    session.clear();
    pendingVerdicts.clear();
    loaded = loadConfig({
      globalPath: globalConfigPath(),
      projectPath: join(ctx.cwd, CONFIG_DIR_NAME, "immunity.json"),
      trusted: ctx.isProjectTrusted(),
    });
    if (!ctx.hasUI) return;
    for (const scope of loaded.scopes) {
      if (scope.error) ctx.ui.notify(`immunity: ${scope.path}: ${scope.error}`, "warning");
    }
  });

  pi.on("session_shutdown", () => {
    session.clear();
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!shouldEnforce(ctx.hasUI)) return;
    const config = loaded?.config;
    if (!config) return; // no session_start yet — do not gate
    const req = toRequest(event, ctx.cwd);
    if (!req) return;
    const prestarted =
      req.kind === "bash" && !config.llm.disabled ? preflightVerdict(event.toolCallId, ctx, loaded!) : undefined;
    const result = await handleToolCall(req, buildEnv(ctx, pi), prestarted);
    return result.allow ? undefined : { block: true, reason: result.reason };
  });
}

function buildEnv(ctx: ExtensionContext, pi: ExtensionAPI): HandlerEnv {
  const config = loaded!.config;
  const rules: ScopedRuleViews = loaded!.rules;
  const trusted = ctx.isProjectTrusted();
  const projectScope = join(ctx.cwd, CONFIG_DIR_NAME, "immunity.json");
  const ruleScope = trusted ? projectScope : globalConfigPath();
  const globalRuleScope = globalConfigPath();
  const auditFile = config.audit.enabled ? defaultAuditPath(ctx.cwd, CONFIG_DIR_NAME) : null;

  /** write a rule + reflect it into the in-memory merged config and the
   * scoped rule views (effective immediately) */
  const writeRuleEffective = (
    kind: RuleKind,
    value: string,
    scope: "project" | "global",
    opts?: { pathKind?: "file" | "directory" },
  ): boolean => {
    const scopeFile = scope === "global" ? globalRuleScope : ruleScope;
    const ok = writeRule(scopeFile, kind, value, opts);
    if (!ok) return false;
    const paths = scope === "global" ? rules.paths.global : rules.paths.project;
    const commands = scope === "global" ? rules.commands.global : rules.commands.project;
    const pathKind = opts?.pathKind ?? "file";
    switch (kind) {
      case "commandAllow":
        commands.push({ action: "allow", exact: true, raw: value });
        break;
      case "commandDeny":
        commands.push({ action: "deny", exact: true, raw: value });
        break;
      case "pathAllow":
        paths.push({ action: "allow", kind: pathKind, path: value });
        break;
      case "pathDeny":
        paths.push({ action: "deny", kind: pathKind, path: value });
        break;
    }
    return true;
  };

  let sessionId: string;
  try {
    sessionId = ctx.sessionManager.getSessionId();
  } catch {
    sessionId = "unknown";
  }

  return {
    config,
    rules,
    session,
    bus: { emit: (channel, data) => pi.events.emit(channel, data) },
    sessionId,
    cwd: ctx.cwd,
    home: HOME,
    ui: ctx.ui,
    setStatus: (label) => ctx.ui.setStatus("immunity", label ?? undefined),
    log: (msg) => console.error(msg),
    signal: ctx.signal,
    auditFile,
    ruleScope,
    globalRuleScope,
    pathKindFor: pathKindOf,
    saveRule: (kind, value, scope, opts) => writeRuleEffective(kind, value, scope, opts),
  };
}
