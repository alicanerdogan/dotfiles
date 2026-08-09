/**
 * Session statements (design updates doc): in-memory allow/deny exemptions
 * created by the six-option menu ("for session"). Keys are exact-match by
 * default; a statement stored as `kind: "directory"` also covers every
 * descendant key (prefix match). Checked before the LLM — a session allow
 * short-circuits everything (no LLM call), a session deny blocks silently.
 * Statements are final for the session; the next session starts clean.
 */
export type StatementKind = "file" | "directory";

export class SessionState {
  private allow = new Map<string, StatementKind>();
  private deny = new Map<string, StatementKind>();

  addAllow(key: string, kind: StatementKind = "file"): void {
    this.allow.set(key, kind);
  }

  addDeny(key: string, kind: StatementKind = "file"): void {
    this.deny.set(key, kind);
  }

  isAllowed(key: string): boolean {
    return matches(this.allow, key);
  }

  isDenied(key: string): boolean {
    return matches(this.deny, key);
  }

  clear(): void {
    this.allow.clear();
    this.deny.clear();
  }
}

function matches(statements: Map<string, StatementKind>, key: string): boolean {
  if (statements.has(key)) return true;
  for (const [k, kind] of statements) {
    if (kind === "directory" && key.startsWith(k + "/")) return true;
  }
  return false;
}
