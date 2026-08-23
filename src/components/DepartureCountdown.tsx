import type { CountdownReading } from "../lib/departure-presentation";

/**
 * A departure printed as the minute it leaves in — the one reading every surface of the board
 * shares.
 *
 * The row of the time and platform orders and the chip of the line order lay the same reading out
 * at different sizes, so the markup is one component and the size is the stylesheet's business. A
 * cancelled trip has no countdown to state — a struck-through dash reads as a rendering fault from
 * three metres away — so it says what happened instead, in the word the operator uses.
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
