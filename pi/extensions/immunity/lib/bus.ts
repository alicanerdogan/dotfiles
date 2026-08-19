/**
 * Bus events (design §5) — typed helpers over pi's EventBus shape
 * (`emit(channel, data)`, `on(channel, handler)`). Pure module: the bus
 * instance is injected by index.ts (pi.events).
 *
 * Channels:
 *   immunity:action:blocked   { feature, action, reason, block: { source, userReason? }, context }
 *   immunity:prompt:opened    { prompt: { id, feature, reason } }  — correlated by prompt.id
 *   immunity:prompt:closed    { prompt: { id, feature, reason } }  — emitted in `finally`
 *   immunity:action:decided   { feature, action, decision: { kind, scope, persisted? } }
 */
import { randomUUID } from "node:crypto";
import type { BlockSource } from "./audit.ts";

export const BUS = {
  blocked: "immunity:action:blocked",
  promptOpened: "immunity:prompt:opened",
  promptClosed: "immunity:prompt:closed",
  decided: "immunity:action:decided",
} as const;

export type Bus = { emit(channel: string, data: unknown): void };

export interface BlockedEvent {
  feature: "bash" | "file";
  action: string;
  reason: string;
  block: { source: BlockSource; userReason?: string };
  context: { sessionId: string };
}

export interface PromptEvent {
  prompt: { id: string; feature: "bash" | "file"; reason: string };
}

export interface DecidedEvent {
  feature: "bash" | "file";
  action: string;
  decision: {
    kind: "allow" | "block";
    /** menu scope the choice came from; session statements never persist; "call" = one-shot command decision */
    scope: "session" | "project" | "global" | "call";
    persisted?: boolean;
  };
}

export function newPromptId(): string {
  return randomUUID();
}

export function emitBlocked(bus: Bus, e: BlockedEvent): void {
  bus.emit(BUS.blocked, e);
}

export function emitPromptOpened(bus: Bus, e: PromptEvent): void {
  bus.emit(BUS.promptOpened, e);
}

export function emitPromptClosed(bus: Bus, e: PromptEvent): void {
  bus.emit(BUS.promptClosed, e);
}

export function emitDecided(bus: Bus, e: DecidedEvent): void {
  bus.emit(BUS.decided, e);
}
