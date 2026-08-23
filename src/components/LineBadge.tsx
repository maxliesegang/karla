import type { TransitLine } from "../data/transit-types";

/** The line sign. Decorative by design: every caller names the line in its own accessible label. */
export function LineBadge({ line, size = "lg" }: { line: TransitLine; size?: "lg" | "sm" | "xs" }) {
  return (
    <span
      className={`line-badge ${size}`}
      style={{ background: line.color, color: line.textColor }}
      aria-hidden="true"
    >
      {line.id}
    </span>
  );
}
