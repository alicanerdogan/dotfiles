import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  asCommandRule,
  asPathRule,
  DEFAULT_CONFIG,
  isValidPathInput,
  loadConfig,
  mergeConfig,
  normalizeConfig,
} from "./config.ts";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(import.meta.dirname, ".test-tmp-"));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("defaults", () => {
  it("normalizeConfig(null) is the default config", () => {
    assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG);
    assert.equal(DEFAULT_CONFIG.strict, true);
    assert.equal(DEFAULT_CONFIG.commands.promptWhen, "blocked");
    assert.equal(DEFAULT_CONFIG.llm.disabled, false);
    assert.equal(DEFAULT_CONFIG.audit.enabled, true);
  });

  it("tolerates unknown keys ($schema) and drops invalid sections", () => {
    const c = normalizeConfig({ $schema: "file:///x", bogus: 1, llm: { provider: 42 } });
    assert.deepEqual(c.llm, DEFAULT_CONFIG.llm);
    assert.deepEqual(c.paths, { rules: [] });
  });
});

describe("path input contract", () => {
  it("accepts ~, ~/, ./ and absolute; rejects bare relatives and ..", () => {
    assert.ok(isValidPathInput("~"));
    assert.ok(isValidPathInput("~/keys"));
    assert.ok(isValidPathInput("./.env"));
    assert.ok(isValidPathInput("/etc/hosts"));
    assert.ok(!isValidPathInput("foo"));
    assert.ok(!isValidPathInput("../foo"));
    assert.ok(!isValidPathInput(""));
  });

  it("rejects globs anywhere", () => {
    assert.ok(!isValidPathInput("~/keys/*"));
    assert.ok(!isValidPathInput("**/.env"));
    assert.ok(!isValidPathInput("./a[b]"));
    assert.ok(!isValidPathInput("~/?" ));
  });
});

describe("asPathRule", () => {
  it("parses a valid rule", () => {
    assert.deepEqual(asPathRule({ action: "ask", kind: "file", path: "./.env" }), {
      action: "ask",
      kind: "file",
      path: "./.env",
    });
  });

  it("drops invalid entries", () => {
    assert.equal(asPathRule({ action: "run", kind: "file", path: "./x" }), null);
    assert.equal(asPathRule({ action: "allow", kind: "tree", path: "./x" }), null);
    assert.equal(asPathRule({ action: "allow", kind: "file", path: "x" }), null); // relative without ./
    assert.equal(asPathRule({ action: "allow", kind: "file", path: "~/x/*" }), null); // glob
    assert.equal(asPathRule({}), null);
  });
});

describe("asCommandRule", () => {
  it("parses a valid rule; exact defaults false", () => {
    assert.deepEqual(asCommandRule({ action: "ask", raw: "npm install" }), {
      action: "ask",
      exact: false,
      raw: "npm install",
    });
    assert.deepEqual(asCommandRule({ action: "deny", exact: true, raw: "git push --force" }), {
      action: "deny",
      exact: true,
      raw: "git push --force",
    });
  });

  it("keeps the rule when regex is broken — degrades to string matching", () => {
    const rule = asCommandRule({ action: "deny", raw: "rm -rf", regex: "[" });
    assert.ok(rule);
    assert.equal(rule.regex, undefined);
  });

  it("keeps a valid regex", () => {
    const rule = asCommandRule({ action: "ask", raw: "npm", regex: "^npm (install|i)\\b" });
    assert.equal(rule.regex, "^npm (install|i)\\b");
  });

  it("drops invalid entries", () => {
    assert.equal(asCommandRule({ action: "maybe", raw: "x" }), null);
    assert.equal(asCommandRule({ action: "allow" }), null);
    assert.equal(asCommandRule({ action: "allow", raw: "" }), null);
  });
});

