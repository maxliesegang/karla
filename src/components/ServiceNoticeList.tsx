import { useMemo } from "react";
import type { ServiceNotice, TransitLine } from "../data/transit-types";
import { getNoticePeriodLabel } from "../lib/service-notices";
import { compareLineIds, isSameLineFamily } from "../lib/line-families";
import { LineBadge } from "./LineBadge";

/** Notice rows, shared by two views: verbatim title, period and full text, opened in place. */

/** Badges per row before the rest are counted. */
const VISIBLE_NOTICE_LINE_BADGE_LIMIT = 6;

export function ServiceNoticeList({
  notices,
  lines,
  feedNow,
}: {
  /** Already ordered by the owning view. */
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
  // Only running lines get badges; notices name lines that never come near Karlsruhe.
  const runningLines = useMemo(
    () =>
      notice.lineIds
        .flatMap((lineId) => lines.filter((line) => isSameLineFamily(line.id, lineId)))
        .filter((line, index, all) => all.findIndex((other) => other.id === line.id) === index)
        .sort((a, b) => compareLineIds(a.id, b.id)),
    [notice.lineIds, lines],
  );
  const visibleLines = runningLines.slice(0, VISIBLE_NOTICE_LINE_BADGE_LIMIT);
  const hiddenLineCount = runningLines.length - visibleLines.length;
  const periodLabel = getNoticePeriodLabel(notice, feedNow);
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

  // Rows with full text expand in place; headline-only notices do not.
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
          // Paragraphs have no ids; the text identifies them.
          <p key={`${index}-${paragraph}`}>{paragraph}</p>
        ))}
      </div>
    </details>
  );
}
