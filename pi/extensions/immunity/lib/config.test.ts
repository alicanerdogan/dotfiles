/**
 * Unit tests for the config loader: defaults, scope merge (scalar override,
 * list union, enabled AND), trust gating, normalization, $schema stamping.
 * Uses repo-local temp dirs (sandbox blocks /tmp).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  loadConfig,
  mergeConfig,
  normalizeConfig,
  stampSchema,
  SCHEMA_URL,
  defaultGlobalConfigPath,
  defaultProjectConfigPath,
  type ImmunityConfig,
} from "./config.ts";

const tmp = mkdtempSync(join(import.meta.dirname, ".test-tmp-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function write(path: string, text: string) {
  writeFileSync(path, text, "utf8");
}

function load(globalPath: string | null, projectPath: string | null, trusted: boolean) {
  return loadConfig({ globalPath: globalPath ?? join(tmp, "no-global.json"), projectPath, trusted });
}

describe("defaults and paths", () => {
  it("returns DEFAULT_CONFIG when no files exist", () => {
    const r = load(null, null, true);
    assert.deepEqual(r.config, DEFAULT_CONFIG);
    assert.equal(r.scopes.length, 1);
    assert.equal(r.scopes[0].loaded, false);
  });

  it("records a skipped project scope when untrusted", () => {
    const p = join(tmp, "project.json");
    write(p, "{}");
    const r = load(null, p, false);
    assert.equal(r.scopes.length, 2);
    assert.equal(r.scopes[1].skipped, true);
    assert.equal(r.scopes[1].loaded, false);
  });

  it("computes default paths", () => {
    assert.equal(defaultGlobalConfigPath("/home/u"), "/home/u/.pi/agent/immunity.json");
    assert.equal(defaultProjectConfigPath("/repo", ".pi"), "/repo/.pi/immunity.json");
    assert.equal(defaultProjectConfigPath("/repo"), "/repo/.pi/immunity.json");
  });

  it("SCHEMA_URL points at the hand-maintained schema", () => {
    assert.ok(SCHEMA_URL.startsWith("file://"), SCHEMA_URL);
    assert.ok(SCHEMA_URL.endsWith("/immunity.schema.json"), SCHEMA_URL);
  });
});

describe("scope merge", () => {
  const GLOBAL = {
    version: 1,
    enabled: true,
    pathnames: { protected: [{ pattern: "**/.env*", mode: "modify", onlyIfExists: true }], allowed: [] },
    commands: { patterns: ["git push --force-with-lease"], autoDenyPatterns: ["git push --force"], allowed: [], useBuiltinMatchers: true },
    llm: { enabled: false, provider: "", model: "", appendSystemPrompt: "", piPath: "", timeoutMs: 30_000, autoDeny: false },
    treeSitter: { binPath: "tree-sitter", grammarDir: null },
    prompting: { requireConfirmation: true, askReasonOnDeny: true, sessionGrants: true, onPromptCommand: "" },
    audit: { enabled: true, file: "" },
  } satisfies ImmunityConfig;

  it("project overrides scalar sections field-by-field", () => {
    const merged = mergeConfig(GLOBAL, {
      ...DEFAULT_CONFIG,
      llm: { ...DEFAULT_CONFIG.llm, timeoutMs: 5000, provider: "ollama" },
      prompting: { ...DEFAULT_CONFIG.prompting, sessionGrants: false },
    });
    assert.equal(merged.llm.timeoutMs, 5000);
    assert.equal(merged.llm.provider, "ollama");
    assert.equal(merged.llm.enabled, false, "unspecified fields keep global values");
    assert.equal(merged.prompting.sessionGrants, false);
    assert.equal(merged.prompting.requireConfirmation, true, "other scalar fields untouched");
  });

  it("list sections are unions with global entries first", () => {
    const merged = mergeConfig(GLOBAL, {
      ...DEFAULT_CONFIG,
      pathnames: { protected: [{ pattern: "**/secrets/*", mode: "read" }], allowed: [{ kind: "file", path: "~/dev" }] },
      commands: { ...DEFAULT_CONFIG.commands, patterns: ["rm -rf /"], autoDenyPatterns: [] },
    });
    assert.deepEqual(merged.pathnames.protected, [...GLOBAL.pathnames.protected, { pattern: "**/secrets/*", mode: "read", onlyIfExists: false, regex: false }]);
    assert.deepEqual(merged.pathnames.allowed, [{ kind: "file", path: "~/dev" }]);
    assert.deepEqual(merged.commands.patterns, ["git push --force-with-lease", "rm -rf /"]);
    assert.deepEqual(merged.commands.autoDenyPatterns, ["git push --force"], "global autoDeny cannot be dropped");
  });

  it("enabled is AND — either scope can switch immunity off", () => {
    const off = { ...DEFAULT_CONFIG, enabled: false };
    assert.equal(mergeConfig(GLOBAL, off).enabled, false);
    assert.equal(mergeConfig(off, DEFAULT_CONFIG).enabled, false);
    assert.equal(mergeConfig(GLOBAL, DEFAULT_CONFIG).enabled, true);
  });
});

