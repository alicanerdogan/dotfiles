/**
 * Rule conversion (design §6): persist a user's intent as config in a
 * chosen scope file (global or project — index.ts picks). Pure fs module;
 * writes are failure-safe (false instead of throw) and idempotent
 * (dedupe). A scope file with invalid JSON is never clobbered.
 *
 *   autoDeny      → commands.autoDenyPatterns   (exact command string)
 *   path          → pathnames.protected         ({ pattern, mode: "modify" })
 *   commandAllow  → commands.allowed            (persisted always-grant)
 *   pathAllow     → pathnames.allowed           ({ kind, path })
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stampSchema } from "./config.ts";

export type RuleKind = "autoDeny" | "path" | "commandAllow" | "pathAllow";

export interface WriteRuleOptions {
  /** kind for pathAllow entries; default "file" */
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

function section(raw: Raw, keys: string[]): string[] {
  let cur: Record<string, unknown> = raw;
  for (const key of keys.slice(0, -1)) {
    const next = cur[key];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      const fresh: Record<string, unknown> = {};
      cur[key] = fresh;
      cur = fresh;
    } else {
      cur = next as Record<string, unknown>;
    }
  }
  const last = keys[keys.length - 1];
  const arr = cur[last];
  if (!Array.isArray(arr)) {
    cur[last] = [];
  }
  return cur[last] as unknown as string[];
}

function pushString(raw: Raw, keys: string[], value: string): boolean {
  const arr = section(raw, keys) as unknown[];
  if (arr.includes(value)) return false; // already present — nothing to write
  arr.push(value);
  return true;
}

function pushRule(raw: Raw, keys: string[], rule: Record<string, unknown>): boolean {
  const arr = section(raw, keys) as unknown[];
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
    case "autoDeny":
      changed = pushString(raw, ["commands", "autoDenyPatterns"], value);
      break;
    case "commandAllow":
      changed = pushString(raw, ["commands", "allowed"], value);
      break;
    case "path":
      changed = pushRule(raw, ["pathnames", "protected"], { pattern: value, mode: "modify" });
      break;
    case "pathAllow":
      changed = pushRule(raw, ["pathnames", "allowed"], { kind: opts.pathKind ?? "file", path: value });
      break;
  }
  if (!changed) return true; // idempotent: already present counts as saved

  try {
    mkdirSync(dirname(scopePath), { recursive: true });
    writeFileSync(scopePath, `${JSON.stringify(stampSchema(raw), null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}
