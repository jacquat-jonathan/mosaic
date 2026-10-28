import { Fragment, useMemo, useState } from "react";
import { icons } from "lucide-react";
import { Button, SegmentedControl, TextField } from "./components";

// `icons` contains the installed package's canonical names, without its compatibility aliases.
const available = Object.entries(icons).sort(([left], [right]) => left.localeCompare(right));
const pageSize = 72;
const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

export default function IconCatalog({ onAnnounce }: { onAnnounce(message: string): void }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [size, setSize] = useState<"16" | "20" | "24">("20");
  const [selected, setSelected] = useState("Search");
  const filtered = useMemo(() => available.filter(([name]) => normalize(name).includes(normalize(query))), [query]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const shown = filtered.slice(page * pageSize, (page + 1) * pageSize);
  const SelectedIcon = icons[selected as keyof typeof icons];

  return (
    <div className="ds-icon-catalog">
      <div className="ds-icon-controls">
        <TextField
          label="Find a Lucide icon"
          value={query}
          placeholder="Search, ArrowLeft, Calendar…"
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
          hint={`${available.length.toLocaleString()} available icons from Mosaic's installed Lucide package.`}
        />
        <div>
          <div className="ds-control-label">Preview size</div>
          <SegmentedControl<"16" | "20" | "24">
            label="Icon preview size"
            value={size}
            onChange={setSize}
            options={[
              { value: "16", label: "16px" },
              { value: "20", label: "20px" },
              { value: "24", label: "24px" },
            ]}
          />
        </div>
      </div>
      <div className="ds-icon-selection" aria-label="Selected icon">
        <SelectedIcon size={28} aria-hidden="true" />
        <div>
          <strong>{selected}</strong>
          <code>{`import { ${selected} } from "lucide-react";`}</code>
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            if (!navigator.clipboard) {
              onAnnounce(`Icon name: ${selected}. Select its name above to copy manually.`);
              return;
            }
            void navigator.clipboard.writeText(selected).then(
              () => onAnnounce(`Copied icon name: ${selected}.`),
              () => onAnnounce(`Icon name: ${selected}. Select its name above to copy manually.`),
            );
          }}
        >
          Copy name
        </Button>
      </div>
      <div className="ds-icon-results" role="status">
        {filtered.length.toLocaleString()} matching icons · Choose an icon to see its exact name.
      </div>
      <div className="ds-icon-grid" aria-label="Available Lucide icons">
        {shown.map(([name, Icon]) => (
          <button
            key={name}
            type="button"
            className="ds-icon-tile"
            aria-label={name}
            aria-pressed={selected === name}
            onClick={() => setSelected(name)}
          >
            <Icon size={Number(size)} aria-hidden="true" />
            <span>
              {name.split(/(?=[A-Z])/).map((part, index) => (
                <Fragment key={index}>
                  {index > 0 && <wbr />}
                  {part}
                </Fragment>
              ))}
            </span>
          </button>
        ))}
      </div>
      {!shown.length && (
        <p className="ds-empty">No icons match “{query}”. Try a name such as Search, File, or Calendar.</p>
      )}
      <div className="ds-icon-pagination">
        <Button variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>
          Previous icons
        </Button>
        <span>
          Page {page + 1} of {pageCount}
        </span>
        <Button variant="secondary" disabled={page + 1 >= pageCount} onClick={() => setPage(page + 1)}>
          Next icons
        </Button>
      </div>
    </div>
  );
}
