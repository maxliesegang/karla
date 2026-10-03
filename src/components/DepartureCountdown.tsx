import type { CountdownReading } from "../lib/departure-presentation";

/**
 * A departure's countdown, shared by every board order at different sizes. A cancelled trip says so
 * in the operator's word instead of a dash.
 */
export function DepartureCountdown({ reading }: { reading: CountdownReading }) {
  if (reading.kind === "minutes")
    return (
      <>
        <strong>{reading.minutes}</strong>
        <small>min</small>
      </>
    );
  return <strong className={reading.kind}>{reading.label}</strong>;
}
