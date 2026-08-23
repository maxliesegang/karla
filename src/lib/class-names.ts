/**
 * Joins the class names that apply, dropping the ones that do not. Written out inline, a row of
 * conditional classes leaves a run of empty strings in the attribute and buries the one class that
 * actually varies.
 */
export function classNames(...values: (string | false | undefined | null)[]): string {
  return values.filter(Boolean).join(" ");
}
