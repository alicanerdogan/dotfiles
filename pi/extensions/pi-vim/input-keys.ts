import { matchesKey } from "@earendil-works/pi-tui";
import { getLineGraphemes } from "./motions.js";

// Keyboard-input classification predicates. Pure functions over the raw
// input chunk a terminal delivers to the editor — no editor state. Shared
// by the EX mini-mode, insert, and normal-mode dispatch paths.

export function isEscapeLikeInput(data: string): boolean {
  return matchesKey(data, "escape") || matchesKey(data, "ctrl+[");
}

export function isEnterLikeInput(data: string): boolean {
  return (
    data === "\r" ||
    data === "\n" ||
    matchesKey(data, "enter") ||
    matchesKey(data, "return")
  );
}

export function isBackspaceLikeInput(data: string): boolean {
  return (
    data === "\x7f" ||
    data === "\x08" ||
    matchesKey(data, "backspace") ||
    matchesKey(data, "ctrl+h")
  );
}

export function isPrintableChunk(data: string): boolean {
  if (data.length === 0) return false;
  for (const char of data) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || codePoint < 32 || codePoint === 127)
      return false;
  }
  return true;
}

export function isPrintableInput(data: string): boolean {
  return isPrintableChunk(data) && getLineGraphemes(data).length === 1;
}

export function isDigit(data: string): boolean {
  return data.length === 1 && data >= "0" && data <= "9";
}

export function isCountStarter(data: string): boolean {
  return data.length === 1 && data >= "1" && data <= "9";
}
