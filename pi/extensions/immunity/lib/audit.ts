/**
 * Reason pipeline: the block message returned to the
 * agent, and the audit log. Pure module — index.ts supplies sessionId,
 * tool names and the resolved audit path.
 *
 * The audit records blocked calls (source: policy / llm / session / user),
 * the LLM verdict trail (every analysis round-trip, suggestions included),
 * rules written from menu choices, and session statements. Writes are
 * synchronous (ordering matters, cost is microseconds) and failure-safe:
 * appendAudit returns false instead of throwing.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Outcome, Risk } from "./llm-client.ts";
import type { RuleKind } from "./rules.ts";

export type BlockSource = "policy" | "llm" | "session" | "user";

/** Blocked-call entry (the audit's core record). */
export interface BlockAuditEntry {
  event: "block";
  /** ISO timestamp */
  ts: string;
  sessionId: string;
  /** "bash" or the file tool name */
  tool: string;
  /** raw command (bash) or "<resolved target>" (file) */
  action: string;
  reason: string;
  userReason?: string;
  source: BlockSource;
}

/** Every LLM analysis round-trip — the verdict trail ("why did this pass?"). */
export interface VerdictAuditEntry {
  event: "verdict";
  ts: string;
  sessionId: string;
  tool: string;
  action: string;
  /** schema-valid fields, or null when the analysis was inconclusive */
  risk: Risk | null;
  outcome: Outcome | null;
  reason?: string;
  /** "<kind>: <error>" when the analysis failed (timeout/spawn/no-verdict/parse/output) */
  failure?: string;
  /** the model's suggestions — audit-only, never rendered or applied */
  suggestedPaths?: string[];
  suggestedCommands?: { raw: string; general?: string }[];
  llm: { provider?: string; model?: string };
}

/** A rule the user wrote from the menu (allow/block × project/global). */
export interface RuleAuditEntry {
  event: "rule";
  ts: string;
  sessionId: string;
  tool: string;
  action: string;
  kind: RuleKind;
  value: string;
  scope: "project" | "global";
  /** "menu" = six-option menu, "suggestion" = suggestion step choice */
  source: "menu" | "suggestion";
  persisted: boolean;
  /** path rules only: the effective kind (file = exact, directory = recursive) */
  pathKind?: "file" | "directory";
}

/** A session statement from the menu (allow/block for session). */
export interface SessionAuditEntry {
  event: "session";
  ts: string;
  sessionId: string;
  tool: string;
  action: string;
  kind: "sessionAllow" | "sessionDeny";
  value: string;
  scope: "session";
  /** path statements only */
  pathKind?: "file" | "directory";
}

/** A one-shot command decision (binary Allow) — the user let a flagged
 * command through for this call only; nothing is persisted. Binary denies
 * are recorded as block entries (source: user). */
export interface DecisionAuditEntry {
  event: "decision";
  ts: string;
  sessionId: string;
  tool: string;
  action: string;
  kind: "allow";
  scope: "call";
  reason: string;
}

export type AuditEntry = BlockAuditEntry | VerdictAuditEntry | RuleAuditEntry | SessionAuditEntry | DecisionAuditEntry;

export function defaultAuditPath(cwd: string, configDirName = ".pi"): string {
  return join(cwd, configDirName, "immunity.audit.jsonl");
}

/** The reason handed back to the model with `block: true`. */
export function blockMessage(source: BlockSource, reason: string, userReason?: string): string {
  if (source === "user") {
    // a user reason overwrites the pipeline/LLM reason; without one the
    // original reason is kept so the agent learns why it was blocked
    return userReason ? `Blocked by user: ${userReason}` : `Blocked by user: ${reason}`;
  }
  return `Blocked by ${source}: ${reason}`;
}

/** Append one JSONL line; creates parent directories; false on failure. */
export function appendAudit(entry: AuditEntry, file: string): boolean {
  const line = `${JSON.stringify(entry)}\n`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, line, "utf8");
    return true;
  } catch {
    return false;
  }
}
