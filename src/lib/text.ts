/**
 * How German rider-facing text is ordered.
 *
 * Everything sorted for a rider is a name they read on a sign — a place, a platform code — so the
 * comparison is the one their language uses: umlauts sort with their base letter, and digits sort
 * as numbers, because `Gleis 10` belongs after `Gleis 2` and not between `Gleis 1` and `Gleis 3`.
 */
const germanNameCollator = new Intl.Collator("de-DE", { numeric: true });

export const compareGermanNames = (left: string, right: string): number =>
  germanNameCollator.compare(left, right);
