import { useEffect, useMemo, useRef, useState } from "react";
import { zentrumSchematicNodeById } from "../../lib/zentrum-schematic-plan";

export function ZentrumStopSearch({
  lineIdsByNodeId,
  onSelectStop,
}: {
  lineIdsByNodeId: ReadonlyMap<string, readonly string[]>;
  onSelectStop: (stopId: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    inputRef.current?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target))
        setIsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        !(event.target instanceof Node) ||
        !containerRef.current?.contains(event.target)
      )
        return;
      setIsOpen(false);
      toggleRef.current?.focus();
      event.stopPropagation();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isOpen]);
  const sortedStops = useMemo(
    () =>
      [...lineIdsByNodeId.keys()]
        .flatMap((id) => {
          const node = zentrumSchematicNodeById.get(id);
          return node ? [node] : [];
        })
        .sort((left, right) => left.label.localeCompare(right.label, "de")),
    [lineIdsByNodeId],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase("de");
  const matches = sortedStops.filter((node) =>
    node.label.toLocaleLowerCase("de").includes(normalizedQuery),
  );
  return (
    <div className="zentrum-stop-search" ref={containerRef}>
      <button
        ref={toggleRef}
        type="button"
        className="zentrum-plan-search-toggle"
        aria-label="Haltestelle suchen"
        title="Haltestelle suchen"
        aria-expanded={isOpen}
        aria-controls={isOpen ? "zentrum-stop-search" : undefined}
        onClick={() => setIsOpen(!isOpen)}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="8.5" cy="8.5" r="4.5" />
          <path d="m12 12 4.5 4.5" />
        </svg>
      </button>
      {isOpen && (
        <section
          id="zentrum-stop-search"
          className="zentrum-stop-search-panel"
          aria-label="Haltestelle suchen"
        >
          <label>
            Haltestelle suchen
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <ul>
            {matches.map((node) => (
              <li key={node.id}>
                <button
                  type="button"
                  onClick={() => {
                    onSelectStop(node.id);
                    setIsOpen(false);
                    setQuery("");
                    toggleRef.current?.focus();
                  }}
                >
                  {node.label}
                </button>
              </li>
            ))}
          </ul>
          {matches.length === 0 && <p>Keine Haltestelle im Plan gefunden.</p>}
        </section>
      )}
    </div>
  );
}
