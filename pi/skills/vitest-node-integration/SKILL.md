---
name: vitest-node-integration
description: Set up and write tests with Vitest for Node.js projects. Use when asked to "add tests", "write tests", "test a Node.js module", "set up vitest", "mock dependencies", "integration test", "test an Express server", or "test with supertest". Covers unit testing with vi.mock, HTTP integration testing with supertest, database testing with isolated test databases, and SSE/stream testing with async iterators.
---

# Vitest Node.js Integration

Set up and write tests with Vitest for Node.js/TypeScript projects. Covers unit tests with mocked dependencies, integration tests with HTTP servers and databases, and async stream testing.

## Step 1: Set Up Vitest

Install dependencies:

```bash
npm install -D vitest supertest @types/supertest @types/node
# or for SSE testing:
npm install -D eventsource-client
```

Add a test script to `package.json`:

```json
{
  "scripts": {
    "test": "vitest --passWithNoTests",
    "test:run": "vitest run"
  }
}
```

Create `vitest.config.ts` if the project needs special configuration (e.g., no parallel file execution for shared state):

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false, // disable when tests share a database or global state
  },
});
```

For monorepos with pnpm workspaces, each package can have its own `vitest.config.ts`. The root `package.json` can run `pnpm -r test` to delegate to each workspace.

## Step 2: Write Unit Tests with Mocks

Use `vi.mock()` with `vi.hoisted()` to mock ES modules at the top level. Mock dependencies before importing the code under test.

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

const connectMock = vi.hoisted(() => vi.fn());

vi.mock("../core/session.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/session.ts")>();
  return {
    ...actual,
    connectAndActivate: connectMock,
  };
});

// Now import the module that uses the mocked dependency
import { MyClient } from "./client.ts";

describe("MyClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("connects on first call", async () => {
    connectMock.mockResolvedValue({ id: "session-1" });
    const client = new MyClient();
    await client.connect();
    expect(connectMock).toHaveBeenCalledTimes(1);
  });
});
```

**Mocking rules:**

| Pattern | When to use |
|---------|-------------|
| `vi.hoisted(() => vi.fn())` | Define mock factories before `vi.mock()` blocks |
| `vi.mock("./module", async (orig) => ({ ...(await orig()), fn: mock }))` | Partially mock a module, keeping original exports |
| `vi.mock("./module", () => ({ fn: mock }))` | Fully replace a module |
| `vi.spyOn(console, "log").mockImplementation(() => {})` | Silence console output during tests |
| `vi.clearAllMocks()` in `beforeEach` | Reset call counts between tests |

## Step 3: Write HTTP Integration Tests

Use `supertest` to test Express (or any Node.js HTTP) servers without starting a real port.

```typescript
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app.ts";

describe("API integration", () => {
  let app: ReturnType<typeof createApp>;
  let server: any;

  beforeAll(async () => {
    app = createApp();
    server = app.listen(0); // random port
  });

  afterAll(async () => {
    server.close();
  });

  it("GET /health returns 200", async () => {
    await request(app).get("/health").expect(200);
  });

  it("creates a resource and returns it", async () => {
    const res = await request(app)
      .post("/api/items")
      .send({ name: "Test" })
      .expect(201);

    expect(res.body.item.name).toBe("Test");
    expect(res.body.item.id).toBeTruthy();
  });

  it("returns 404 for missing resources", async () => {
    await request(app).get("/api/items/missing-id").expect(404);
  });
});
```

**HTTP assertion patterns:**

| Pattern | Example |
|---------|---------|
| Chain `.expect(status)` | `.expect(200)` |
| Chain `.expect(status, body)` | `.expect(200, { ok: true })` |
| Assert response body | `expect(res.body.id).toBeTruthy()` |
| Assert array length | `expect(res.body.items).toHaveLength(3)` |
| Assert absence | `expect(res.body.items).not.toContain(item)` |

## Step 4: Test with Databases and Shared State

