import { useMemo } from "react";
import type { ServiceNotice, ServiceNoticeBoard, TransitLine } from "../data/transit-types";
import { getOrderedNotices } from "../lib/service-notices";
import { ServiceNoticeList } from "./ServiceNoticeList";

/**
 * KVV's notices for the lines in view, kept apart from board deviations: a six-week closure is not
 * a delay, and a calm board is not proof nothing was announced. Verbatim title, period and full
 * text, opened in place; the operator's page answers 403, so there is no link out.
 */

export function ServiceNoticePanel({
  noticeBoard,
  notices,
  lines,
  feedNow,
  emptyLabel,
  concernedStopId,
}: {
  /** The reading, which decides whether "keine Meldungen" may be said. */
  noticeBoard: ServiceNoticeBoard | null;
  /** The notices for what is in view, selected by the caller. */
  notices: readonly ServiceNotice[];
  /** The running lines, for each named line's sign. */
  lines: readonly TransitLine[];
  feedNow: number;
  /**
   * How to say there are none. Passing it makes this the notices view, which states loading,
   * failure and emptiness; without it the panel renders only notices and is otherwise silent.
   */
  emptyLabel?: string;
  /** The reader's stop: notices naming it come first. */
  concernedStopId?: string;
}) {
  const ordered = useMemo(
    () => getOrderedNotices(notices, concernedStopId),
    [notices, concernedStopId],
  );

  if (noticeBoard === null) {
    if (!emptyLabel) return null;
    return (
      <p className="notice notice-watch" role="status">
        Meldungen werden geladen …
      </p>
    );
  }

  // An unreadable feed has not said there is nothing.
  if (noticeBoard.dataStatus === "unavailable") {
    if (!emptyLabel) return null;
    return (
      <p className="notice notice-watch" role="status">
        Meldungen derzeit nicht abrufbar
      </p>
    );
  }

  if (ordered.length === 0) {
    if (!emptyLabel) return null;
    return (
      <p className="notice notice-calm">
        <span className="notice-icon" aria-hidden="true">
          ✓
        </span>
        {emptyLabel}
      </p>
    );
  }

  return <ServiceNoticeList notices={ordered} lines={lines} feedNow={feedNow} />;
}
