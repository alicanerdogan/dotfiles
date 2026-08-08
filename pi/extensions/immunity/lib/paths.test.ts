/**
 * Unit tests for the path engine: path expansion, glob translation,
 * protected/allowed evaluation, mode strictness, onlyIfExists, precedence.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { compileGlob, evaluatePath, expandPath, isOutsideScope, matchesAllow, matchesRule, realResolve } from "./paths.ts";
import { normalizeConfig, type PathnameRules } from "./config.ts";

const CWD = "/repo";
const HOME = "/home/u";
const RULES = (partial: unknown): PathnameRules => normalizeConfig({ pathnames: partial }).pathnames;

describe("expandPath", () => {
  it("expands a leading ~/ against home", () => {
    assert.equal(expandPath("~/keys/test", { cwd: CWD, home: HOME }), "/home/u/keys/test");
    assert.equal(expandPath("~", { cwd: CWD, home: HOME }), "/home/u");
  });

  it("resolves relative paths against cwd", () => {
    assert.equal(expandPath("build/out.js", { cwd: CWD, home: HOME }), "/repo/build/out.js");
    assert.equal(expandPath("./x", { cwd: CWD, home: HOME }), "/repo/x");
    assert.equal(expandPath("../x", { cwd: "/repo/a", home: HOME }), "/repo/x");
  });

  it("keeps absolute paths and mid-path tildes untouched", () => {
    assert.equal(expandPath("/etc/hosts", { cwd: CWD, home: HOME }), "/etc/hosts");
    assert.equal(expandPath("a/~/b", { cwd: CWD, home: HOME }), "/repo/a/~/b");
  });
});

describe("compileGlob", () => {
  const m = (pattern: string, target: string) => compileGlob(pattern)(target);

  it("matches **/ at any depth, including root", () => {
    assert.ok(m("**/.env*", "/repo/.env"));
    assert.ok(m("**/.env*", "/repo/a/.env"));
    assert.ok(m("**/.env*", "/repo/a/b/.env.local"));
    assert.ok(!m("**/.env*", "/repo/a/env"));
    assert.ok(!m("**/.env*", "/repo/.envx/b")); // .envx is a file, not a dir
  });

  it("matches **/*.pem at any depth", () => {
    assert.ok(m("**/*.pem", "/repo/key.pem"));
    assert.ok(m("**/*.pem", "/repo/a/b/key.pem"));
    assert.ok(!m("**/*.pem", "/repo/a/b/key.pem.bak"));
  });

  it("matches literal absolute paths exactly", () => {
    assert.ok(m("/etc/hosts", "/etc/hosts"));
    assert.ok(!m("/etc/hosts", "/etc/hosts.bak"));
    assert.ok(!m("/etc/hosts", "/etc/host"));
  });

  it("treats a trailing ** as prefix-plus-anything", () => {
    assert.ok(m("/repo/a/**", "/repo/a"));
    assert.ok(m("/repo/a/**", "/repo/a/b"));
    assert.ok(m("/repo/a/**", "/repo/a/b/c"));
    assert.ok(!m("/repo/a/**", "/repo/ab"));
  });

  it("matches ** mid-pattern with zero or more segments", () => {
    assert.ok(m("/repo/a/**/b", "/repo/a/b"));
    assert.ok(m("/repo/a/**/b", "/repo/a/x/b"));
    assert.ok(m("/repo/a/**/b", "/repo/a/x/y/b"));
    assert.ok(!m("/repo/a/**/b", "/repo/a/b/c"));
  });

  it("supports * and ? within a segment", () => {
    assert.ok(m("/repo/*.ts", "/repo/a.ts"));
    assert.ok(!m("/repo/*.ts", "/repo/a/b.ts"));
    assert.ok(m("/repo/f?o", "/repo/foo"));
    assert.ok(!m("/repo/f?o", "/repo/fo"));
  });

  it("treats regex specials literally", () => {
    assert.ok(m("/repo/a+b", "/repo/a+b"));
    assert.ok(!m("/repo/a+b", "/repo/aab"));
    assert.ok(m("**/(x)", "/repo/(x)"));
  });

  it("matches everything for a bare **", () => {
    assert.ok(m("**", "/anything/at/all"));
    assert.ok(m("**", "/"));
  });

  it("handles a trailing slash on the pattern", () => {
    assert.ok(m("/repo/a/**/", "/repo/a/x"));
  });
});

