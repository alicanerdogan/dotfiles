/**
 * Rule persistence: write a user's menu choice as a
 * config rule in a chosen scope file (global or project — index.ts picks).
 * Pure fs module; writes are failure-safe (false instead of throw) and
 * idempotent (dedupe). A scope file with invalid JSON is never clobbered.
 *
 *   commandAllow → commands.rules { action: "allow", exact: true, raw }
 *   commandDeny  → commands.rules { action: "deny",  exact: true, raw }
 *   pathAllow    → paths.rules    { action: "allow", kind, path }
 *   pathDeny     → paths.rules    { action: "deny",  kind, path }
 *
 * Menu writes are always exact-string (exact: true; raw = the command as
 * run / the path as resolved). `$schema` is tolerated on read, never
 * stamped on write.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type RuleKind = "commandAllow" | "commandDeny" | "pathAllow" | "pathDeny";

export interface WriteRuleOptions {
  /** kind for path rules; default "file" */
  pathKind?: "file" | "directory";
}

type Raw = Record<string, unknown>;

function readScope(path: string): { ok: true; raw: Raw } | { ok: false } {
  if (!existsSync(path)) return { ok: true, raw: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false };
    return { ok: true, raw: parsed as Raw };
  } catch {
    return { ok: false };
  }
}

function ruleSection(raw: Raw, section: "commands" | "paths"): unknown[] {
  let cur: Record<string, unknown> = raw;
  const next = cur[section];
  if (typeof next !== "object" || next === null || Array.isArray(next)) {
    const fresh: Record<string, unknown> = {};
    cur[section] = fresh;
    cur = fresh;
  } else {
    cur = next as Record<string, unknown>;
  }
  const arr = cur["rules"];
  if (!Array.isArray(arr)) {
    cur["rules"] = [];
  }
  return cur["rules"] as unknown[];
}

function pushRule(raw: Raw, section: "commands" | "paths", rule: Record<string, unknown>): boolean {
  const arr = ruleSection(raw, section);
  if (arr.some((e) => typeof e === "object" && e !== null && JSON.stringify(e) === JSON.stringify(rule))) {
    return false;
  }
  arr.push(rule);
  return true;
}

/** Write one rule to a scope file. Returns false on any failure (never throws). */
export function writeRule(scopePath: string, kind: RuleKind, value: string, opts: WriteRuleOptions = {}): boolean {
  const read = readScope(scopePath);
  if (!read.ok) return false;
  const raw = read.raw;

  let changed = false;
  switch (kind) {
    case "commandAllow":
      changed = pushRule(raw, "commands", { action: "allow", exact: true, raw: value });
      break;
    case "commandDeny":
      changed = pushRule(raw, "commands", { action: "deny", exact: true, raw: value });
      break;
    case "pathAllow":
      changed = pushRule(raw, "paths", { action: "allow", kind: opts.pathKind ?? "file", path: value });
      break;
    case "pathDeny":
      changed = pushRule(raw, "paths", { action: "deny", kind: opts.pathKind ?? "file", path: value });
      break;
  }
  if (!changed) return true; // idempotent: already present counts as saved

  try {
    mkdirSync(dirname(scopePath), { recursive: true });
    writeFileSync(scopePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}
