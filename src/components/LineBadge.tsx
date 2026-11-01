import type { TransitLine } from "../data/transit-types";

/** The line sign. Decorative by design: every caller names the line in its own accessible label. */
export function LineBadge({ line, size = "lg" }: { line: TransitLine; size?: "lg" | "sm" | "xs" }) {
  const { kicker, route } = splitLineSign(line.id);
  const isLong = route.length > 4;
  return (
    <span
      className={`line-badge ${size}`}
      style={{ background: line.signColor, color: line.signInk }}
      data-stacked={kicker ? "true" : undefined}
      data-long={isLong ? "true" : undefined}
      aria-hidden="true"
    >
      {kicker ? (
        <>
          <small>{kicker}</small>
          <span>{route}</span>
        </>
      ) : isLong ? (
        <span>{route}</span>
      ) : (
        route
      )}
    </span>
  );
}

/** "SEV 10" reads as a kind over a route: the sign keeps its footprint by stacking the two instead
    of wrapping wherever the space falls. Ids without a space stay one line. */
function splitLineSign(id: string): { kicker?: string; route: string } {
  const space = id.indexOf(" ");
  if (space <= 0) return { route: id };
  return { kicker: id.slice(0, space), route: id.slice(space + 1) };
}
