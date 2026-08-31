/**
 * Deterministic command rule matching. Used only as
 * the fallback when the LLM is unavailable/disabled — the LLM is the
 * primary judge for shell commands and receives the rules as context.
 *
 * Match semantics: `regex` when present (deterministic-only, never fed to
 * the LLM), else string matching — full-string when `exact: true`, else
 * substring. An invalid regex degrades to string matching (the rule never
 * silently disappears).
 */
import type { CommandRule } from "./config.ts";

export function matchesCommandRule(rule: CommandRule, command: string): boolean {
  if (rule.regex) {
    try {
      return new RegExp(rule.regex).test(command);
    } catch {
      // fall through to string matching
    }
  }
  return rule.exact ? command === rule.raw : command.includes(rule.raw);
}

/** All rules matching the command (project-first order preserved). */
export function matchRules(rules: CommandRule[], command: string): CommandRule[] {
  return rules.filter((r) => matchesCommandRule(r, command));
}
