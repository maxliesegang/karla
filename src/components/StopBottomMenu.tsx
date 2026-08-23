import type {
  ServiceNotice,
  ServiceNoticeBoard,
  TransitLine,
  TransitStop,
} from "../data/transit-types";
import { StopServiceNoticeDisclosure } from "./ServiceNoticePanel";

/**
 * What KVV announced about this stop, at the foot of its departure board.
 *
 * It is the same disclosure that used to close the board on its own, and silent as ever when there
 * is nothing announced. Open, its list spreads across the menu's whole width — a phone's half column
 * was too narrow for the operator's own wording.
 *
 * It had a second half once: a Linien control that scrolled to the connections panel on the stop
 * view and navigated back to the stop from a line. Two full-width controls pinned to a phone's foot
 * read as a tab bar, which is what neither of them was — and the lines are one of the board's own
 * three orders now, so there is nothing left to scroll to. What remains belongs to the board rather
 * than to the view: it answers for the list above it, so it travels with it and stays beneath its
 * scrollport.
 */
export function StopBottomMenu({
  stop,
  noticeBoard,
  notices,
  lines,
  feedNow,
}: {
  stop: TransitStop;
  noticeBoard: ServiceNoticeBoard | null;
  notices: readonly ServiceNotice[];
  lines: readonly TransitLine[];
  feedNow: number;
}) {
  return (
    <div className="stop-bottom-menu" role="group" aria-label={`Meldungen zu ${stop.name}`}>
      <StopServiceNoticeDisclosure
        noticeBoard={noticeBoard}
        notices={notices}
        lines={lines}
        feedNow={feedNow}
        stop={stop}
      />
    </div>
  );
}
