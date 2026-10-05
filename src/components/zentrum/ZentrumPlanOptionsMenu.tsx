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
export function ZentrumPlanOptionsMenu() {
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
                  return (
                    <fieldset key={key}>
                      <legend>{definition.label}</legend>
                      <SegmentedControl
                        value={options[key]}
                        items={definition.choices}
                        onValueChange={(value) =>
                          zentrumPlanOptions.write({ ...options, [key]: value })
                        }
                        ariaLabel={definition.label}
                      />
                      <p>{definition.description}</p>
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
          <path d="M4 5h12M4 10h12M4 15h12M7 3v4M13 8v4M8 13v4" />
        </svg>
      </button>
    </div>
  );
}
