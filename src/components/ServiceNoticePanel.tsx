import { useMemo } from "react";
import type { ServiceNotice, ServiceNoticeBoard, TransitLine } from "../data/transit-types";
import { findNoticePeriodLabel, getOrderedNotices } from "../lib/service-notices";
import { compareLineIds, isSameLineFamily } from "../lib/line-families";
import { LineBadge } from "./LineBadge";

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

/** More badges than this and the row stops being scannable; the rest are counted. */
const VISIBLE_LINE_BADGE_LIMIT = 6;

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

export function ServiceNoticeList({
  notices,
  lines,
  feedNow,
}: {
  /** Already ordered for the view that owns the list. */
  notices: readonly ServiceNotice[];
  lines: readonly TransitLine[];
  feedNow: number;
}) {
  return (
    <div className="service-notices">
      {notices.map((notice) => (
        <ServiceNoticeRow key={notice.id} notice={notice} lines={lines} feedNow={feedNow} />
      ))}
    </div>
  );
}

function ServiceNoticeRow({
  notice,
  lines,
  feedNow,
}: {
  notice: ServiceNotice;
  lines: readonly TransitLine[];
  feedNow: number;
}) {
  // Only the lines that are actually running are drawn: a notice names every line its author
  // selected, including ones that never come near Karlsruhe, and a badge for a line the reader
  // cannot board here is noise in the row that matters.
  const runningLines = useMemo(
    () =>
      notice.lineIds
        .flatMap((lineId) => lines.filter((line) => isSameLineFamily(line.id, lineId)))
        .filter((line, index, all) => all.findIndex((other) => other.id === line.id) === index)
        .sort((a, b) => compareLineIds(a.id, b.id)),
    [notice.lineIds, lines],
  );
  const visibleLines = runningLines.slice(0, VISIBLE_LINE_BADGE_LIMIT);
  const hiddenLineCount = runningLines.length - visibleLines.length;
  const periodLabel = findNoticePeriodLabel(notice, feedNow);
  const stopLabel =
    notice.stopNames.length > 0 ? notice.stopNames.slice(0, 2).join(" · ") : undefined;

  const spokenLines =
    runningLines.length > 0 ? `betrifft ${runningLines.map((line) => line.id).join(", ")}` : "";
  const label = [
    "Meldung des KVV",
    notice.title,
    spokenLines,
    periodLabel && `gültig ${periodLabel}`,
  ]
    .filter(Boolean)
    .join(", ");

  const content = (
    <>
      <span className="notice-icon" aria-hidden="true">
        i
      </span>
      <span className="notice-text">
        <strong>{notice.title}</strong>
        <small>
          {periodLabel}
          {periodLabel && stopLabel ? " · " : ""}
          {stopLabel}
        </small>
      </span>
      {visibleLines.length > 0 && (
        <span className="service-notice-lines" aria-hidden="true">
          {visibleLines.map((line) => (
            <LineBadge key={line.id} line={line} size="xs" />
          ))}
          {hiddenLineCount > 0 && <small>+{hiddenLineCount}</small>}
        </span>
      )}
    </>
  );

  // The wording the operator published is already in hand, so the row opens it rather than sending
  // the reader anywhere. A notice published as a headline alone is simply not expandable, and reads
  // as what it is: the text is the whole of it, so it needs no control of its own.
  const className = `notice notice-${notice.priority === "high" ? "alert" : "info"}`;
  if (notice.details.length === 0) {
    return <p className={className}>{content}</p>;
  }

  return (
    <details className={`${className} service-notice-detail`}>
      <summary aria-label={`${label}. Volltext anzeigen`}>
        {content}
        <svg
          className="disclosure-chevron"
          viewBox="0 0 16 16"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </summary>
      <div className="service-notice-detail-text">
        {notice.details.map((paragraph, index) => (
          // The operator's paragraphs have no ids of their own, and the text is what identifies them.
          <p key={`${index}-${paragraph}`}>{paragraph}</p>
        ))}
      </div>
    </details>
  );
}