For SQLite or other file-based databases, use isolated test databases and clean them up after tests.

```typescript
import path from "node:path";
import fs from "node:fs/promises";
import { ulid } from "ulid"; // or any unique ID generator

export async function createTestContext() {
  const dbPath = path.join("db", "test", `test-${ulid()}.sqlite`);
  const db = await initDatabase(dbPath);

  return {
    db,
    async close() {
      await db.close();
      await fs.rm(dbPath, { force: true });
      await fs.rm(`${dbPath}-shm`, { force: true });
      await fs.rm(`${dbPath}-wal`, { force: true });
    },
  };
}
```

**For shared-state tests** (single server + DB across all tests in a file):

```typescript
describe("persistence", () => {
  let ctx: Awaited<ReturnType<typeof createTestContext>>;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  // tests use shared ctx
});
```

**For fresh-state per test** (if tests are fast and independent):

```typescript
beforeEach(async () => {
  await ctx.db.exec("DELETE FROM items");
});
```

**Important:** Set `fileParallelism: false` in `vitest.config.ts` when tests share mutable state (databases, file system, singletons).

## Step 5: Test SSE and Async Streams

Use `eventsource-client` or manual async iterators to test Server-Sent Events.

```typescript
import { createEventSource } from "eventsource-client";

async function collectEvents(url: string, count: number) {
  const client = createEventSource({ url });
  client.connect();

  const events: any[] = [];
  const consume = (async () => {
    for await (const event of client as AsyncIterable<{ data: string }>) {
      events.push(JSON.parse(event.data));
      if (events.length >= count) break;
    }
  })();

  return { events, close: () => client.close(), settle: () => consume };
}
```

Use a `waitFor` helper for polling conditions:

```typescript
export async function waitFor<T>(
  producer: () => T | undefined | Promise<T | undefined>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 3_000;
  const intervalMs = options.intervalMs ?? 20;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const value = await producer();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error("Timeout waiting for condition");
}
```

**SSE test pattern:**

```typescript
it("broadcasts updates to subscribers", async () => {
  const { events, close, settle } = await collectEvents(sseUrl, 2);

  // trigger an update
  await request(app).post("/api/update").send({ value: 42 }).expect(200);

  await waitFor(() => events.length >= 2 ? events : undefined);

  expect(events[1].type).toBe("UPDATE");
  expect(events[1].data.value).toBe(42);

  close();
  await settle();
});
```

## Step 6: Build Fake Implementations for Dependency Injection

Instead of mocking everything, create a fake implementation that implements the same interface as the real dependency. Inject it via factory functions.

```typescript
export class FakeService extends EventTarget {
  isConnected = false;
  readonly writeLog: string[] = [];

  async connect() {
    this.isConnected = true;
  }

  async disconnect() {
    this.isConnected = false;
    this.dispatchEvent(new Event("close"));
  }

  on(type: string, listener: (e: any) => void) {
    this.addEventListener(type, listener as EventListener);
    return () => this.removeEventListener(type, listener as EventListener);
  }
}
```

Inject via factory in your app initialization:

```typescript
const app = createApp({
  createService: () => new FakeService(),
});
```

## Step 7: Run Tests

| Command | Behavior |
|---------|----------|
| `vitest` | Watch mode (default) |
| `vitest run` | Run once and exit |
| `vitest --passWithNoTests` | Exit 0 even if no test files found |
| `vitest src/foo.test.ts` | Run a specific file |
| `vitest --reporter=verbose` | More detailed output |

## Validation Checklist

Before finishing a test addition:
- [ ] Tests run with `vitest run` and exit 0
- [ ] No `console.log` spam (mock or restore console)
- [ ] Mocks are cleared in `beforeEach`
- [ ] Shared resources (DB, server) are cleaned up in `afterAll`
- [ ] Test databases use unique names (e.g., `ulid()`)
- [ ] `fileParallelism: false` is set if tests share mutable state
- [ ] No unhandled promise rejections or open handles
