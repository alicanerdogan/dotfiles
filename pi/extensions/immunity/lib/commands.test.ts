import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchRules, matchesCommandRule } from "./commands.ts";
import type { CommandRule } from "./config.ts";

const R = (raw: string, opts: Partial<CommandRule> = {}): CommandRule => ({ action: "ask", exact: false, raw, ...opts });

describe("matchesCommandRule", () => {
  it("default (partial) is substring matching", () => {
    assert.ok(matchesCommandRule(R("npm install"), "npm install lodash"));
    assert.ok(matchesCommandRule(R("npm install"), "pnpm exec npm install --yes"));
    assert.ok(!matchesCommandRule(R("npm install"), "npm uninstall lodash"));
  });

  it("exact: true is full-string matching", () => {
    assert.ok(matchesCommandRule(R("git push --force", { exact: true }), "git push --force"));
    assert.ok(!matchesCommandRule(R("git push --force", { exact: true }), "git push --force origin main"));
    assert.ok(!matchesCommandRule(R("git push --force", { exact: true }), "git push --force-with-lease"));
  });

  it("regex wins when present and valid", () => {
    const rule = R("npm", { regex: "^npm (install|i)\\b" });
    assert.ok(matchesCommandRule(rule, "npm install lodash"));
    assert.ok(matchesCommandRule(rule, "npm i -D vitest"));
    assert.ok(!matchesCommandRule(rule, "npm uninstall lodash"));
    assert.ok(!matchesCommandRule(rule, "echo npm install"));
  });

  it("invalid regex degrades to string matching", () => {
    const rule = R("rm -rf", { regex: "[" });
    assert.ok(matchesCommandRule(rule, "rm -rf ./node_modules"));
  });
});

describe("matchRules", () => {
  it("returns all matching rules in order", () => {
    const rules = [R("one"), R("two", { exact: true }), R("three")];
    const matches = matchRules(rules, "one two three");
    assert.deepEqual(matches.map((m) => m.raw), ["one", "three"]);
  });
});