describe("mergeConfig", () => {
  it("concatenates rules project-first over global", () => {
    const global = normalizeConfig({
      paths: { rules: [{ action: "deny", kind: "directory", path: "~/.ssh" }] },
      commands: { rules: [{ action: "deny", exact: true, raw: "git push --force" }] },
    });
    const merged = mergeConfig(global, {
      paths: { rules: [{ action: "allow", kind: "directory", path: "~/repos" }] },
    });
    assert.deepEqual(merged.paths.rules.map((r) => r.path), ["~/repos", "~/.ssh"]);
    assert.deepEqual(merged.commands.rules, global.commands.rules);
  });

  it("scalars are project-overrides-global", () => {
    const global = normalizeConfig({ strict: true, commands: { promptWhen: "blocked" } });
    const merged = mergeConfig(global, { strict: false, commands: { promptWhen: "everytime" } });
    assert.equal(merged.strict, false);
    assert.equal(merged.commands.promptWhen, "everytime");
    // invalid project values fall back to global
    const merged2 = mergeConfig(global, { strict: "yes", commands: { promptWhen: "sometimes" } });
    assert.equal(merged2.strict, true);
    assert.equal(merged2.commands.promptWhen, "blocked");
  });

  it("llm + hooks + audit merge per field", () => {
    const global = normalizeConfig({ llm: { provider: "a", model: "m1" } });
    const merged = mergeConfig(global, { llm: { provider: "b" }, hooks: { afterPrompt: "echo hi" }, audit: { enabled: false } });
    assert.equal(merged.llm.provider, "b");
    assert.equal(merged.llm.model, "m1");
    assert.equal(merged.hooks.afterPrompt, "echo hi");
    assert.equal(merged.audit.enabled, false);
  });
});

describe("loadConfig", () => {
  it("defaults when both files are missing; scopes report not-loaded", () => {
    const dir = tmp();
    const r = loadConfig({ globalPath: join(dir, "g.json"), projectPath: join(dir, "p.json"), trusted: true });
    assert.deepEqual(r.config, DEFAULT_CONFIG);
    assert.equal(r.scopes.length, 2);
    assert.ok(r.scopes.every((s) => !s.loaded));
    assert.deepEqual(r.rules, { paths: { project: [], global: [] }, commands: { project: [], global: [] } });
  });

  it("reports invalid JSON per scope and falls back to defaults", () => {
    const dir = tmp();
    writeFileSync(join(dir, "g.json"), "{broken");
    const r = loadConfig({ globalPath: join(dir, "g.json"), projectPath: null, trusted: true });
    assert.match(r.scopes[0].error ?? "", /invalid JSON/);
    assert.deepEqual(r.config, DEFAULT_CONFIG);
  });

  it("skips the project scope for untrusted projects", () => {
    const dir = tmp();
    writeFileSync(join(dir, "p.json"), JSON.stringify({ strict: false }));
    const r = loadConfig({ globalPath: join(dir, "g.json"), projectPath: join(dir, "p.json"), trusted: false });
    assert.deepEqual(r.config, DEFAULT_CONFIG);
    assert.equal(r.scopes[1].skipped, true);
  });

  it("loads scoped rules: project + global views", () => {
    const dir = tmp();
    writeFileSync(join(dir, "g.json"), JSON.stringify({ paths: { rules: [{ action: "deny", kind: "directory", path: "~/.ssh" }] } }));
    writeFileSync(join(dir, "p.json"), JSON.stringify({ paths: { rules: [{ action: "allow", kind: "file", path: "./x" }] } }));
    const r = loadConfig({ globalPath: join(dir, "g.json"), projectPath: join(dir, "p.json"), trusted: true });
    assert.deepEqual(r.rules.paths.project.map((x) => x.path), ["./x"]);
    assert.deepEqual(r.rules.paths.global.map((x) => x.path), ["~/.ssh"]);
    // merged config: project first, then global
    assert.deepEqual(r.config.paths.rules.map((x) => x.path), ["./x", "~/.ssh"]);
  });
});
