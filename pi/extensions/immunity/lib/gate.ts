/**
 * Interactive-only gating (design §2): immunity targets interactive
 * sessions. In no-UI runs (print/json modes, `ctx.hasUI` false) it skips
 * its checks entirely — no prompting, no blocking. Deliberately no
 * headlessMode config (resolved decision); `hasUI` is the single switch.
 */
export function shouldEnforce(hasUI: boolean): boolean {
  return hasUI;
}
