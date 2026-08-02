/**
 * Config-driven command rules (design §4.1).
 *
 * `patterns` are prompt-worthy; `autoDenyPatterns` block without prompting;
 * built-in structural matchers run on the normalized CommandModel. Deny
 * always beats prompt, prompt beats allow (safety-first).
 *
 * Pattern semantics (documented, deterministic):
 *   - A pattern containing regex metacharacters (`.*+?^$[]{}|\` — bare
 *     parens excluded: `echo (test)` is literal text) is treated as a
 *     regex, tested against the raw command (unanchored unless the user
 *     anchors it).
 *   - If that regex fails to compile, the pattern falls back to substring
 *     matching — a broken pattern can never silently disable protection.
 *   - Everything else is a case-sensitive substring match.
 *
 * Footgun (by design): substrings are prefix-sensitive, so
 * `git push --force` also matches `git push --force-with-lease` (the safe
 * form). Write `git push --force( |$)` as a regex to disambiguate.
 */
import { matchBuiltins } from "./matchers.ts";
import type { CommandModel } from "./tree-sitter.ts";
import type { CommandRules } from "./config.ts";

export type CommandVerdict = "allow" | "prompt" | "deny";

export interface CommandMatch {
  source: "pattern" | "autoDeny" | "builtin";
  /** stable id for dedupe/reasons: `pattern:<idx>`, `autoDeny:<idx>`, builtin ids */
  id: string;
  severity: "prompt" | "deny";
  label: string;
  pattern?: string;
}

export interface CommandDecision {
  verdict: CommandVerdict;
  matches: CommandMatch[];
}

const REGEX_META = /[.*+?^$[\]{}|\\]/;

/** Match one configured pattern against the raw command (auto-detect regex). */
export function matchPattern(pattern: string, raw: string): boolean {
  if (!pattern) return false;
  if (REGEX_META.test(pattern)) {
    try {
      return new RegExp(pattern).test(raw);
    } catch {
      // broken regex → substring fallback, never a silent no-match
    }
  }
  return raw.includes(pattern);
}

/** Run built-ins + configured patterns; deny > prompt > allow. */
export function checkCommand(model: CommandModel, rules: CommandRules): CommandDecision {
  const matches: CommandMatch[] = [];
  const raw = model.raw;

  if (rules.useBuiltinMatchers) {
    for (const m of matchBuiltins(model)) {
      matches.push({ source: "builtin", id: m.id, severity: m.severity, label: m.label });
    }
  }
  rules.patterns.forEach((pattern, i) => {
    if (matchPattern(pattern, raw)) {
      matches.push({
        source: "pattern",
        id: `pattern:${i}`,
        severity: "prompt",
        label: `configured pattern matches: ${pattern}`,
        pattern,
      });
    }
  });
  rules.autoDenyPatterns.forEach((pattern, i) => {
    if (matchPattern(pattern, raw)) {
      matches.push({
        source: "autoDeny",
        id: `autoDeny:${i}`,
        severity: "deny",
        label: `auto-deny pattern matches: ${pattern}`,
        pattern,
      });
    }
  });

  let verdict: CommandVerdict = "allow";
  for (const m of matches) {
    if (m.severity === "deny") {
      verdict = "deny";
      break;
    }
    if (m.severity === "prompt") verdict = "prompt";
  }
  return { verdict, matches };
}
