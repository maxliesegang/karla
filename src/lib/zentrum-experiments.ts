/** Trial options for the Zentrum plan, chosen on the plan itself and kept on the device. */
import { createStoredPreference } from "./stored-preference";

export const ZENTRUM_EXPERIMENT_DEFINITIONS = {
  /** Whether the plan, with no stop open, lights the way ahead of the trams drawn on it. */
  overviewPaths: {
    label: "Fahrwege in der Übersicht",
    isOverviewOnly: true,
    choices: [
      { value: "off", label: "Aus" },
      { value: "ahead", label: "An" },
    ],
    defaultValue: "off",
  },
  /** How a line is drawn where the reading does not light it: at the opened stop, or in Fahrwege. */
  unlitLineStyle: {
    label: "Übrige Strecken",
    choices: [
      { value: "trace", label: "Grau, gestrichelt" },
      { value: "dashes", label: "Farbig, gestrichelt" },
      { value: "dashes-muted", label: "Blass, gestrichelt" },
      { value: "dots", label: "Farbig, gepunktet" },
      { value: "dots-muted", label: "Blass, gepunktet" },
    ],
    defaultValue: "dots-muted",
  },
  /** What the minutes at the stops reached from an opened stop count. */
  destinationTime: {
    label: "Ziele in Minuten",
    choices: [
      { value: "arrival", label: "Bis zur Ankunft" },
      { value: "ride", label: "Fahrzeit" },
    ],
    defaultValue: "arrival",
  },
  /** Whether the plan, opened without a stop, asks the device where it is and opens the nearest. */
  openAt: {
    label: "Beim Öffnen",
    choices: [
      { value: "plan", label: "Ganzer Plan" },
      { value: "nearest", label: "Nächste Haltestelle (Standort)" },
    ],
    defaultValue: "plan",
  },
} as const;

type ZentrumExperimentDefinitions = typeof ZENTRUM_EXPERIMENT_DEFINITIONS;

export type ZentrumExperiments = {
  [Key in keyof ZentrumExperimentDefinitions]: ZentrumExperimentDefinitions[Key]["choices"][number]["value"];
};

/** Saved experiment choices; missing or invalid fields take their defaults. */
export function getZentrumExperimentsFromStored(stored: unknown): ZentrumExperiments {
  const candidate =
    typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  const savedChoices = {
    overviewPaths: candidate.overviewPaths ?? candidate.planWays,
    unlitLineStyle: candidate.unlitLineStyle ?? candidate.callingLineStyle,
    destinationTime: candidate.destinationTime,
    openAt: candidate.openAt,
  };
  return Object.fromEntries(
    Object.entries(ZENTRUM_EXPERIMENT_DEFINITIONS).map(([key, { choices, defaultValue }]) => {
      const value = savedChoices[key as keyof ZentrumExperiments];
      return [key, choices.some((choice) => choice.value === value) ? value : defaultValue];
    }),
  ) as ZentrumExperiments;
}

export const zentrumExperiments = createStoredPreference<ZentrumExperiments>({
  key: "karla:zentrum-experiments",
  parse: (stored) => getZentrumExperimentsFromStored(JSON.parse(stored ?? "null")),
  serialize: JSON.stringify,
});
