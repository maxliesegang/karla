import type { CountdownReading } from "../lib/stop-event-presentation";

/**
 * A departure's countdown, shared by every board order at different sizes. A cancelled journey says
 * so in the operator's word instead of a dash.
 */
export function DepartureCountdown({ reading }: { reading: CountdownReading }) {
  if (reading.kind === "minutes" || reading.kind === "seconds") {
    return (
      <>
        <strong>{reading.kind === "minutes" ? reading.minutes : reading.seconds}</strong>
        <small>{reading.kind === "minutes" ? "min" : "s"}</small>
      </>
    );
  }
  return <strong className={reading.kind}>{reading.label}</strong>;
}
