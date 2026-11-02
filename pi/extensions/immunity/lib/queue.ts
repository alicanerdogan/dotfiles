/**
 * Approval-flow queue.
 *
 * pi can have several tool calls in flight at once; if each opened its own
 * dialog the prompts would overlap and compete for the same UI. Complete
 * approval flows therefore run one at a time: from opening the first dialog
 * through the suggestion step and rule writes, to the final audit entry.
 *
 * A queued flow knows it waited (`waited: true`), so the handler can recheck
 * the request against rules or session statements granted by the flow ahead
 * of it before opening a stale dialog.
 *
 * Aborted queued flows never start. Their queue slot is still released after
 * the flow ahead of them finishes, so ordering and cleanup survive
 * cancellation. Flows that throw release their slot too.
 */
export interface QueuedFlow<T> {
  /** false = the flow was aborted while queued and never ran */
  started: boolean;
  result?: T;
}

export class ApprovalQueue {
  private tail: Promise<void> = Promise.resolve();
  /** flows holding or waiting for a slot (aborted flows keep their place until the flow ahead finishes) */
  private pending = 0;

  /** Flows currently holding or waiting for a slot. */
  get pendingCount(): number {
    return this.pending;
  }

  async run<T>(flow: (waited: boolean) => Promise<T>, signal?: AbortSignal): Promise<QueuedFlow<T>> {
    if (signal?.aborted) return { started: false };

    const previous = this.tail;
    const waited = this.pending > 0;
    this.pending++;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      release();
      this.pending--;
    };

    let acquired = false;
    try {
      acquired = await settleOrAbort(previous, signal);
      if (!acquired) {
        // Do not jump the flow we were waiting behind; release our slot only
        // after it finishes.
        previous.then(releaseOnce, releaseOnce);
        return { started: false };
      }
      if (signal?.aborted) return { started: false };
      return { started: true, result: await flow(waited) };
    } finally {
      if (acquired) releaseOnce();
    }
  }
}

/** Resolve true when `p` settles, false when the signal aborts first. */
function settleOrAbort(p: Promise<void>, signal?: AbortSignal): Promise<boolean> {
  if (!signal) return p.then(() => true);
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      cleanup();
      resolve(false);
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      () => {
        cleanup();
        resolve(true);
      },
      () => {
        cleanup();
        resolve(true);
      },
    );
  });
}
