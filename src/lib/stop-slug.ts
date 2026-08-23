const transliterationByGermanLetter: Record<string, string> = {
  ä: "ae",
  ö: "oe",
  ü: "ue",
  ß: "ss",
};

/**
 * Turns a stop name from the local data into our stable URL id. German spelling is transliterated
 * before accents are stripped, so `Mühlburger Tor` becomes `muehlburger-tor` — the form KVV and
 * riders read — rather than `muhlburger-tor`.
 *
 * Lives apart from `routing` so the data layer can share it without importing a module that reads
 * `window` at load time.
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
