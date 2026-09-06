import { useMemo } from "react";
import type { ServiceNotice, ServiceNoticeBoard, TransitLine } from "../data/transit-types";
import { getOrderedNotices } from "../lib/service-notices";
import { ServiceNoticeList } from "./ServiceNoticeList";

/**
 * What KVV has announced about the lines in view.
 *
 * This is the other half of the operating picture, and it is deliberately a separate panel from the
 * deviations read off the boards: a departure board answers what is happening to one trip in the
 * next half hour, and a notice answers what the operator has published about the days ahead. Read
 * together they are the whole answer; merged they would be a claim neither of them makes — a
 * six-week closure is not a delay, and a calm board is not evidence that nothing was announced.
 *
 * Nothing here is written by this app. The title is the operator's own, the period is the one it
 * published, and the full wording — carried in the same reading as the headline — is the operator's
 * text unshortened, opened in place. It is not sent out to the operator's own page: that page is
 * closed to the public and answers a reader 403, so a link to it would be a promise this app cannot
 * keep.
 */

export function ServiceNoticePanel({
  noticeBoard,
  notices,
  lines,
  feedNow,
  emptyLabel,
  concernedStopId,
}: {
  /** The reading itself, which is what says whether "keine Meldungen" may be stated at all. */
  noticeBoard: ServiceNoticeBoard | null;
  /** The notices that concern what is in view, already selected by the caller. */
  notices: readonly ServiceNotice[];
  /** The lines the feed is running, so a named line is drawn with the sign it actually carries. */
  lines: readonly TransitLine[];
  feedNow: number;
  /**
   * How to say there are none — and, by passing it at all, that this view is *about* the notices.
   *
   * The dedicated notice view states its own lifecycle: it says when the notices are still loading,
   * when they could not be read, and when there are none. Passing nothing says the opposite: this is
   * a block beside something else, so it renders only when it has a fact, and a feed that is loading
   * or unreadable is silent rather than a status line stacked under a working board.
   */
  emptyLabel?: string;
  /** Where the reader is standing: a notice naming their own stop outranks one about a line. */
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

  // A feed that could not be read has not said there is nothing. Saying so for it would be the one
  // thing this panel must never do.
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
