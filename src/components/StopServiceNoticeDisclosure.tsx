import { useMemo } from "react";
import type {
  ServiceNotice,
  ServiceNoticeBoard,
  TransitLine,
  TransitStop,
} from "../data/transit-types";
import { getOrderedNotices } from "../lib/service-notices";
import { ServiceNoticeList } from "./ServiceNoticePanel";

/**
 * What the operator published about *this* stop, kept beside the board it concerns.
 *
 * The count that used to sit in the bar was filtered to the stop and its lines, and opened the
 * network list — so *Meldungen 3* at Marktplatz promised three facts about Marktplatz and delivered
 * a page to search (F7). The three facts are here instead, where they were counted, disclosed from
 * the stop's own menu rather than stepping the rider away from the departures they change the
 * meaning of.
 *
 * It never speaks unless it has something to say. A stop with nothing announced shows nothing: the
 * calm reading belongs to the view that is about notices (E3), and asserting it here would put a
 * permanent "keine Meldungen" into every stop's menu. That silence is not a claim either — a rider
 * who wants the whole picture reaches it from the footer.
 */
export function StopServiceNoticeDisclosure({
  noticeBoard,
  notices,
  lines,
  feedNow,
  stop,
}: {
  noticeBoard: ServiceNoticeBoard | null;
  notices: readonly ServiceNotice[];
  lines: readonly TransitLine[];
  feedNow: number;
  stop: TransitStop;
}) {
  // The summary counts exactly the rows it reveals. Keeping the disclosure local avoids promising
  // a stop-specific answer and then sending the rider to the network-wide notice list.
  const ordered = useMemo(() => getOrderedNotices(notices, stop.id), [notices, stop.id]);
  if (noticeBoard?.dataStatus !== "live" || ordered.length === 0) return null;

  return (
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
  );
}
