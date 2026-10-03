const transliterationByGermanLetter: Record<string, string> = {
  ä: "ae",
  ö: "oe",
  ü: "ue",
  ß: "ss",
};

/**
 * A stop name as a URL id, transliterating German first (`Mühlburger Tor` → `muehlburger-tor`).
 * Kept out of `routing`, which reads `window` at load.
 */
export function createStopSlug(name: string): string {
  return name
    .toLocaleLowerCase("de-DE")
    .replace(/[äöüß]/g, (letter) => transliterationByGermanLetter[letter])
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
