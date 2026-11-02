/**
 * Session-wide analyzer limiter.
 *
 * `llm.maxParallel` caps how many analyzer subprocesses may run at once.
 * The cap is per session, not per sibling batch: sibling preflights, nested
 * tool calls and manual retries all schedule through the same limiter, so
 * concurrent handlers cannot exceed it together.
 *
 * Queued work is cancellable: a job whose signal aborts before it starts is
 * dropped without ever calling the analyzer. Slots are always released —
 * including when the analyzer throws or rejects.
 */
import type { VerdictResult } from "./llm-client.ts";

/** Result used when queued work is aborted before it can start. */
export function abortedVerdict(): VerdictResult {
  return { ok: false, kind: "timeout", error: "analysis aborted" };
}

interface Job {
  request: () => Promise<VerdictResult>;
  signal?: AbortSignal;
  resolve: (result: VerdictResult) => void;
  started: boolean;
  onAbort?: () => void;
}

export class AnalysisLimiter {
  private max: number;
  private active = 0;
  private queue: Job[] = [];

  constructor(maxParallel: number) {
    this.max = Math.max(1, Math.trunc(maxParallel));
  }

  /** In-flight analyzer calls. */
  get running(): number {
    return this.active;
  }

  /** Calls waiting for a slot. */
  get queued(): number {
    return this.queue.length;
  }

  setMaxParallel(maxParallel: number): void {
    this.max = Math.max(1, Math.trunc(maxParallel));
    this.pump();
  }

  schedule(request: () => Promise<VerdictResult>, signal?: AbortSignal): Promise<VerdictResult> {
    if (signal?.aborted) return Promise.resolve(abortedVerdict());
    return new Promise<VerdictResult>((resolve) => {
      const job: Job = { request, signal, resolve, started: false };
      if (signal) {
        job.onAbort = () => this.cancel(job);
        signal.addEventListener("abort", job.onAbort, { once: true });
      }
      this.queue.push(job);
      this.pump();
    });
  }

  private cancel(job: Job): void {
    if (job.started) return; // running work observes the signal itself
    const index = this.queue.indexOf(job);
    if (index === -1) return;
    this.queue.splice(index, 1);
    this.finish(job, abortedVerdict());
  }

  private pump(): void {
    while (this.active < this.max && this.queue.length > 0) {
      const job = this.queue.shift()!;
      if (job.signal?.aborted) {
        this.finish(job, abortedVerdict());
        continue;
      }
      job.started = true;
      this.active++;
      let result: Promise<VerdictResult>;
      try {
        result = job.request();
      } catch (err) {
        result = Promise.resolve({ ok: false, kind: "spawn", error: String(err) });
      }
      result.then(
        (verdict) => this.complete(job, verdict),
        (err) => this.complete(job, { ok: false, kind: "spawn", error: String(err) }),
      );
    }
  }

  /** Release the slot as soon as the request settles, then hand it to the next job. */
  private complete(job: Job, result: VerdictResult): void {
    this.active--;
    this.finish(job, result);
    this.pump();
  }

  private finish(job: Job, result: VerdictResult): void {
    if (job.signal && job.onAbort) job.signal.removeEventListener("abort", job.onAbort);
    job.resolve(result);
  }
}
