/**
 * Grant store tests: session memory, persisted config-backed grants
 * (exact bash match, file/directory path kinds), composite layering.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CompositeGrantStore, MemoryGrantStore, PersistedGrants } from "./grants.ts";
import { DEFAULT_CONFIG, type ImmunityConfig } from "./config.ts";

const HOME = "/home/u";
const ENV = { cwd: "/repo", home: HOME };

function config(partial: Partial<ImmunityConfig> = {}): ImmunityConfig {
  return {
    ...DEFAULT_CONFIG,
    commands: { ...DEFAULT_CONFIG.commands, ...(partial.commands ?? {}) },
    pathnames: { ...DEFAULT_CONFIG.pathnames, ...(partial.pathnames ?? {}) },
  };
}

describe("MemoryGrantStore", () => {
  it("records and reports scopes; unknown keys are null", () => {
    const s = new MemoryGrantStore();
    assert.equal(s.check("bash:ls"), null);
    s.add("bash:ls", "session");
    assert.equal(s.check("bash:ls"), "session");
    s.add("bash:ls", "always");
    assert.equal(s.check("bash:ls"), "always");
  });
});

describe("PersistedGrants", () => {
  const store = (c: ImmunityConfig) => new PersistedGrants(c, ENV);

  it("bash grants match the exact raw command only", () => {
    const s = store(config({ commands: { ...DEFAULT_CONFIG.commands, allowed: ["git push --force"] } }));
    assert.equal(s.check("bash:git push --force"), "always");
    assert.equal(s.check("bash:git push --force origin main"), null, "variants are not granted");
    assert.equal(s.check("bash:git push --forc"), null);
  });

  it("file grants match kind file exactly", () => {
    const s = store(
      config({ pathnames: { ...DEFAULT_CONFIG.pathnames, allowed: [{ kind: "file", path: "~/.env.work" }] } }),
    );
    assert.equal(s.check("file:modify:file:/home/u/.env.work"), "always");
    assert.equal(s.check("file:modify:file:/home/u/.env.work.bak"), null);
  });

  it("file grants match kind directory for the directory and descendants", () => {
    const s = store(
      config({ pathnames: { ...DEFAULT_CONFIG.pathnames, allowed: [{ kind: "directory", path: "~/keys/test" }] } }),
    );
    assert.equal(s.check("file:read:file:/home/u/keys/test"), "always");
    assert.equal(s.check("file:read:file:/home/u/keys/test/a.pem"), "always");
    assert.equal(s.check("file:modify:file:/home/u/keys/test2/a.pem"), null);
  });

  it("parses grant keys whose target contains colons", () => {
    const s = store(
      config({ pathnames: { ...DEFAULT_CONFIG.pathnames, allowed: [{ kind: "file", path: "/repo/a:b" }] } }),
    );
    assert.equal(s.check("file:modify:file:/repo/a:b"), "always");
  });

  it("unknown key shapes never match", () => {
    const s = store(config({ commands: { ...DEFAULT_CONFIG.commands, allowed: ["ls"] } }));
    assert.equal(s.check("file:read:file:/repo/x"), null);
    assert.equal(s.check("other:ls"), null);
  });

  it("is access-agnostic (a grant covers reads and writes)", () => {
    const s = store(
      config({ pathnames: { ...DEFAULT_CONFIG.pathnames, allowed: [{ kind: "file", path: "/repo/x" }] } }),
    );
    assert.equal(s.check("file:read:file:/repo/x"), "always");
    assert.equal(s.check("file:modify:file:/repo/x"), "always");
  });
});

describe("CompositeGrantStore", () => {
  it("returns the first non-null scope in store order", () => {
    const session = new MemoryGrantStore();
    const persisted = new PersistedGrants(
      config({ commands: { ...DEFAULT_CONFIG.commands, allowed: ["ls"] } }),
      ENV,
    );
    session.add("bash:ls", "session");
    const s = new CompositeGrantStore([session, persisted]);
    assert.equal(s.check("bash:ls"), "session", "session wins over persisted");
  });

  it("falls through to persisted when the session has no grant", () => {
    const session = new MemoryGrantStore();
    const persisted = new PersistedGrants(
      config({ commands: { ...DEFAULT_CONFIG.commands, allowed: ["ls"] } }),
      ENV,
    );
    const s = new CompositeGrantStore([session, persisted]);
    assert.equal(s.check("bash:ls"), "always");
  });

  it("returns null when no store matches", () => {
    const s = new CompositeGrantStore([new MemoryGrantStore(), new MemoryGrantStore()]);
    assert.equal(s.check("bash:ls"), null);
  });
});
