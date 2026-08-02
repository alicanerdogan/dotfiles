/**
 * Bus events (design §5) — typed helpers over pi's EventBus shape
 * (`emit(channel, data)`, `on(channel, handler)`). Pure module: the bus
 * instance is injected by index.ts (pi.events).
 *
 * Channels (design §5):
 *   immunity:action:blocked   { feature, action, reason, block: { source, userReason? }, context }
 *   immunity:prompt:opened    { prompt: { id, feature, reason } }  — correlated by prompt.id
 *   immunity:prompt:closed    { prompt: { id, feature, reason } }  — emitted in `finally`
 *   immunity:grant:created    { feature, action, grant: { scope, persisted? } }
 */
import { randomUUID } from "node:crypto";
import type { BlockSource } from "./audit.ts";

export const BUS = {
  blocked: "immunity:action:blocked",
  promptOpened: "immunity:prompt:opened",
  promptClosed: "immunity:prompt:closed",
  grantCreated: "immunity:grant:created",
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

export interface GrantEvent {
  feature: "bash" | "file";
  action: string;
  grant: { scope: "session" | "always"; persisted?: boolean };
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

export function emitGrantCreated(bus: Bus, e: GrantEvent): void {
  bus.emit(BUS.grantCreated, e);
}
