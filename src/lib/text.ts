/**
 * German name order: umlauts with their base letter, digits as numbers (`Gleis 2` before `Gleis
 * 10`).
 */
const germanNameCollator = new Intl.Collator("de-DE", { numeric: true });

export const compareGermanNames = (left: string, right: string): number =>
  germanNameCollator.compare(left, right);
