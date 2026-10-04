/** Which lines the network maps draw: those the timetable runs every day of the week. */
import { kvvNonDailyLineIds } from "../data/generated/kvv-line-days";

/** Whether the timetable runs a line every day; a line it does not know counts as daily. */
export const runsEveryDay = (lineId: string): boolean => !kvvNonDailyLineIds.has(lineId);
