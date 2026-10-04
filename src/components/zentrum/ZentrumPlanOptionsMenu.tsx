import { useState } from "react";
import { useStoredPreference } from "../../hooks/stored-preference";
import {
  ZENTRUM_PLAN_OPTION_DEFINITIONS,
  ZENTRUM_PLAN_OPTION_GROUPS,
  type ZentrumPlanOptions,
  zentrumPlanOptions,
} from "../../lib/zentrum-plan-options";
import { SegmentedControl } from "../SegmentedControl";

const optionKeys = Object.keys(ZENTRUM_PLAN_OPTION_DEFINITIONS) as (keyof ZentrumPlanOptions)[];

/** The plan's options, grouped by reading. */
export function ZentrumPlanOptionsMenu({
  isStopOpen,
}: {
  /** An opened stop disables overview-only options. */
  isStopOpen: boolean;
}) {
  const options = useStoredPreference(zentrumPlanOptions);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  return (
    <div className="zentrum-plan-options">
      {isMenuOpen && (
        <section
          className="zentrum-plan-options-panel"
          id="zentrum-plan-options"
          aria-labelledby="zentrum-plan-options-heading"
        >
          <h2 id="zentrum-plan-options-heading">Planoptionen</h2>
          {ZENTRUM_PLAN_OPTION_GROUPS.map((group) => (
            <div key={group.id} className="zentrum-plan-options-group">
              <h3>{group.label}</h3>
              {optionKeys
                .filter((key) => ZENTRUM_PLAN_OPTION_DEFINITIONS[key].group === group.id)
                .map((key) => {
                  const definition = ZENTRUM_PLAN_OPTION_DEFINITIONS[key];
                  const isDisabled = isStopOpen && "isOverviewOnly" in definition;
                  return (
                    <fieldset key={key} disabled={isDisabled}>
                      <legend>{definition.label}</legend>
                      <SegmentedControl
                        value={options[key]}
                        items={definition.choices}
                        onValueChange={(value) =>
                          zentrumPlanOptions.write({ ...options, [key]: value })
                        }
                        ariaLabel={definition.label}
                      />
                      <p>
                        {isDisabled ? "Nur ohne geöffnete Haltestelle." : definition.description}
                      </p>
                    </fieldset>
                  );
                })}
            </div>
          ))}
        </section>
      )}
      <button
        type="button"
        className="zentrum-plan-options-toggle"
        aria-expanded={isMenuOpen}
        aria-controls="zentrum-plan-options"
        aria-label="Planoptionen"
        title="Planoptionen"
        onClick={() => setIsMenuOpen((isOpen) => !isOpen)}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M8 3.5h4M8.75 3.5v4.75L4.5 15.25a1 1 0 0 0 .86 1.5h9.28a1 1 0 0 0 .86-1.5L11.25 8.25V3.5M6.5 12h7" />
        </svg>
      </button>
    </div>
  );
}
