/** Which lines the network maps draw: those the timetable runs every day of the week. */
import { network } from "../networks/network";

/** Whether the timetable runs a line every day; a line it does not know counts as daily. */
export const runsEveryDay = (lineId: string): boolean => !network.nonDailyLineIds.has(lineId);
