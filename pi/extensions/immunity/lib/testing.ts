/**
 * Test harness (design §1 testability): shared fakes for tests.
 * Test-only module — not matched by the `lib/*.test.ts` glob and never
 * imported by extension code.
 */

/** Scripted UI fake: `selects`/`inputs` are consumed in order; undefined = dismissed. */
export class FakeUi {
  selectCalls: { title: string; options: string[] }[] = [];
  inputCalls: { title: string; placeholder?: string }[] = [];
  notifyCalls: { message: string; type?: string }[] = [];
  private selects: (string | undefined)[];
  private inputs: (string | undefined)[];
  private fail: "select" | "input" | null = null;
  constructor(selects: (string | undefined)[] = [], inputs: (string | undefined)[] = []) {
    this.selects = selects;
    this.inputs = inputs;
  }
  failNext(kind: "select" | "input"): void {
    this.fail = kind;
  }
  async select(title: string, options: string[]): Promise<string | undefined> {
    this.selectCalls.push({ title, options });
    if (this.fail === "select") throw new Error("ui failed");
    return this.selects.shift();
  }
  async input(title: string, placeholder?: string): Promise<string | undefined> {
    this.inputCalls.push({ title, placeholder });
    if (this.fail === "input") throw new Error("ui failed");
    return this.inputs.shift();
  }
  notify(message: string, type?: string): void {
    this.notifyCalls.push({ message, type });
  }
}

/** Bus fake: captures every emitted event. */
export class FakeBus {
  events: { channel: string; data: unknown }[] = [];
  emit(channel: string, data: unknown): void {
    this.events.push({ channel, data });
  }
}
