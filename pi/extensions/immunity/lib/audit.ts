/**
 * Reason pipeline (design §6 "What happens with the reason"): the block
 * message returned to the agent, and the audit log. Pure module — index.ts
 * supplies sessionId, tool names and the resolved audit path.
 *
 * The audit log records blocked calls only (a JSONL line per block): the
 * `source` field distinguishes policy / autoDeny / llm / user blocks, and
 * `userReason` is present exactly when the user typed one. Writes are
 * synchronous (ordering matters, cost is microseconds) and failure-safe:
 * appendAudit returns false instead of throwing — the tool call must not
 * crash because the log is unwritable.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Outcome, Risk } from "./llm-client.ts";

export type BlockSource = "policy" | "autoDeny" | "llm" | "user";

/** Blocked-call entry (the audit's core record). */
export interface BlockAuditEntry {
  event: "block";
  /** ISO timestamp */
  ts: string;
  sessionId: string;
  /** "bash" or the file tool name */
  tool: string;
  /** raw command (bash) or "<access> <resolved target>" (file) */
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
  /** the model's actionable suggestions, as returned (general included) */
  suggestedPaths?: string[];
  suggestedCommands?: { raw: string; general?: string }[];
  llm: { provider?: string; model?: string };
}

/** A rule the user created from a model suggestion (protect/allow/block). */
export interface RuleAuditEntry {
  event: "rule";
  ts: string;
  sessionId: string;
  tool: string;
  action: string;
  /** writeRule kind the choice mapped to */
  kind: "path" | "pathAllow" | "autoDeny";
  value: string;
  scope: "project" | "global";
  source: "suggestion";
}

export type AuditEntry = BlockAuditEntry | VerdictAuditEntry | RuleAuditEntry;

export function defaultAuditPath(cwd: string, configDirName = ".pi"): string {
  return join(cwd, configDirName, "immunity.audit.jsonl");
}

/** The reason handed back to the model with `block: true`. */
export function blockMessage(source: BlockSource, reason: string, userReason?: string): string {
  if (source === "user") {
    return userReason ? `Blocked by user: ${userReason}` : "Blocked by user";
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
