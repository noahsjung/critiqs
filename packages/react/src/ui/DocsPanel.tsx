import { useState } from "react";
import { DOCS } from "./docs.ts";

/** The Documentation panel: every part of Critiqs and how to use it, searchable. */
export function DocsPanel({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const topics = needle === "" ? DOCS : DOCS.filter((topic) => [topic.title, topic.summary, ...topic.steps].some((text) => text.toLowerCase().includes(needle)));
  return (
    <div className="docs">
      <input
        type="search"
        className="field"
        aria-label="Search the documentation"
        placeholder="Search the documentation"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          // Shortcuts skip text fields, so the field handles Escape: clear the search, then close the panel.
          if (event.key !== "Escape") return;
          event.preventDefault();
          if (query !== "") setQuery("");
          else onClose();
        }}
      />
      {topics.length === 0 && <p className="note">Nothing in the documentation matches “{query.trim()}”.</p>}
      {topics.map((topic) => (
        // Searching opens every match, so what matched shows.
        <details key={topic.id} className="doc-topic" open={needle !== "" || undefined}>
          <summary>{topic.title}</summary>
          <p>{topic.summary}</p>
          <ul>
            {topic.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}
