import type { CSSProperties, ReactNode } from "react";
import { classNames } from "../lib/class-names";

export type SegmentedControlItem<Value extends string> = {
  value: Value;
  label: ReactNode;
  ariaLabel?: string;
};

type SegmentedControlProps<Value extends string> = {
  value: Value;
  items: readonly SegmentedControlItem<Value>[];
  onValueChange: (value: Value) => void;
  ariaLabel: string;
  className?: string;
  /** Navigation choices name the current page; view settings behave as pressed buttons. */
  isNavigation?: boolean;
};

/** A small set of mutually exclusive choices, built from native buttons. */
export function SegmentedControl<Value extends string>({
  value,
  items,
  onValueChange,
  ariaLabel,
  className,
  isNavigation = false,
}: SegmentedControlProps<Value>) {
  const selectedIndex = items.findIndex((item) => item.value === value);
  const buttons = items.map((item) => {
    const isSelected = item.value === value;
    return (
      <button
        key={item.value}
        type="button"
        className={isSelected ? "selected" : undefined}
        aria-label={item.ariaLabel}
        aria-current={isNavigation && isSelected ? "page" : undefined}
        aria-pressed={!isNavigation ? isSelected : undefined}
        onClick={() => onValueChange(item.value)}
      >
        {item.label}
      </button>
    );
  });

  // The chosen half is lit by one travelling surface rather than by each button painting itself:
  // the choice then reads as the same object moving between two named places, which is what a
  // rider's finger just did. The columns are equal, so where it lands is arithmetic — index and
  // count are all the stylesheet needs, and nothing has to be measured after layout.
  const classes = classNames("segmented-control", className);
  const style = {
    "--segment-count": items.length,
    "--segment-index": Math.max(selectedIndex, 0),
  } as CSSProperties;
  const content = (
    <>
      {selectedIndex >= 0 && <span className="segmented-control-thumb" aria-hidden="true" />}
      {buttons}
    </>
  );
  return isNavigation ? (
    <nav className={classes} style={style} aria-label={ariaLabel}>
      {content}
    </nav>
  ) : (
    <div className={classes} style={style} role="group" aria-label={ariaLabel}>
      {content}
    </div>
  );
}
