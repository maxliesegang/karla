import { useEffect, useRef, useState } from "react";

/**
 * A value that takes a new key only once the key has held for `settleMs`, and at most once per
 * `intervalMs`, so a burst of changes lands as one. A new value under the shown key passes at once.
 */
export function useSteadyValue<T>(
  value: T,
  key: string,
  { settleMs, intervalMs }: { settleMs: number; intervalMs: number },
): T {
  const [shown, setShown] = useState<{ key: string; value: T; at?: number }>(() => ({
    key,
    value,
  }));
  if (key === shown.key && value !== shown.value) setShown({ ...shown, value });
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  });
  useEffect(() => {
    if (key === shown.key) return;
    const wait =
      shown.at === undefined ? settleMs : Math.max(settleMs, shown.at + intervalMs - Date.now());
    const timer = setTimeout(() => setShown({ key, value: latest.current, at: Date.now() }), wait);
    return () => clearTimeout(timer);
  }, [key, shown, settleMs, intervalMs]);
  return key === shown.key ? value : shown.value;
}
