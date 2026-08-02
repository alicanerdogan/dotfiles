/**
 * pi-immunity extension entry — the only file pi's discovery loads from
 * this directory. Discovery covers flat extension files and subdirectory
 * index files; every other module lives in lib/ and subprocess/ so it
 * stays inert (no "not a factory" load diagnostics, no stray tools in the
 * main session).
 *
 * Wiring (design §2/§5/§6):
 *   session_start    → load merged, trust-gated config; build grants
 *   tool_call        → interactive-only gate → adapt to ToolRequest →
 *                      handleToolCall (pipeline → prompt/block/audit/bus)
 *   session_shutdown → reset session grants
 *
 * Rule conversion and always-grants (handler hooks) write to the chosen
 * scope — project when trusted, else global — and reflect the change into
 * the in-memory merged config so it is effective immediately.
 *
 * The analysis subprocess extension (subprocess/analysis-tool.ts) is never
 * loaded here — the client passes it explicitly via `--extension` to a
 * headless `pi --mode json` process that also gets `--no-extensions`, so
 * immunity never loads inside the analyzer.
 */
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { statSync } from "node:fs";
import { loadConfig, type ImmunityConfig, type LoadResult } from "./lib/config.ts";
import { handleToolCall, type HandlerEnv } from "./lib/handler.ts";
import { CompositeGrantStore, MemoryGrantStore, PersistedGrants } from "./lib/grants.ts";
import { defaultAuditPath } from "./lib/audit.ts";
import { writeRule } from "./lib/rules.ts";
import { shouldEnforce } from "./lib/gate.ts";
import type { ToolRequest } from "./lib/pipeline.ts";

const HOME = homedir();

let loaded: LoadResult | null = null;
const sessionGrants = new MemoryGrantStore();

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
      return { kind: "file", tool: "read", target: event.input.path, access: "read", cwd, home: HOME };
    case "write":
      return { kind: "file", tool: "write", target: event.input.path, access: "modify", cwd, home: HOME };
    case "edit":
      return { kind: "file", tool: "edit", target: event.input.path, access: "modify", cwd, home: HOME };
    default:
      return null; // grep/find/ls and custom tools are read-only — not gated in v1
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
  pi.on("session_start", async (_event, ctx) => {
    sessionGrants.clear();
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
    sessionGrants.clear();
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!shouldEnforce(ctx.hasUI)) return;
    const config = loaded?.config;
    if (!config) return; // no session_start yet — do not gate
    const req = toRequest(event, ctx.cwd);
    if (!req) return;
    const result = await handleToolCall(req, buildEnv(ctx, pi));
    return result.allow ? undefined : { block: true, reason: result.reason };
  });
}

function buildEnv(ctx: ExtensionContext, pi: ExtensionAPI): HandlerEnv {
  const config = loaded!.config;
  const trusted = ctx.isProjectTrusted();
  const projectScope = join(ctx.cwd, CONFIG_DIR_NAME, "immunity.json");
  const ruleScope = trusted ? projectScope : globalConfigPath();
  const auditFile = config.audit.enabled
    ? config.audit.file
      ? resolve(ctx.cwd, config.audit.file)
      : defaultAuditPath(ctx.cwd, CONFIG_DIR_NAME)
    : null;

  /** write a rule + reflect it into the in-memory merged config (effective now) */
  const writeRuleEffective = (
    kind: "autoDeny" | "path" | "commandAllow" | "pathAllow",
    value: string,
    opts?: { pathKind?: "file" | "directory" },
  ): boolean => {
    const ok = writeRule(ruleScope, kind, value, opts);
    if (!ok) return false;
    switch (kind) {
      case "autoDeny":
        config.commands.autoDenyPatterns.push(value);
        break;
      case "commandAllow":
        config.commands.allowed.push(value);
        break;
      case "path":
        config.pathnames.protected.push({ pattern: value, mode: "modify" });
        break;
      case "pathAllow":
        config.pathnames.allowed.push({ kind: opts?.pathKind ?? "file", path: value });
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
    grants: new CompositeGrantStore([sessionGrants, new PersistedGrants(config, { cwd: ctx.cwd, home: HOME })]),
    sessionGrants,
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
    pathKindFor: pathKindOf,
    saveRule: (kind, value) => writeRuleEffective(kind, value),
    persistGrant: (kind, value) =>
      kind === "command"
        ? writeRuleEffective("commandAllow", value)
        : writeRuleEffective("pathAllow", value, { pathKind: pathKindOf(value) }),
  };
}
