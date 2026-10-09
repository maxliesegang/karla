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
 * KVV's notices for this stop and its lines, at the foot of its board and travelling with it. Shows
 * nothing when nothing is announced; the notices page is the place for "keine Meldungen".
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
  // The summary counts exactly the rows it reveals.
  const ordered = useMemo(() => getOrderedNotices(notices, stop.id), [notices, stop.id]);
  const isShowingNotices = noticeBoard?.dataStatus === "live" && ordered.length > 0;

  return (
    <div className="stop-bottom-menu" role="group" aria-label={`Meldungen zu ${stop.name}`}>
      {isShowingNotices && (
        <details className="stop-service-notices">
          <summary
            aria-label={`${ordered.length} ${ordered.length === 1 ? "Meldung" : "Meldungen"} des KVV zu ${stop.name}`}
          >
            <span>Meldungen · {ordered.length}</span>
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
