/**
 * pi-immunity path engine: protected/allowed evaluation (design §3).
 *
 * Zero-dependency glob subset: `*` (within a segment), `?` (single char),
 * `**` (any number of segments) — everything else literal. Globs and allow
 * paths get `~/` expansion (leading only) and relative-to-cwd resolution
 * before matching; targets are normalized the same way.
 *
 * Precedence (safety-first): a target is `protected` when any matching
 * rule's mode equals the access kind (`read` rules gate reads, `modify`
 * rules gate writes); it is `allowed` when an allow entry matches (file =
 * exact, directory = the directory and descendants). The caller's rule:
 * protected && !allowed → gate. `onlyIfExists` rules fire only when the
 * target exists on disk (creating a new file is not gated by them).
 *
 * Regex rules match the resolved target as-is (no expansion) and are
 * validated at config load, so an invalid pattern can never reach here.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PathAllow, PathnameRules, PathRule } from "./config.ts";

export type AccessKind = "read" | "modify";

export interface PathEval {
  protected: boolean;
  allowed: boolean;
  /** first matching protected rule (for reason messages) */
  rule?: PathRule;
  /** first matching allow (for reason messages) */
  allow?: PathAllow;
}

export interface PathEvalOptions {
  kind: AccessKind;
  cwd: string;
  home: string;
  rules: PathnameRules;
  /** existence override for tests; default: fs.existsSync on the resolved target */
  exists?: boolean;
}

/** Expand a leading `~/` and resolve relative paths against cwd. */
export function expandPath(target: string, opts: { cwd: string; home: string }): string {
  const expanded = target === "~" ? opts.home : target.startsWith("~/") ? join(opts.home, target.slice(2)) : target;
  return resolve(opts.cwd, expanded);
}

function escapeLiteral(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? "\\" + ch : ch;
}

function translateSegment(seg: string): string {
  let out = "";
  for (const ch of seg) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += escapeLiteral(ch);
  }
  return out;
}

/**
 * Compile a glob pattern into a target matcher. Leading/trailing slashes
 * are ignored on both sides (matching runs over the resolved absolute
 * path); `**` as a full segment matches any number of segments (including
 * zero), and a trailing `**` also matches the bare prefix (`a/**` matches
 * `a`).
 */
export function compileGlob(pattern: string): (target: string) => boolean {
  if (pattern === "**") return () => true;
  const segs = pattern.replace(/^\/+|\/+$/g, "").split("/");
  let out = "^";
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const isLast = i === segs.length - 1;
    const isTrailingStar = seg === "**" && isLast;
    if (i > 0 && segs[i - 1] !== "**" && !isTrailingStar) out += "/";
    if (seg === "**") {
      out += isLast ? "(?:/.*)?" : "(?:[^/]+/)*";
    } else {
      out += translateSegment(seg);
    }
  }
  const re = new RegExp(out + "$");
  return (target: string) => re.test(target.replace(/^\/+/, ""));
}

/** Does this protected rule match the (already resolved) target? */
export function matchesRule(rule: PathRule, target: string, opts: { cwd: string; home: string }): boolean {
  if (!rule.pattern) return false;
  if (rule.regex) {
    try {
      return new RegExp(rule.pattern).test(target);
    } catch {
      return false;
    }
  }
  // `**`-leading patterns are already "anywhere" patterns — do not resolve
  // them against cwd (a cwd-scoped **/.env* would never protect /etc).
  const pattern = rule.pattern.startsWith("**") ? rule.pattern : expandPath(rule.pattern, opts);
  return compileGlob(pattern)(target);
}

/** Does this allow entry cover the (already resolved) target? */
export function matchesAllow(allow: PathAllow, target: string, opts: { cwd: string; home: string }): boolean {
  const expanded = expandPath(allow.path, opts);
  if (allow.kind === "file") return target === expanded;
  const dir = expanded.replace(/\/+$/, "");
  return target === dir || target.startsWith(dir + "/");
}

export function evaluatePath(target: string, opts: PathEvalOptions): PathEval {
  const resolved = expandPath(target, opts);
  const exists = opts.exists ?? existsSync(resolved);
  const result: PathEval = { protected: false, allowed: false };

  for (const rule of opts.rules.protected) {
    if (rule.mode !== opts.kind) continue;
    if (rule.onlyIfExists && !exists) continue;
    if (matchesRule(rule, resolved, opts)) {
      result.protected = true;
      result.rule = rule;
      break;
    }
  }

  for (const allow of opts.rules.allowed) {
    if (matchesAllow(allow, resolved, opts)) {
      result.allowed = true;
      result.allow = allow;
      break;
    }
  }

  return result;
}
