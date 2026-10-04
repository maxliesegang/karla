/** Display and opening options for the Zentrum plan, kept on the device. */
import { createStoredPreference } from "./stored-preference";

/** The panel's sections, in order. */
export const ZENTRUM_PLAN_OPTION_GROUPS = [
  { id: "overview", label: "Übersicht" },
  { id: "stop", label: "Geöffnete Haltestelle" },
] as const;

export const ZENTRUM_PLAN_OPTION_DEFINITIONS = {
  /** Paths are drawn only in the overview; at an opened stop, departed trams recede less. */
  vehiclePathMode: {
    group: "overview",
    label: "Fahrwege",
    description:
      "Färbt die Strecke, die jede Bahn im Plan noch vor sich hat. An einer geöffneten Haltestelle bleiben Bahnen, die von ihr wegfahren, halb sichtbar.",
    choices: [
      { value: "off", label: "Aus" },
      { value: "ahead", label: "An" },
    ],
    defaultValue: "off",
  },
  /** The initial view applies only when the address names no line or stop. */
  initialView: {
    group: "overview",
    label: "Beim Öffnen",
    description: "Öffnet auf Wunsch den Halt, der deinem Standort am nächsten ist.",
    choices: [
      { value: "plan", label: "Ganzer Plan" },
      { value: "nearest", label: "Nächster Halt" },
    ],
    defaultValue: "plan",
  },
  /** Destination minutes include waiting or count only time on board. */
  travelMeasure: {
    group: "stop",
    label: "Ziele in Minuten",
    description: "Zählt bis zur Ankunft, also mit Wartezeit, oder nur die Fahrt.",
    choices: [
      { value: "arrival", label: "Bis Ankunft" },
      { value: "ride", label: "Fahrzeit" },
    ],
    defaultValue: "arrival",
  },
  /** Style of lines outside the selected paths. */
  unlitLineStyle: {
    group: "stop",
    label: "Übrige Strecken",
    description: "Wie Linien zurücktreten, die die Auswahl nicht betrifft.",
    choices: [
      { value: "dots-muted", label: "Blass gepunktet" },
      { value: "trace", label: "Grau gestrichelt" },
    ],
    defaultValue: "dots-muted",
  },
} as const;

type ZentrumPlanOptionDefinitions = typeof ZENTRUM_PLAN_OPTION_DEFINITIONS;

export type ZentrumPlanOptions = {
  [Key in keyof ZentrumPlanOptionDefinitions]: ZentrumPlanOptionDefinitions[Key]["choices"][number]["value"];
};

/** Saved plan options; missing or invalid fields take their defaults. */
export function getZentrumPlanOptionsFromStored(stored: unknown): ZentrumPlanOptions {
  const candidate =
    typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  const savedChoices = {
    vehiclePathMode: candidate.vehiclePathMode ?? candidate.overviewPaths ?? candidate.planWays,
    unlitLineStyle: candidate.unlitLineStyle ?? candidate.callingLineStyle,
    travelMeasure: candidate.travelMeasure ?? candidate.destinationTime,
    initialView: candidate.initialView ?? candidate.openAt,
  };
  return Object.fromEntries(
    Object.entries(ZENTRUM_PLAN_OPTION_DEFINITIONS).map(([key, { choices, defaultValue }]) => {
      const value = savedChoices[key as keyof ZentrumPlanOptions];
      return [key, choices.some((choice) => choice.value === value) ? value : defaultValue];
    }),
  ) as ZentrumPlanOptions;
}

export const zentrumPlanOptions = createStoredPreference<ZentrumPlanOptions>({
  key: "karla:zentrum-experiments",
  parse: (stored) => getZentrumPlanOptionsFromStored(JSON.parse(stored ?? "null")),
  serialize: JSON.stringify,
});
