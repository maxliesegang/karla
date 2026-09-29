import { createStoredPreference } from "./stored-preference";

/**
 * The three complete readings of one departure board.
 *
 * Each is the whole board — nothing is hidden and nothing is re-sorted, the rows are only gathered
 * differently — so a rider moving between them is reading the same list a second and third way
 * rather than moving to another view. `time` is what leaves next, `platform` is what leaves from
 * where they are standing, `line` is where each line goes from here.
 */
export type DepartureBoardOrder = "time" | "platform" | "line";

const DEPARTURE_BOARD_ORDERS: readonly DepartureBoardOrder[] = ["time", "platform", "line"];

/**
 * Which of the three orders this rider reads a board in, kept between visits.
 *
 * Grouping is not a passing glance at one board: reading by platform is how somebody who uses a stop
 * with six platforms reads every board, reading by line is how somebody who knows which line they
 * want reads every board, and it is the same rider every day. Re-asking them for it on each visit
 * would make the useful order the one they never see. Time order stays the default, because it is
 * the one a rider who has expressed no preference is asking for.
 */
export const departureBoardOrder = createStoredPreference<DepartureBoardOrder>({
  key: "karla:departure-grouping",
  // Time order is the default: an unreadable preference is the same as never having set one.
  parse: (stored) => DEPARTURE_BOARD_ORDERS.find((order) => order === stored) ?? "time",
});
