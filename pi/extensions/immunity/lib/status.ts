/**
 * Reference-counted status line.
 *
 * Concurrent tool-call handlers each show the analysis indicator. The first
 * handler to begin owns the visible label; the last one to finish clears it.
 * A handler that finishes early therefore cannot hide the indicator while a
 * sibling is still analyzing.
 */
export class StatusCounter {
  private active = 0;
  private readonly write: (label: string | null) => void;

  constructor(write: (label: string | null) => void) {
    this.write = write;
  }

  /** Number of handlers currently holding the indicator. */
  get count(): number {
    return this.active;
  }

  begin(label: string): void {
    this.active++;
    if (this.active === 1) this.write(label);
  }

  end(): void {
    if (this.active === 0) return;
    this.active--;
    if (this.active === 0) this.write(null);
  }

  /** HandlerEnv adapter: a label begins, null ends. */
  set(label: string | null): void {
    if (label === null) this.end();
    else this.begin(label);
  }

  /** Clear the indicator and forget any held references (session shutdown). */
  reset(): void {
    this.active = 0;
    this.write(null);
  }
}