describe("matchesRule", () => {
  const opts = { cwd: CWD, home: HOME };

  it("expands ~/ and relative patterns before matching", () => {
    const rule = { pattern: "~/keys/**", mode: "read" as const, regex: false };
    assert.ok(matchesRule(rule, "/home/u/keys/a.pem", opts));
    assert.ok(!matchesRule(rule, "/home/u/other/a.pem", opts));

    const rel = { pattern: "build/**", mode: "read" as const, regex: false };
    assert.ok(matchesRule(rel, "/repo/build/out.js", opts));
  });

  it("matches regex patterns against the resolved target", () => {
    const rule = { pattern: "^/etc/.*\\.conf$", mode: "read" as const, regex: true };
    assert.ok(matchesRule(rule, "/etc/ssh/sshd.conf", opts));
    assert.ok(!matchesRule(rule, "/etc/ssh/sshd", opts));
  });

  it("never matches a broken regex", () => {
    const rule = { pattern: "(", mode: "read" as const, regex: true };
    assert.equal(matchesRule(rule, "/etc/hosts", opts), false);
  });
});

describe("matchesAllow", () => {
  const opts = { cwd: CWD, home: HOME };

  it("file kind matches exactly", () => {
    assert.ok(matchesAllow({ kind: "file", path: "~/.env.work" }, "/home/u/.env.work", opts));
    assert.ok(!matchesAllow({ kind: "file", path: "~/.env.work" }, "/home/u/.env.work.bak", opts));
  });

  it("directory kind matches the directory and descendants", () => {
    const d = { kind: "directory" as const, path: "~/keys/test" };
    assert.ok(matchesAllow(d, "/home/u/keys/test", opts));
    assert.ok(matchesAllow(d, "/home/u/keys/test/a.pem", opts));
    assert.ok(matchesAllow(d, "/home/u/keys/test/a/b.pem", opts));
    assert.ok(!matchesAllow(d, "/home/u/keys/test2/a.pem", opts));
    assert.ok(!matchesAllow(d, "/home/u/keys", opts));
  });

  it("resolves relative allow paths against cwd", () => {
    assert.ok(matchesAllow({ kind: "directory", path: "data" }, "/repo/data/x", opts));
  });
});

