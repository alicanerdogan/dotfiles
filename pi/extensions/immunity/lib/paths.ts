/**
 * pi-immunity path engine (design updates doc): scoped rule evaluation for
 * file access.
 *
 * Rule semantics: `kind: "file"` = exact path; `kind: "directory"` =
 * recursive (the directory and all descendants, including files created
 * later). No globbing. `~` expands to home; relative paths resolve against
 * the project cwd (the loader requires `./` for relatives).
 *
 * Scope precedence (safety-first): session statements (handled by the
 * caller) > project rules > global rules > hard defaults. Within a scope
 * the safest matching action wins: deny > ask > allow. Hard defaults:
 * outside-cwd access (realpath-based, so symlink escapes count) and
 * gitignored files are blocked unless an allow rule covers them.
 *
 * `ask` and `deny` path rules both surface as prompts (blocked requests
 * are prompted with the six-option menu); they differ in the reason text
 * and in the LLM policy feed.
 */
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import type { PathRule } from "./config.ts";

export type Decision = "allow" | "ask" | "deny";

export interface PathEval {
  decision: Decision;
  /** scope that produced the decision: a rule scope, or "default" (no rule matched) */
  scope: "project" | "global" | "default";
  /** the matching rule (reason text), when a rule decided */
  rule?: PathRule;
  /** why a default decision was taken */
  defaultReason?: string;
  /** true when the (realpath-resolved) target lies outside the project cwd */
  outside: boolean;
  /** true when the target is gitignored (only meaningful inside the repo) */
  gitIgnored: boolean;
}

export interface PathEvalOptions {
  cwd: string;
  home: string;
  project: PathRule[];
  global: PathRule[];
  /** gitignore check for the resolved target; default: real `git check-ignore` */
  gitIgnoreCheck?: (path: string, cwd: string) => Promise<boolean>;
}

/** Expand a leading `~/` and resolve relative paths against cwd. */
export function expandPath(target: string, opts: { cwd: string; home: string }): string {
  const expanded = target === "~" ? opts.home : target.startsWith("~/") ? join(opts.home, target.slice(2)) : target;
  return resolve(opts.cwd, expanded);
}

/**
 * Is this a target inside a skills directory? Every pi skill discovery root
 * uses a directory literally named "skills" — agent dir (`~/.pi/agent/skills`),
 * `~/.agents/skills`, `.pi/skills` / `.agents/skills` in cwd and ancestors,
 * package `skills/` dirs, `settings[].skills` entries. Reading skill files is
 * always safe, so immunity never gates it.
 */
export function isSkillPath(target: string, opts: { cwd: string; home: string }): boolean {
  return expandPath(target, opts).replace(/\\/g, "/").split("/").includes("skills");
}

/**
 * Resolve a path to its true location, falling back to the nearest existing
 * ancestor (so writes through symlinked directories are still caught). The
 * missing tail is re-appended; never throws — on total failure returns the
 * input unchanged.
 */
export function realResolve(target: string): string {
  let p = target;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(p);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(p);
      if (parent === p) return target; // hit the root — give up
      tail.push(basename(p));
      p = parent;
    }
  }
}

/** Is the (already resolved) target outside the project cwd? Root cwd = everything in scope. */
export function isOutsideScope(target: string, cwd: string): boolean {
  const t = target.replace(/\/+$/, "") || "/";
  const c = cwd.replace(/\/+$/, "") || "/";
  if (c === "/") return false;
  return t !== c && !t.startsWith(c + "/");
}

/** Does this rule cover the (already resolved) target? */
export function matchesRule(rule: PathRule, target: string, opts: { cwd: string; home: string }): boolean {
  const expanded = expandPath(rule.path, opts);
  if (rule.kind === "file") return target === expanded;
  const dir = expanded.replace(/\/+$/, "");
  return target === dir || target.startsWith(dir + "/");
}

/** Safest matching action within one scope: deny > ask > allow. */
export function scopeDecision(matches: PathRule[]): { decision: Decision; rule: PathRule } | null {
  if (matches.some((m) => m.action === "deny")) {
    return { decision: "deny", rule: matches.find((m) => m.action === "deny")! };
  }
  if (matches.some((m) => m.action === "ask")) {
    return { decision: "ask", rule: matches.find((m) => m.action === "ask")! };
  }
  if (matches.length) return { decision: "allow", rule: matches[0] };
  return null;
}

/** Real `git check-ignore` (exit 0 = ignored). Non-repo or missing git → not ignored. */
export function gitCheckIgnore(path: string, cwd: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    let result: { status: number | null; error?: Error };
    try {
      result = spawnSync("git", ["check-ignore", "-q", path], { cwd });
    } catch (err) {
      result = { status: null, error: err instanceof Error ? err : undefined };
    }
    resolvePromise(result.error === undefined && result.status === 0);
  });
}

export async function evaluatePath(target: string, opts: PathEvalOptions): Promise<PathEval> {
  const resolved = expandPath(target, opts);
  const outside = isOutsideScope(realResolve(resolved), opts.cwd);
  const gitIgnored = outside ? false : await (opts.gitIgnoreCheck ?? gitCheckIgnore)(resolved, opts.cwd);

  const projectMatch = scopeDecision(opts.project.filter((r) => matchesRule(r, resolved, opts)));
  if (projectMatch) {
    return { decision: projectMatch.decision, scope: "project", rule: projectMatch.rule, outside, gitIgnored };
  }
  const globalMatch = scopeDecision(opts.global.filter((r) => matchesRule(r, resolved, opts)));
  if (globalMatch) {
    return { decision: globalMatch.decision, scope: "global", rule: globalMatch.rule, outside, gitIgnored };
  }

  // hard defaults: outside cwd and gitignored files are blocked
  if (outside) {
    return { decision: "deny", scope: "default", defaultReason: `outside project cwd`, outside, gitIgnored };
  }
  if (gitIgnored) {
    return { decision: "deny", scope: "default", defaultReason: `gitignored file`, outside, gitIgnored };
  }
  return { decision: "allow", scope: "default", outside, gitIgnored };
}
