import { useState } from "react";
import { useStoredPreference } from "../../hooks/stored-preference";
import {
  ZENTRUM_EXPERIMENT_DEFINITIONS,
  type ZentrumExperiments,
  zentrumExperiments,
} from "../../lib/zentrum-experiments";

const experimentKeys = Object.keys(ZENTRUM_EXPERIMENT_DEFINITIONS) as (keyof ZentrumExperiments)[];

/** The plan's trial options, kept on the device. */
export function ZentrumExperimentsMenu({
  isStopOpen,
}: {
  /** An opened stop decides what is lit, so overview-only trials are held. */
  isStopOpen: boolean;
}) {
  const experiments = useStoredPreference(zentrumExperiments);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  return (
    <div className="zentrum-plan-experiments">
      {isMenuOpen && (
        <fieldset className="zentrum-plan-experiments-panel" id="zentrum-plan-experiments">
          <legend>Experimente</legend>
          {experimentKeys.map((key) => (
            <label key={key}>
              {ZENTRUM_EXPERIMENT_DEFINITIONS[key].label}
              <select
                value={experiments[key]}
                disabled={isStopOpen && "isOverviewOnly" in ZENTRUM_EXPERIMENT_DEFINITIONS[key]}
                onChange={(event) =>
                  zentrumExperiments.write({
                    ...experiments,
                    [key]: event.target.value as ZentrumExperiments[typeof key],
                  })
                }
              >
                {ZENTRUM_EXPERIMENT_DEFINITIONS[key].choices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </fieldset>
      )}
      <button
        type="button"
        className="zentrum-plan-experiments-toggle"
        aria-expanded={isMenuOpen}
        aria-controls="zentrum-plan-experiments"
        aria-label="Experimente"
        title="Experimente"
        onClick={() => setIsMenuOpen((isOpen) => !isOpen)}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M8 3.5h4M8.75 3.5v4.75L4.5 15.25a1 1 0 0 0 .86 1.5h9.28a1 1 0 0 0 .86-1.5L11.25 8.25V3.5M6.5 12h7" />
        </svg>
      </button>
    </div>
  );
}
