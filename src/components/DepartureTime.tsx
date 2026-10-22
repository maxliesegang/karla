import type { DepartureTimeReading } from "../lib/stop-event-presentation";
import { classNames } from "../lib/class-names";

/**
 * The expected time, with the struck schedule only where a deviation moved it. Shared by every
 * board order so they never state it differently.
 */
export function DepartureTime({ reading }: { reading: DepartureTimeReading }) {
  return (
    <span className="departure-time">
      <span className={classNames("departure-expected-time", reading.punctuality)}>
        {reading.expectedTime}
      </span>
      {reading.timetabledTime && (
        <s className="departure-scheduled-time">{reading.timetabledTime}</s>
      )}
    </span>
  );
}
