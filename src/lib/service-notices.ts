import type { ServiceNotice, TransitLine } from "../data/transit-types";
import { getLineFamilyId } from "./line-families";

/**
 * Which published notices concern what a rider is looking at.
 *
 * The operator publishes for the whole KVV area — Bruchsal, Baden-Baden, the Palatinate — and a
 * reader standing on the Kaiserstraße has no use for a bus diversion in Rastatt. A notice is
 * therefore shown only where it names something in view: a line the live feed is currently running,
 * or a stop the app can open. Nothing is ranked or summarised here; the operator's own title is
 * what a rider reads, and the operator's page is where the full wording stays.
 *
 * A notice is never evidence about the next few minutes, and a quiet board is never evidence that
 * no notice exists.
 */

/** Dates are what a notice states; the clock times it carries are rarely the point. */
const noticeDateFormat = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  day: "2-digit",
  month: "2-digit",
});

/**
 * A line number as published and one as a departure states it are the same line.
 *
 * The padding is already off (`normalizeNoticeLineNumber`), so what is left is case — an operator
 * writing `104S` for the line a board calls `104s`. S1 and S11 deliberately remain distinct: a
 * notice naming one is not silently broadened to the other.
 */
const isSameNoticeLine = (noticeLineId: string, lineId: string): boolean =>
  getLineFamilyId(noticeLineId.toUpperCase()) === getLineFamilyId(lineId.toUpperCase());

const namesLine = (notice: ServiceNotice, lineIds: readonly string[]): boolean =>
  notice.lineIds.some((noticeLineId) =>
    lineIds.some((lineId) => isSameNoticeLine(noticeLineId, lineId)),
  );

/**
 * The notices a rider standing at one stop has to know about: the ones naming the stop itself, and
 * the ones naming a line that calls there. A stop closure states the stop; a replacement service
 * states the line — both are answers to "can I travel from here".
 */
export function findNoticesForStop(
  notices: readonly ServiceNotice[],
  stopId: string,
  lineIds: readonly string[],
): ServiceNotice[] {
  return notices.filter((notice) => notice.stopIds.includes(stopId) || namesLine(notice, lineIds));
}

/**
 * The notices worth showing in a view of the whole network: those naming a line the feed is
 * currently running, or a stop the app can open. Everything else is about somewhere this app does
 * not describe, and listing it would bury the notices that do apply.
 */
export function findNoticesInNetwork(
  notices: readonly ServiceNotice[],
  lines: readonly TransitLine[],
  stopIds: readonly string[],
): ServiceNotice[] {
  const lineIds = lines.map((line) => line.id);
  const knownStopIds = new Set(stopIds);
  return notices.filter(
    (notice) =>
      namesLine(notice, lineIds) || notice.stopIds.some((stopId) => knownStopIds.has(stopId)),
  );
}

/**
 * When the operator says the notice applies, in its own terms.
 *
 * Only the part a reader can act on is worded: a notice that started weeks ago says when it ends, a
 * notice that has not started yet says when it starts, and one that states neither says nothing
 * rather than implying a period nobody published.
 */
export function findNoticePeriodLabel(notice: ServiceNotice, now: number): string | undefined {
  const from = notice.validFrom ? Date.parse(notice.validFrom) : Number.NaN;
  const until = notice.validUntil ? Date.parse(notice.validUntil) : Number.NaN;
  const hasStarted = Number.isFinite(from) && from <= now;

  if (Number.isFinite(from) && !hasStarted) {
    return Number.isFinite(until)
      ? `${noticeDateFormat.format(from)} – ${noticeDateFormat.format(until)}`
      : `ab ${noticeDateFormat.format(from)}`;
  }
  return Number.isFinite(until) ? `bis ${noticeDateFormat.format(until)}` : undefined;
}

/**
 * The notices to show first: the operator's own priority, then — where the view is about one stop —
 * the ones naming that stop, then the ones ending soonest.
 *
 * The stop matters because a view may have room for exactly one row: standing at a stop whose own
 * name is in a closure notice, that is the notice, and a replacement service on one of eight lines
 * calling there is not.
 */
export function getOrderedNotices(
  notices: readonly ServiceNotice[],
  concernedStopId?: string,
): ServiceNotice[] {
  const rank = (notice: ServiceNotice) => [
    notice.priority === "high" ? 0 : 1,
    concernedStopId && notice.stopIds.includes(concernedStopId) ? 0 : 1,
  ];
  return [...notices].sort((a, b) => {
    const [priorityA, stopA] = rank(a);
    const [priorityB, stopB] = rank(b);
    return (
      priorityA - priorityB ||
      stopA - stopB ||
      (Date.parse(a.validUntil ?? "") || Number.POSITIVE_INFINITY) -
        (Date.parse(b.validUntil ?? "") || Number.POSITIVE_INFINITY) ||
      a.title.localeCompare(b.title, "de")
    );
  });
}
