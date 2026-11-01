/**
 * The colours a line is shown in, held to WCAG AA: a sign's fill and ink, the line's colour as text,
 * and whether its stroke needs an outline. Fills may shift a little in lightness to keep the
 * operator's published ink; past that, the ink flips instead.
 */

export type LineColors = {
  /** The operator's colour, for strokes. */
  color: string;
  /** The fill wherever text or an icon sits on the line's colour. */
  signColor: string;
  signInk: string;
  /** The line's colour as text or a thin mark on the app's light surfaces and its own row tints. */
  textTone: string;
};

const white = "#ffffff";
const black = "#000000";
const darkInk = "#102c2c";
/** The darkest light surface text sits on (`--paper`). */
const paper = "#e9ebe5";
/** The strongest tint of a line a row takes (`--shell-accent` at 27% when pressed). */
const maxRowTint = 0.27;
const textContrast = 4.5;
const graphicContrast = 3;
/** OKLab distance (×100) a sign's fill may move to keep its ink; beyond it reads as another colour. */
const maxSignShift = 8;
const lightnessStep = 0.002;

type Rgb = readonly [number, number, number];
type Oklab = readonly [number, number, number];

const toRgb = (hex: string): Rgb => {
  const digits =
    hex.length === 4 ? [...hex.slice(1)].map((digit) => digit + digit).join("") : hex.slice(1);
  return [0, 2, 4].map((offset) => Number.parseInt(digits.slice(offset, offset + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
};
const toHex = (rgb: Rgb): string =>
  `#${rgb
    .map((channel) =>
      Math.round(Math.min(1, Math.max(0, channel)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

const tintOnWhite = (color: string, amount: number): string =>
  toHex(toRgb(color).map((channel) => channel * amount + 1 - amount) as [number, number, number]);

const toLinear = (channel: number): number =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
const toGamma = (channel: number): number =>
  channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;

const relativeLuminance = (hex: string): number => {
  const [red, green, blue] = toRgb(hex).map(toLinear);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
};

export const contrastRatio = (first: string, second: string): number => {
  const [darker, lighter] = [relativeLuminance(first), relativeLuminance(second)].sort(
    (a, b) => a - b,
  );
  return (lighter + 0.05) / (darker + 0.05);
};

const toOklab = (hex: string): Oklab => {
  const [red, green, blue] = toRgb(hex).map(toLinear);
  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
};

const fromOklab = ([lightness, a, b]: Oklab): string => {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return toHex(
    [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707612719 * s,
    ].map(toGamma) as [number, number, number],
  );
};

export const colorDistance = (first: string, second: string): number => {
  const [l1, a1, b1] = toOklab(first);
  const [l2, a2, b2] = toOklab(second);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2) * 100;
};

/** The colour stepped in lightness, hue and chroma kept, until it reaches `target` against `ground`. */
function shiftToContrast(
  color: string,
  ground: string,
  target: number,
  maxShift = Number.POSITIVE_INFINITY,
): string | undefined {
  const [lightness, a, b] = toOklab(color);
  const direction = relativeLuminance(ground) > relativeLuminance(color) ? -1 : 1;
  for (let step = 0; step * lightnessStep <= 1; step += 1) {
    const shifted =
      step === 0 ? color : fromOklab([lightness + direction * step * lightnessStep, a, b]);
    if (colorDistance(color, shifted) > maxShift) return undefined;
    if (contrastRatio(shifted, ground) >= target) return shifted;
  }
  return undefined;
}

const isLight = (color: string): boolean =>
  contrastRatio(color, black) > contrastRatio(color, white);

/** The inks to try, the published one's family first; dark ink falls back to black. */
function getInkOrder(color: string, publishedInk: string | undefined): readonly string[] {
  const shiftFor = (ink: string) => {
    const shifted = shiftToContrast(color, ink, textContrast);
    return shifted ? colorDistance(color, shifted) : Number.POSITIVE_INFINITY;
  };
  const prefersWhite = publishedInk
    ? isLight(publishedInk)
    : shiftFor(white) <= Math.min(shiftFor(darkInk), shiftFor(black));
  return prefersWhite ? [white, darkInk, black] : [darkInk, black, white];
}

function getSignPair(
  color: string,
  publishedInk?: string,
): Pick<LineColors, "signColor" | "signInk"> {
  for (const ink of getInkOrder(color, publishedInk)) {
    const signColor = shiftToContrast(color, ink, textContrast, maxSignShift);
    if (signColor) return { signColor, signInk: ink };
  }
  // White or black always clears 4.5:1 on any colour.
  return {
    signColor: color,
    signInk: contrastRatio(color, white) >= contrastRatio(color, black) ? white : black,
  };
}

const colorsByKey = new Map<string, LineColors>();

/** A line's colours from the operator's colour and, where published, its text colour. */
export function getLineColors(color: string, publishedInk?: string): LineColors {
  const key = `${color}|${publishedInk ?? ""}`;
  const known = colorsByKey.get(key);
  if (known) return known;
  const signPair = getSignPair(color, publishedInk);
  const darkestGround = [
    paper,
    tintOnWhite(color, maxRowTint),
    tintOnWhite(signPair.signColor, maxRowTint),
  ].reduce((darkest, ground) =>
    relativeLuminance(ground) < relativeLuminance(darkest) ? ground : darkest,
  );
  const colors: LineColors = {
    color,
    ...signPair,
    textTone: shiftToContrast(color, darkestGround, textContrast) ?? darkInk,
  };
  colorsByKey.set(key, colors);
  return colors;
}

/** Line graphics under 3:1 on white are drawn with an outline. */
export const needsLineOutline = (color: string): boolean =>
  contrastRatio(color, white) < graphicContrast;

/** A pale colour darkened to 3:1 on white, for the plan's tone option; others need none. */
export const getPlanLineTone = (color: string): string | undefined =>
  needsLineOutline(color) ? shiftToContrast(color, white, graphicContrast) : undefined;
