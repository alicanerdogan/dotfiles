/**
 * Grant stores (design §2 stage 1, §3). Layers, checked in order by the
 * composite store:
 *
 *   1. session grants (MemoryGrantStore) — "Allow for session"
 *   2. persisted grants (PersistedGrants) — "Always allow", stored in the
 *      merged config:
 *      - bash grants live in `commands.allowed` (exact raw-command match —
 *        a grant covers the exact command text, never a family of variants)
 *      - path grants live in `pathnames.allowed` (same kinds as path rules:
 *        file = exact, directory = directory + descendants; access-agnostic)
 */
import type { ImmunityConfig, PathnameRules } from "./config.ts";
import { matchesAllow } from "./paths.ts";

export type GrantScope = "once" | "session" | "always";

export interface GrantStore {
  check(key: string): GrantScope | null;
}

/** In-memory session grants (reset per session; index.ts owns the instance). */
export class MemoryGrantStore implements GrantStore {
  private grants = new Map<string, GrantScope>();
  add(key: string, scope: GrantScope): void {
    this.grants.set(key, scope);
  }
  check(key: string): GrantScope | null {
    return this.grants.get(key) ?? null;
  }
  clear(): void {
    this.grants.clear();
  }
}

/** Persisted "always" grants read from the merged config. */
export class PersistedGrants implements GrantStore {
  private config: Pick<ImmunityConfig, "commands" | "pathnames">;
  private env: { cwd: string; home: string };
  constructor(config: Pick<ImmunityConfig, "commands" | "pathnames">, env: { cwd: string; home: string }) {
    this.config = config;
    this.env = env;
  }
  check(key: string): GrantScope | null {
    if (key.startsWith("bash:")) {
      return this.config.commands.allowed.includes(key.slice("bash:".length)) ? "always" : null;
    }
    if (key.startsWith("file:")) {
      // file:<access>:<tool>:<target> — target is the resolved path (may contain ':')
      const rest = key.slice("file:".length);
      const afterAccess = rest.indexOf(":");
      const afterTool = rest.indexOf(":", afterAccess + 1);
      if (afterAccess === -1 || afterTool === -1) return null;
      const target = rest.slice(afterTool + 1);
      return this.config.pathnames.allowed.some((allow) => matchesAllow(allow, target, this.env)) ? "always" : null;
    }
    return null;
  }
}

/** Stack stores; the first non-null scope wins (session over persisted). */
export class CompositeGrantStore implements GrantStore {
  private stores: GrantStore[];
  constructor(stores: GrantStore[]) {
    this.stores = stores;
  }
  check(key: string): GrantScope | null {
    for (const store of this.stores) {
      const scope = store.check(key);
      if (scope) return scope;
    }
    return null;
  }
}
