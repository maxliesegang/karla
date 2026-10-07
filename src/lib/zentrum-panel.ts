import { createStoredPreference } from "./stored-preference";

/** Whether an opened stop shows its whole panel or only a bar under the plan. */
export type ZentrumStopPanelState = "collapsed" | "expanded";

/** How a panel enters beside the plan or above its stop bar. */
export type ZentrumPanelEntranceMotion = "rise" | "slide";

/** The rider's last choice, kept between visits; unset keeps the list collapsed. */
export const zentrumStopPanelState = createStoredPreference<ZentrumStopPanelState | undefined>({
  key: "karla:zentrum-stop-sheet",
  // Unreadable means unset.
  parse: (stored) => (stored === "expanded" || stored === "collapsed" ? stored : undefined),
  serialize: (state) => state ?? "",
});
