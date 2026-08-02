import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAudit, blockMessage, defaultAuditPath, type AuditEntry } from "./audit.ts";
import { writeRule } from "./rules.ts";

describe("blockMessage", () => {
  it("user blocks carry the user reason when given; keep the pipeline reason otherwise", () => {
    assert.equal(blockMessage("user", "x", "never again"), "Blocked by user: never again");
    assert.equal(blockMessage("user", "LLM: touching outside cwd"), "Blocked by user: LLM: touching outside cwd");
  });

  it("policy/llm/session blocks prefix the pipeline reason", () => {
    assert.equal(blockMessage("policy", "denied by rule"), "Blocked by policy: denied by rule");
    assert.equal(blockMessage("llm", "high risk"), "Blocked by llm: high risk");
    assert.equal(blockMessage("session", "blocked for session"), "Blocked by session: blocked for session");
  });
});

describe("appendAudit", () => {
  it("writes one JSONL line and creates the directory", () => {
    const dir = mkdtempSync(join(import.meta.dirname, ".test-tmp-"));
    try {
      const file = join(dir, "nested", "audit.jsonl");
      const entry: AuditEntry = {
        event: "block",
        ts: "2025-01-01T00:00:00.000Z",
        sessionId: "s1",
        tool: "bash",
        action: "rm -rf /",
        reason: "destructive",
        source: "policy",
      };
      assert.equal(appendAudit(entry, file), true);
      assert.equal(appendAudit({ ...entry, event: "session", kind: "sessionDeny", value: "rm -rf /", scope: "session" }, file), true);
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      assert.equal(lines.length, 2);
      assert.equal(JSON.parse(lines[0]).source, "policy");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false instead of throwing on unwritable paths", () => {
    const dir = mkdtempSync(join(import.meta.dirname, ".test-tmp-"));
    try {
      const entry: AuditEntry = {
        event: "block",
        ts: "2025-01-01T00:00:00.000Z",
        sessionId: "s1",
        tool: "bash",
        action: "x",
        reason: "y",
        source: "llm",
      };
      assert.equal(appendAudit(entry, join(dir, "audit.jsonl")), true);
      // a path whose parent is a file
      const fileAsDir = join(dir, "f.jsonl");
      writeFileSync(fileAsDir, "x");
      assert.equal(appendAudit(entry, join(fileAsDir, "nested.jsonl")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("defaultAuditPath", () => {
  it("resolves to .pi/immunity.audit.jsonl under the cwd", () => {
    assert.equal(defaultAuditPath("/repo"), join("/repo", ".pi", "immunity.audit.jsonl"));
  });
});

describe("writeRule — menu rule persistence", () => {
  function tmp(): string {
    return mkdtempSync(join(import.meta.dirname, ".test-tmp-"));
  }

  it("writes command allow/deny as exact rules", () => {
    const dir = tmp();
    try {
      const file = join(dir, "immunity.json");
      writeRule(file, "commandAllow", "npm install lodash");
      writeRule(file, "commandDeny", "git push --force");
      const raw = JSON.parse(readFileSync(file, "utf8"));
      assert.deepEqual(raw.commands.rules, [
        { action: "allow", exact: true, raw: "npm install lodash" },
        { action: "deny", exact: true, raw: "git push --force" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes path allow/deny with kind", () => {
    const dir = tmp();
    try {
      const file = join(dir, "immunity.json");
      writeRule(file, "pathAllow", "~/repos", { pathKind: "directory" });
      writeRule(file, "pathDeny", "/etc/hosts");
      const raw = JSON.parse(readFileSync(file, "utf8"));
      assert.deepEqual(raw.paths.rules, [
        { action: "allow", kind: "directory", path: "~/repos" },
        { action: "deny", kind: "file", path: "/etc/hosts" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent — duplicates are not written twice", () => {
    const dir = tmp();
    try {
      const file = join(dir, "immunity.json");
      writeRule(file, "commandDeny", "ls");
      writeRule(file, "commandDeny", "ls");
      const raw = JSON.parse(readFileSync(file, "utf8"));
      assert.deepEqual(raw.commands.rules, [{ action: "deny", exact: true, raw: "ls" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never clobbers a scope file with invalid JSON", () => {
    const dir = tmp();
    try {
      const file = join(dir, "immunity.json");
      writeFileSync(file, "{broken");
      assert.equal(writeRule(file, "pathDeny", "/etc/hosts"), false);
      assert.equal(readFileSync(file, "utf8"), "{broken");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves existing entries and unrelated sections when adding a rule", () => {
    const dir = tmp();
    try {
      const file = join(dir, "immunity.json");
      writeRule(file, "commandDeny", "one");
      writeRule(file, "commandDeny", "two");
      writeRule(file, "pathAllow", "~/x");
      const raw = JSON.parse(readFileSync(file, "utf8"));
      assert.deepEqual(raw.commands.rules.map((r: { raw: string }) => r.raw), ["one", "two"]);
      assert.deepEqual(raw.paths.rules, [{ action: "allow", kind: "file", path: "~/x" }]);
      assert.equal(raw.$schema, undefined, "no $schema stamping");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
