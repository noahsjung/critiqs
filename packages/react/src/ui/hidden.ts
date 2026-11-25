import { createContext, useContext } from "react";

/**
 * Whether Critiqs is hidden (Ctrl or Cmd + \). Hidden, it stays mounted so
 * drafts and open windows survive, but listens to nothing on the host page:
 * no picking, no outside clicks or Escape handled, no focus taken, and
 * nothing marked read.
 */
export const HiddenContext = createContext(false);

export const useHidden = () => useContext(HiddenContext);
