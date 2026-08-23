import type { TransitLine } from "../data/transit-types";
import { getLineTermini } from "../lib/stop-services";

/**
 * The two ends a line was seen running between. Both line lists show them the same way and speak
 * them the same way; only the surrounding layout differs, which is what `className` carries.
 */
export function LineTermini({ line, className }: { line: TransitLine; className: string }) {
  const [firstTerminus, lastTerminus] = getLineTermini(line);

  return (
    <span className={className}>
      <strong>{firstTerminus}</strong>
      {/* A line seen leaving one way only says so, rather than repeating itself. */}
      {lastTerminus && (
        <>
          <i aria-hidden="true">↔</i>
          <strong>{lastTerminus}</strong>
        </>
      )}
    </span>
  );
}

/** How the same pair is spoken: a bare arrow between two names reads as nothing at all. */
export function getLineTerminiLabel(line: TransitLine): string {
  const [firstTerminus, lastTerminus] = getLineTermini(line);
  if (!firstTerminus) return `Linie ${line.id}`;
  return lastTerminus
    ? `Linie ${line.id}, ${firstTerminus} und ${lastTerminus}`
    : `Linie ${line.id}, Richtung ${firstTerminus}`;
}