describe("evaluatePath", () => {
  const opts = (rules: PathnameRules, extra: Partial<Parameters<typeof evaluatePath>[1]> = {}) =>
    evaluatePath("/repo/.env", { kind: "modify", cwd: CWD, home: HOME, rules, ...extra });

  it("returns not protected/allowed for empty rules", () => {
    const r = opts(RULES({}));
    assert.deepEqual(r, { protected: false, allowed: false, outside: false });
  });

  it("protects a matching modify rule", () => {
    const r = opts(RULES({ protected: [{ pattern: "**/.env*", mode: "modify" }] }));
    assert.equal(r.protected, true);
    assert.equal(r.allowed, false);
    assert.equal(r.rule?.pattern, "**/.env*");
  });

  it("is mode-strict: read rules do not gate modify accesses", () => {
    const rules = RULES({ protected: [{ pattern: "**/.env*", mode: "read" }] });
    assert.equal(opts(rules).protected, false, "modify access, read rule");
    assert.equal(opts(rules, { kind: "read" }).protected, true, "read access, read rule");
  });

  it("an exact allow bypasses protection", () => {
    const rules = RULES({
      protected: [{ pattern: "**/.env*", mode: "modify" }],
      allowed: [{ kind: "file", path: "/repo/.env" }],
    });
    const r = opts(rules);
    assert.equal(r.protected, true);
    assert.equal(r.allowed, true);
  });

  it("a directory allow covers descendants", () => {
    const rules = RULES({
      protected: [{ pattern: "**/*.pem", mode: "read" }],
      allowed: [{ kind: "directory", path: "~/keys/test" }],
    });
    const r = evaluatePath("/home/u/keys/test/a.pem", { kind: "read", cwd: CWD, home: HOME, rules });
    assert.equal(r.protected, true);
    assert.equal(r.allowed, true);
  });

  it("allowed without protected still reports protected=false", () => {
    const rules = RULES({ allowed: [{ kind: "file", path: "/repo/.env" }] });
    const r = opts(rules);
    assert.equal(r.protected, false);
    assert.equal(r.allowed, true);
  });

  it("onlyIfExists rules fire only when the target exists", () => {
    const rules = RULES({ protected: [{ pattern: "**/.env*", mode: "modify", onlyIfExists: true }] });
    assert.equal(opts(rules, { exists: true }).protected, true);
    assert.equal(opts(rules, { exists: false }).protected, false, "creating a new file is not gated");
  });

  it("onlyIfExists defaults to fs.existsSync on the real target", () => {
    const dir = mkdtempSync(join(import.meta.dirname, ".test-tmp-"));
    try {
      const existing = join(dir, "sub", ".env");
      mkdirSync(join(dir, "sub"));
      writeFileSync(existing, "x");
      const missing = join(dir, "other", ".env");
      const rules = RULES({ protected: [{ pattern: "**/.env", mode: "modify", onlyIfExists: true }] });
      assert.equal(evaluatePath(existing, { kind: "modify", cwd: CWD, home: HOME, rules }).protected, true);
      assert.equal(evaluatePath(missing, { kind: "modify", cwd: CWD, home: HOME, rules }).protected, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records only the first matching rule", () => {
    const rules = RULES({
      protected: [
        { pattern: "**/.env*", mode: "modify" },
        { pattern: "/repo/**", mode: "modify" },
      ],
    });
    const r = opts(rules);
    assert.equal(r.rule?.pattern, "**/.env*");
  });
});

describe("config boundary: broken regex rules", () => {
  it("drops invalid regex patterns at load", () => {
    const rules = RULES({ protected: [{ pattern: "(", mode: "read", regex: true }, { pattern: "/etc/.*", mode: "read", regex: true }] });
    assert.equal(rules.protected.length, 1);
    assert.equal(rules.protected[0].pattern, "/etc/.*");
  });
});

describe("outside-cwd boundary", () => {
  it("isOutsideScope: inside, outside, .. traversal, root cwd, sibling prefix", () => {
    assert.equal(isOutsideScope("/repo/notes.txt", "/repo"), false);
    assert.equal(isOutsideScope("/repo", "/repo"), false);
    assert.equal(isOutsideScope("/repo/sub/a.env", "/repo"), false);
    assert.equal(isOutsideScope("/etc/passwd", "/repo"), true);
    assert.equal(isOutsideScope("/home/u/keys/a.pem", "/repo"), true);
    assert.equal(isOutsideScope("/other/x", "/repo"), true, ".. traversal resolves outside");
    assert.equal(isOutsideScope("/repo2/file", "/repo"), true, "sibling prefix is not inside");
    assert.equal(isOutsideScope("/repo2/file", "/repo2"), false);
    assert.equal(isOutsideScope("/anything", "/"), false, "root cwd: everything in scope");
    assert.equal(isOutsideScope("/repo/x/", "/repo"), false, "trailing slash ignored");
  });

  it("evaluatePath flags targets outside cwd (realpath falls back to the resolved string)", () => {
    const rules = RULES({});
    assert.equal(evaluatePath("notes.txt", { kind: "read", cwd: CWD, home: HOME, rules }).outside, false);
    assert.equal(evaluatePath("../other/secret.txt", { kind: "read", cwd: CWD, home: HOME, rules }).outside, true);
    assert.equal(evaluatePath("~/keys/a.pem", { kind: "read", cwd: CWD, home: HOME, rules }).outside, true);
    assert.equal(evaluatePath("/etc/passwd", { kind: "read", cwd: CWD, home: HOME, rules }).outside, true);
  });

  it("realResolve catches a symlink inside cwd pointing outside", () => {
    const dir = mkdtempSync(join(import.meta.dirname, ".test-tmp-"));
    try {
      const cwd = join(dir, "cwd");
      const outside = join(dir, "outside");
      mkdirSync(cwd);
      mkdirSync(outside);
      writeFileSync(join(outside, "secret.txt"), "x");
      symlinkSync(outside, join(cwd, "link"));

      const rules = RULES({});
      assert.equal(evaluatePath(join(cwd, "notes.txt"), { kind: "read", cwd, home: HOME, rules }).outside, false);
      assert.equal(evaluatePath(join(cwd, "link", "secret.txt"), { kind: "read", cwd, home: HOME, rules }).outside, true);
      // write through a symlinked directory whose target does not exist yet
      assert.equal(evaluatePath(join(cwd, "link", "new.txt"), { kind: "modify", cwd, home: HOME, rules }).outside, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("realResolve never throws and returns the input on total failure", () => {
    assert.equal(realResolve("/repo/notes.txt"), "/repo/notes.txt");
    assert.equal(realResolve("/nonexistent/deep/path"), "/nonexistent/deep/path");
  });
});
