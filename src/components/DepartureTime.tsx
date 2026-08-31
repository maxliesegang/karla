import type { DepartureTimeReading } from "../lib/departure-presentation";
import { classNames } from "../lib/class-names";

/**
 * When the vehicle leaves, and — only where a deviation moved it — the schedule it was moved off.
 *
 * One published time, so a row and its countdown answer with the same minute. The struck schedule
 * is evidence, not a second reading: nothing here has to be added up.
 *
 * Shared by every order of the board for the same reason `DepartureCountdown` is: the time reading
 * is the one statement the three orders must never make differently, and two copies of this markup
 * are two places for them to drift apart.
 */
export function DepartureTime({ reading }: { reading: DepartureTimeReading }) {
  return (
    <span className="departure-time">
      <span className={classNames("departure-expected-time", reading.punctuality)}>
        {reading.expectedTime}
      </span>
      {reading.scheduledTime && <s className="departure-scheduled-time">{reading.scheduledTime}</s>}
    </span>
  );
}
