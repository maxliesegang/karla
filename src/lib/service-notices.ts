import type { ServiceNotice, TransitLine } from "../data/transit-types";
import { getLineFamilyId } from "./line-families";

/**
 * Which notices concern what is in view. The operator publishes for the whole KVV area, so a notice
 * shows only where it names a running line or a stop the app can open. Shown verbatim.
 */

/** Notices state dates; their clock times rarely matter. */
const noticeDateFormat = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  day: "2-digit",
  month: "2-digit",
});

/**
 * Same line, ignoring case (`104S` vs `104s`) after the padding is stripped; S1 never matches S11.
 */
const isSameNoticeLine = (noticeLineId: string, lineId: string): boolean =>
  getLineFamilyId(noticeLineId.toUpperCase()) === getLineFamilyId(lineId.toUpperCase());

const namesLine = (notice: ServiceNotice, lineIds: readonly string[]): boolean =>
  notice.lineIds.some((noticeLineId) =>
    lineIds.some((lineId) => isSameNoticeLine(noticeLineId, lineId)),
  );

/** Notices naming this stop or a line calling there. */
export function findNoticesForStop(
  notices: readonly ServiceNotice[],
  stopId: string,
  lineIds: readonly string[],
): ServiceNotice[] {
  return notices.filter((notice) => notice.stopIds.includes(stopId) || namesLine(notice, lineIds));
}

/**
 * Notices naming a running line or an openable stop; the rest are about places the app does not
 * cover.
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
 * When the notice applies: its end once started, its start before; nothing where neither is stated.
 */
export function getNoticePeriodLabel(notice: ServiceNotice, now: number): string | undefined {
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
 * Display order: operator priority, then (in a stop view) notices naming the stop, then soonest
 * ending.
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
