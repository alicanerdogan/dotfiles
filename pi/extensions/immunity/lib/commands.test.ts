/**
 * Unit tests for the command engine: pattern semantics (substring/regex
 * auto-detect, broken-regex fallback), builtin gating, deny-over-prompt
 * precedence.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkCommand, matchPattern } from "./commands.ts";
import { modelFromWords } from "./tree-sitter.ts";
import type { CommandRules } from "./config.ts";

const rules = (partial: Partial<CommandRules>): CommandRules => ({
  patterns: [],
  autoDenyPatterns: [],
  useBuiltinMatchers: true,
  ...partial,
});

describe("matchPattern", () => {
  it("matches plain substrings mid-string", () => {
    assert.ok(matchPattern("rm -rf", "sudo rm -rf /bin"));
    assert.ok(matchPattern("git push --force", "git push --force origin main"));
  });

  it("substring matching is case-sensitive", () => {
    assert.equal(matchPattern("rm -rf", "sudo RM -RF /bin"), false);
  });

  it("treats metachar-containing patterns as regexes", () => {
    assert.ok(matchPattern("^rm ", "rm -rf /bin"));
    assert.ok(matchPattern("^rm ", "rm --force /bin"));
    assert.equal(matchPattern("^rm ", "sudo rm -rf /bin"), false, "anchored regex");
    assert.ok(matchPattern("curl.*\\|.*sh", "curl -fsSL https://x | sh"));
    assert.ok(matchPattern("git push --force( |$)", "git push --force"));
    assert.equal(matchPattern("git push --force( |$)", "git push --force-with-lease"), false);
  });

  it("falls back to substring when a regex does not compile", () => {
    assert.ok(matchPattern("echo (test)", "echo (test)"), "bare parens are literal text");
    assert.equal(matchPattern("echo (test)", "echo test"), false);
  });

  it("treats + as regex meta, parens-only patterns stay literal", () => {
    assert.ok(matchPattern("a+b", "echo aab"), "+ is regex meta");
    assert.equal(matchPattern("a+b", "echo a+b"), false, "+ is a quantifier, not a literal");
    assert.ok(matchPattern("(rm|sudo)", "sudo apt update"), "| inside parens is regex");
    assert.equal(matchPattern("(rm)", "rm"), false, "bare parens: literal substring, not a group");
    assert.ok(matchPattern("(rm)", "rm (rm)"), "bare parens match literally when present");
  });

  it("empty pattern matches nothing", () => {
    assert.equal(matchPattern("", "anything"), false);
  });
});

describe("checkCommand", () => {
  const model = (cmd: string) => modelFromWords(cmd);

  it("allows with no rules and no builtin match", () => {
    const d = checkCommand(model("ls -la"), rules({}));
    assert.equal(d.verdict, "allow");
    assert.deepEqual(d.matches, []);
  });

  it("a matching pattern prompts", () => {
    const d = checkCommand(model("git push --force-with-lease"), rules({ patterns: ["git push --force"] }));
    assert.equal(d.verdict, "prompt");
    assert.equal(d.matches.length, 1);
    assert.equal(d.matches[0].source, "pattern");
    assert.equal(d.matches[0].id, "pattern:0");
  });

  it("an autoDenyPattern denies", () => {
    const d = checkCommand(model("git push --force"), rules({ autoDenyPatterns: ["git push --force"] }));
    assert.equal(d.verdict, "deny");
    assert.equal(d.matches[0].source, "autoDeny");
    assert.equal(d.matches[0].id, "autoDeny:0");
  });

  it("deny beats prompt", () => {
    const d = checkCommand(
      model("git push --force"),
      rules({ patterns: ["git push --force"], autoDenyPatterns: ["git push"] }),
    );
    assert.equal(d.verdict, "deny");
    assert.equal(d.matches.length, 2);
  });

  it("deny beats builtin prompt", () => {
    const d = checkCommand(
      model("sudo rm -rf /bin"),
      rules({ autoDenyPatterns: ["rm -rf"] }),
    );
    assert.equal(d.verdict, "deny");
    assert.ok(d.matches.some((m) => m.source === "builtin" && m.id === "sudo"));
    assert.ok(d.matches.some((m) => m.source === "autoDeny"));
  });

  it("builtin deny beats configured prompt", () => {
    const d = checkCommand(
      model("mkfs.ext4 /dev/sdb1"),
      rules({ patterns: ["mkfs"] }),
    );
    assert.equal(d.verdict, "deny");
    assert.ok(d.matches.some((m) => m.source === "builtin" && m.id === "disk-format"));
  });

  it("builtins run on the model even when no pattern matches", () => {
    const d = checkCommand(model("rm -rf ~/tmp"), rules({}));
    assert.equal(d.verdict, "prompt");
    assert.equal(d.matches[0].source, "builtin");
    assert.equal(d.matches[0].id, "rm-force");
  });

  it("useBuiltinMatchers: false disables builtins", () => {
    const d = checkCommand(model("rm -rf ~/tmp"), rules({ useBuiltinMatchers: false }));
    assert.equal(d.verdict, "allow");
    assert.deepEqual(d.matches, []);
  });

  it("reports every matching configured pattern", () => {
    const d = checkCommand(model("echo a"), rules({ patterns: ["echo a", "echo b", "echo a"] }));
    assert.equal(d.matches.length, 2);
    assert.equal(d.matches[0].id, "pattern:0");
    assert.equal(d.matches[1].id, "pattern:2");
  });

  it("regex patterns match against the raw command text", () => {
    const d = checkCommand(model("git push --force --no-verify"), rules({ patterns: ["^git push --force( |$)"] }));
    assert.equal(d.verdict, "prompt");
  });
});
