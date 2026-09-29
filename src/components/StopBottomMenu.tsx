import type {
  ServiceNotice,
  ServiceNoticeBoard,
  TransitLine,
  TransitStop,
} from "../data/transit-types";
import { StopServiceNoticeDisclosure } from "./StopServiceNoticeDisclosure";

/**
 * What KVV announced about this stop, at the foot of its departure board.
 *
 * It is silent when there is nothing announced. Open, its list spreads across the menu's whole width — a phone's half column
 * was too narrow for the operator's own wording.
 *
 * It belongs to the board rather than to the view: it answers for the list above it, so it travels with it and stays beneath its
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
