/**
 * Reason-pipeline tests: block messages, audit JSONL writes (parent dirs,
 * failure safety, round-trip), rule conversion (write/create/dedupe,
 * never clobbering broken scope files).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAudit, blockMessage, defaultAuditPath, type AuditEntry } from "./audit.ts";
import { writeRule } from "./rules.ts";

const tmp = () => mkdtempSync(join(import.meta.dirname, ".test-tmp-"));

describe("blockMessage", () => {
  it("user blocks carry the user reason when given", () => {
    assert.equal(blockMessage("user", "rm -rf", "I'll handle it"), "Blocked by user: I'll handle it");
    assert.equal(blockMessage("user", "rm -rf"), "Blocked by user");
  });

  it("policy/autoDeny/llm blocks prefix the pipeline reason", () => {
    assert.equal(blockMessage("policy", "disk formatting"), "Blocked by policy: disk formatting");
    assert.equal(blockMessage("autoDeny", "pattern match"), "Blocked by autoDeny: pattern match");
    assert.equal(blockMessage("llm", "force push"), "Blocked by llm: force push");
  });
});

describe("appendAudit", () => {
  const entry: AuditEntry = {
    event: "block",
    ts: "2025-08-02T10:00:00.000Z",
    sessionId: "sess-1",
    tool: "bash",
    action: "mkfs.ext4 /dev/sdb1",
    reason: "disk formatting (mkfs/newfs)",
    source: "policy",
  };

  it("writes JSONL, creating parent directories", () => {
    const dir = tmp();
    try {
      const file = join(dir, "nested", "deep", "audit.jsonl");
      assert.equal(appendAudit(entry, file), true);
      const lines = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);
      assert.deepEqual(JSON.parse(lines[0]), entry);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends lines and round-trips user reasons", () => {
    const dir = tmp();
    try {
      const file = join(dir, "audit.jsonl");
      appendAudit(entry, file);
      appendAudit({ ...entry, userReason: "no", source: "user" }, file);
      const lines = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 2);
      assert.equal(JSON.parse(lines[1]).userReason, "no");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false instead of throwing when unwritable", () => {
    const dir = tmp();
    try {
      const blocker = join(dir, "blocker");
      writeFileSync(blocker, "x");
      assert.equal(appendAudit(entry, join(blocker, "audit.jsonl")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("default audit path is <cwd>/.pi/immunity.audit.jsonl", () => {
    assert.equal(defaultAuditPath("/repo"), "/repo/.pi/immunity.audit.jsonl");
  });

  it("round-trips verdict entries with flat verdict fields", () => {
    const dir = tmp();
    try {
      const file = join(dir, "audit.jsonl");
      const v: AuditEntry = {
        event: "verdict",
        ts: "2025-08-05T19:30:00.000Z",
        sessionId: "sess-1",
        tool: "bash",
        action: "cat .env",
        risk: "low",
        outcome: "ALLOWED",
        reason: "read-only",
        llm: { provider: "opencode-go", model: "deepseek-v4-flash" },
      };
      assert.equal(appendAudit(v, file), true);
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8").trim()), v);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips inconclusive verdict entries with a failure string", () => {
    const dir = tmp();
    try {
      const file = join(dir, "audit.jsonl");
      const v: AuditEntry = {
        event: "verdict",
        ts: "2025-08-05T19:31:00.000Z",
        sessionId: "sess-1",
        tool: "bash",
        action: "ls",
        risk: null,
        outcome: null,
        failure: "timeout: no verdict within 30000ms",
        llm: {},
      };
      appendAudit(v, file);
      const parsed = JSON.parse(readFileSync(file, "utf8").trim());
      assert.equal(parsed.failure, "timeout: no verdict within 30000ms");
      assert.equal(parsed.outcome, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writeRule", () => {
  it("creates a missing scope file with $schema stamped", () => {
    const dir = tmp();
    try {
      const file = join(dir, "immunity.json");
      assert.equal(writeRule(file, "autoDeny", "git push --force"), true);
      const raw = JSON.parse(readFileSync(file, "utf8"));
      assert.ok(raw.$schema.endsWith("immunity.schema.json"));
      assert.deepEqual(raw.commands.autoDenyPatterns, ["git push --force"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds to existing sections without touching other fields", () => {
    const dir = tmp();
    try {
      const file = join(dir, "immunity.json");
      writeRule(file, "autoDeny", "git push --force");
      writeRule(file, "path", "/etc/hosts");
      const raw = JSON.parse(readFileSync(file, "utf8"));
      assert.deepEqual(raw.commands.autoDenyPatterns, ["git push --force"]);
      assert.deepEqual(raw.pathnames.protected, [{ pattern: "/etc/hosts", mode: "modify" }]);
      assert.equal(raw.enabled, undefined, "unrelated sections untouched");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent — duplicates are not written twice", () => {
    const dir = tmp();
    try {
      const file = join(dir, "immunity.json");
      writeRule(file, "autoDeny", "ls");
      writeRule(file, "autoDeny", "ls");
      const raw = JSON.parse(readFileSync(file, "utf8"));
      assert.deepEqual(raw.commands.autoDenyPatterns, ["ls"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes allow grants to the right sections", () => {
    const dir = tmp();
    try {
      const file = join(dir, "immunity.json");
      writeRule(file, "commandAllow", "ls -la");
      writeRule(file, "pathAllow", "~/keys/test", { pathKind: "directory" });
      const raw = JSON.parse(readFileSync(file, "utf8"));
      assert.deepEqual(raw.commands.allowed, ["ls -la"]);
      assert.deepEqual(raw.pathnames.allowed, [{ kind: "directory", path: "~/keys/test" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never clobbers a scope file with invalid JSON", () => {
    const dir = tmp();
    try {
      const file = join(dir, "immunity.json");
      writeFileSync(file, "{broken");
      assert.equal(writeRule(file, "autoDeny", "ls"), false);
      assert.equal(readFileSync(file, "utf8"), "{broken");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves existing entries when adding a rule", () => {
    const dir = tmp();
    try {
      const file = join(dir, "immunity.json");
      writeRule(file, "autoDeny", "one");
      writeRule(file, "autoDeny", "two");
      const raw = JSON.parse(readFileSync(file, "utf8"));
      assert.deepEqual(raw.commands.autoDenyPatterns, ["one", "two"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
