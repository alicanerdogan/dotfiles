/**
 * Bus + onPromptCommand tests: channel names, payload shapes, prompt id
 * correlation, fire-and-forget spawn semantics (env, kill timeout,
 * failure logging).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUS, emitBlocked, emitGrantCreated, emitPromptClosed, emitPromptOpened, newPromptId, type Bus } from "./bus.ts";
import { promptEnv, runPromptCommand, PROMPT_ENV_KEYS } from "./notify.ts";

function fakeBus(): { bus: Bus; events: { channel: string; data: unknown }[] } {
  const events: { channel: string; data: unknown }[] = [];
  return { events, bus: { emit: (channel, data) => void events.push({ channel, data }) } };
}

describe("bus events", () => {
  it("emits blocked with the design payload", () => {
    const { bus, events } = fakeBus();
    emitBlocked(bus, {
      feature: "bash",
      action: "mkfs.ext4 /dev/sdb1",
      reason: "disk formatting",
      block: { source: "policy" },
      context: { sessionId: "s" },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].channel, "immunity:action:blocked");
    assert.deepEqual(events[0].data, {
      feature: "bash",
      action: "mkfs.ext4 /dev/sdb1",
      reason: "disk formatting",
      block: { source: "policy" },
      context: { sessionId: "s" },
    });
  });

  it("carries userReason when present", () => {
    const { bus, events } = fakeBus();
    emitBlocked(bus, {
      feature: "file",
      action: "modify /repo/.env",
      reason: "protected path",
      block: { source: "user", userReason: "keep away" },
      context: { sessionId: "s" },
    });
    assert.equal((events[0].data as { block: { userReason: string } }).block.userReason, "keep away");
  });

  it("prompt opened/closed share a correlated id", () => {
    const { bus, events } = fakeBus();
    const id = newPromptId();
    assert.equal(typeof id, "string");
    emitPromptOpened(bus, { prompt: { id, feature: "bash", reason: "sudo" } });
    emitPromptClosed(bus, { prompt: { id, feature: "bash", reason: "sudo" } });
    assert.deepEqual(
      events.map((e) => e.channel),
      ["immunity:prompt:opened", "immunity:prompt:closed"],
    );
    const opened = events[0].data as { prompt: { id: string } };
    const closed = events[1].data as { prompt: { id: string } };
    assert.equal(opened.prompt.id, id);
    assert.equal(closed.prompt.id, id);
  });

  it("grant created carries scope and persistence", () => {
    const { bus, events } = fakeBus();
    emitGrantCreated(bus, { feature: "bash", action: "ls", grant: { scope: "always", persisted: true } });
    assert.equal(events[0].channel, BUS.grantCreated);
    assert.deepEqual(events[0].data, { feature: "bash", action: "ls", grant: { scope: "always", persisted: true } });
  });
});

describe("promptEnv", () => {
  it("maps the four context variables", () => {
    const env = promptEnv("id-1", "bash", "sudo", "sudo rm -rf /x");
    assert.deepEqual(env, {
      IMMUNITY_PROMPT_ID: "id-1",
      IMMUNITY_FEATURE: "bash",
      IMMUNITY_REASON: "sudo",
      IMMUNITY_ACTION: "sudo rm -rf /x",
    });
    assert.deepEqual(Object.keys(env), [...PROMPT_ENV_KEYS]);
  });
});

describe("runPromptCommand", () => {
  class FakeChild {
    killed = false;
    errored: (() => void) | null = null;
    closed: (() => void) | null = null;
    on(ev: string, fn: () => void): this {
      if (ev === "error") this.errored = fn;
      if (ev === "close") this.closed = fn;
      return this;
    }
    kill(): boolean {
      this.killed = true;
      return true;
    }
    fail(err: Error): void {
      this.errored?.(err);
    }
  }

  it("spawns with a shell, merged env, and ignored stdio", () => {
    let seen: Record<string, unknown> | null = null;
    const child = new FakeChild();
    const spawnFn = (cmd: string, args: string[], options: Record<string, unknown>) => {
      seen = { cmd, args, options };
      return child as never;
    };
    runPromptCommand("osascript -e 'hi'", { IMMUNITY_PROMPT_ID: "p1", IMMUNITY_FEATURE: "bash", IMMUNITY_REASON: "r", IMMUNITY_ACTION: "a" }, { spawn: spawnFn, timeoutMs: 1000 });
    assert.ok(seen);
    assert.equal(seen.cmd, "osascript -e 'hi'");
    assert.equal(seen.options.shell, true);
    assert.equal(seen.options.stdio, "ignore");
    const env = seen.options.env as Record<string, string>;
    assert.equal(env.IMMUNITY_PROMPT_ID, "p1");
    assert.equal(env.IMMUNITY_FEATURE, "bash");
    assert.ok(env.PATH !== undefined, "process env is inherited");
  });

  it("kills a lingering notification after the timeout", async () => {
    const child = new FakeChild();
    const spawnFn = () => child as never;
    runPromptCommand("sleep 100", {}, { spawn: spawnFn, timeoutMs: 20 });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(child.killed, true);
  });

  it("does not kill a child that exits on its own", async () => {
    const child = new FakeChild();
    const spawnFn = () => child as never;
    runPromptCommand("true", {}, { spawn: spawnFn, timeoutMs: 30 });
    await new Promise((r) => setTimeout(r, 5));
    child.closed?.(); // exits before the timeout
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(child.killed, false);
  });

  it("logs spawn failures and never throws", () => {
    const logs: string[] = [];
    const spawnFn = () => {
      throw new Error("nope");
    };
    assert.doesNotThrow(() => runPromptCommand("boom", {}, { spawn: spawnFn, log: (m) => logs.push(m) }));
    assert.equal(logs.length, 1);
    assert.ok(logs[0].includes("nope"));
  });

  it("logs async child errors", () => {
    const logs: string[] = [];
    const child = new FakeChild();
    const spawnFn = () => child as never;
    runPromptCommand("true", {}, { spawn: spawnFn, log: (m) => logs.push(m) });
    child.fail(new Error("EACCES"));
    assert.equal(logs.length, 1);
    assert.ok(logs[0].includes("EACCES"));
  });

  it("does nothing for an empty command", () => {
    let called = false;
    runPromptCommand("", {}, { spawn: () => (called = true, new FakeChild() as never) });
    assert.equal(called, false);
  });
});
