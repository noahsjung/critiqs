// What Comment mode tells the reviewer while they pick an element. Keys only
// help someone with a keyboard: on a touch screen with no pointer that
// hovers (a phone, a tablet), the hint names a tap and no keys.

/** Whether this screen is touched rather than pointed at: no hover, a coarse pointer. */
export function touchScreen(scope: { matchMedia?: (query: string) => { matches: boolean } } = globalThis): boolean {
  try {
    return scope.matchMedia?.("(hover: none) and (pointer: coarse)").matches ?? false;
  } catch {
    return false;
  }
}

/** The picking hint: choosing a replacement element, or choosing what to comment on. */
export function pickingHint(reattaching: boolean, touch: boolean): string {
  if (reattaching) return touch ? "Tap the replacement element" : "Select the replacement element · Esc to cancel";
  return touch ? "Comment mode: tap an element to comment on it" : "Comment mode: select an element · V to leave";
}