describe("normalization", () => {
  it("falls back to defaults for wrong types", () => {
    const n = normalizeConfig({
      enabled: "yes",
      llm: { timeoutMs: "30000", enabled: 1, provider: "ollama" },
      commands: { patterns: "not-an-array", autoDenyPatterns: [42, "git push --force"], useBuiltinMatchers: "x" },
      pathnames: { protected: [{ pattern: "**/.env*", mode: "modify", onlyIfExists: true }, { pattern: 42, mode: "read" }, { pattern: "**/*.pem", mode: "browse" }] },
      treeSitter: { binPath: "ts", grammarDir: null },
    });
    assert.equal(n.enabled, true);
    assert.equal(n.llm.timeoutMs, 30_000);
    assert.equal(n.llm.enabled, false);
    assert.equal(n.llm.provider, "ollama");
    assert.deepEqual(n.commands.patterns, []);
    assert.deepEqual(n.commands.autoDenyPatterns, ["git push --force"]);
    assert.equal(n.commands.useBuiltinMatchers, true);
    assert.equal(n.pathnames.protected.length, 1, "invalid entries dropped, valid kept");
    assert.equal(n.pathnames.protected[0].mode, "modify");
    assert.equal(n.treeSitter.grammarDir, null);
  });

  it("applies defaults for partial protected entries", () => {
    const n = normalizeConfig({ pathnames: { protected: [{ pattern: "/etc/hosts", mode: "read" }] } });
    assert.deepEqual(n.pathnames.protected[0], { pattern: "/etc/hosts", mode: "read", onlyIfExists: false, regex: false });
  });

  it("tolerates a $schema key and unknown top-level keys", () => {
    const n = normalizeConfig({ $schema: "file:///x/schema.json", version: 1, futureKey: 42 });
    assert.equal(n.version, 1);
    assert.deepEqual(n.pathnames.protected, []);
  });

  it("returns defaults for non-object configs", () => {
    assert.deepEqual(normalizeConfig("nope"), DEFAULT_CONFIG);
    assert.deepEqual(normalizeConfig([1, 2]), DEFAULT_CONFIG);
    assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG);
  });
});

describe("loading files", () => {
  it("merges a global and a trusted project file", () => {
    const g = join(tmp, "global.json");
    const p = join(tmp, "project.json");
    write(g, JSON.stringify({ llm: { timeoutMs: 60_000 }, commands: { patterns: ["global-pat"] } }));
    write(p, JSON.stringify({ llm: { provider: "ollama" }, commands: { patterns: ["project-pat"] } }));
    const r = load(g, p, true);
    assert.deepEqual(r.scopes.map((s) => [s.loaded, s.error]), [[true, undefined], [true, undefined]]);
    assert.equal(r.config.llm.timeoutMs, 60_000, "global scalar kept where project silent");
    assert.equal(r.config.llm.provider, "ollama", "project scalar override");
    assert.deepEqual(r.config.commands.patterns, ["global-pat", "project-pat"], "union, global first");
  });

  it("ignores an untrusted project file", () => {
    const g = join(tmp, "global.json");
    const p = join(tmp, "project.json");
    write(g, JSON.stringify({ llm: { timeoutMs: 60_000 } }));
    write(p, JSON.stringify({ llm: { timeoutMs: 1000 } }));
    const r = load(g, p, false);
    assert.equal(r.config.llm.timeoutMs, 60_000);
  });

  it("reports invalid JSON per scope without crashing", () => {
    const g = join(tmp, "broken.json");
    write(g, "{ not json");
    const r = load(g, null, true);
    assert.equal(r.config.llm.timeoutMs, 30_000, "defaults apply");
    assert.equal(r.scopes[0].loaded, false);
    assert.match(r.scopes[0].error ?? "", /invalid JSON/);
  });

  it("reports a non-object config per scope", () => {
    const g = join(tmp, "array.json");
    write(g, "[1,2]");
    const r = load(g, null, true);
    assert.equal(r.scopes[0].loaded, false);
    assert.match(r.scopes[0].error ?? "", /must be a JSON object/);
  });
});

describe("stampSchema", () => {
  it("prepends $schema", () => {
    const stamped = stampSchema({ enabled: false });
    assert.deepEqual(Object.keys(stamped), ["$schema", "enabled"]);
    assert.equal(stamped.$schema, SCHEMA_URL);
  });
});
