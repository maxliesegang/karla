import { useMemo } from "react";
import type {
  ServiceNotice,
  ServiceNoticeBoard,
  TransitLine,
  TransitStop,
} from "../data/transit-types";
import { getOrderedNotices } from "../lib/service-notices";
import { ServiceNoticeList } from "./ServiceNoticeList";

/**
 * What KVV announced about this stop, at the foot of its departure board.
 *
 * The notices filtered to the stop and its lines are disclosed here, beside the departures they
 * change the meaning of, rather than on a network-wide page the rider would have to search. Open,
 * the list spreads across the menu's whole width — a phone's half column was too narrow for the
 * operator's own wording.
 *
 * It belongs to the board rather than to the view: it answers for the list above it, so it travels
 * with it and stays beneath its scrollport.
 *
 * It never speaks unless it has something to say. A stop with nothing announced shows nothing: the
 * calm reading belongs to the view that is about notices, and asserting it here would put a
 * permanent "keine Meldungen" into every stop's menu. That silence is not a claim either — a rider
 * who wants the whole picture reaches it from the footer.
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
  // The summary counts exactly the rows it reveals. Keeping the disclosure local avoids promising
  // a stop-specific answer and then sending the rider to the network-wide notice list.
  const ordered = useMemo(() => getOrderedNotices(notices, stop.id), [notices, stop.id]);
  const isShowingNotices = noticeBoard?.dataStatus === "live" && ordered.length > 0;

  return (
    <div className="stop-bottom-menu" role="group" aria-label={`Meldungen zu ${stop.name}`}>
      {isShowingNotices && (
        <details className="stop-service-notices">
          <summary
            aria-label={`${ordered.length} ${ordered.length === 1 ? "Meldung" : "Meldungen"} des KVV zu ${stop.name}`}
          >
            <span>KVV-Meldungen · {ordered.length}</span>
            <svg
              className="disclosure-chevron"
              viewBox="0 0 16 16"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M4 6l4 4 4-4" />
            </svg>
          </summary>
          <div className="stop-service-notices-content">
            <ServiceNoticeList notices={ordered} lines={lines} feedNow={feedNow} />
          </div>
        </details>
      )}
    </div>
  );
}
