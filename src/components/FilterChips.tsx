import { useEffect, useState } from "react";
import type { MatchCount } from "../lib/types";
import { TYPE_CHIPS } from "../lib/types";
import { useCliptack } from "../store/useCliptack";
import { FolderBar } from "./FolderBar";

export function FilterChips() {
  const typeChips = useCliptack((s) => s.typeChips);
  const toggleTypeChip = useCliptack((s) => s.toggleTypeChip);
  const sourceApps = useCliptack((s) => s.sourceApps);
  const activeSourceApps = useCliptack((s) => s.activeSourceApps);
  const toggleSourceApp = useCliptack((s) => s.toggleSourceApp);
  const clearFilters = useCliptack((s) => s.clearFilters);
  const activeFolderId = useCliptack((s) => s.activeFolderId);
  const query = useCliptack((s) => s.query);

  const anyActive =
    typeChips.length > 0 || activeSourceApps.length > 0 || activeFolderId !== null;

  // A bulk delete is offered only once the view is narrowed to something. With
  // an empty box and no chips it would mean "delete everything", which is what
  // the deliberate, plainly-labelled button in Settings is for.
  const narrowed = anyActive || query.trim().length > 0;

  return (
    <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-edge px-4 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {/* Folders lead the row. Keeping them here rather than in a row of their
          own is what leaves the preview pane its full height. */}
      <FolderBar />

      <div className="mx-1 h-4 w-px shrink-0 bg-edge" />

      {TYPE_CHIPS.map((chip) => (
        <Chip
          key={chip.id}
          label={chip.label}
          active={typeChips.includes(chip.id)}
          onClick={() => toggleTypeChip(chip.id)}
        />
      ))}

      {sourceApps.length > 0 && <div className="mx-1 h-4 w-px shrink-0 bg-edge" />}

      {/* Capped: the chip row is a shortcut, not a directory. Anything not
          listed is still reachable by typing the app name into search. */}
      {sourceApps.slice(0, 8).map((app) => (
        <Chip
          key={app}
          label={app}
          active={activeSourceApps.includes(app)}
          onClick={() => toggleSourceApp(app)}
        />
      ))}

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {narrowed && <DeleteMatching />}
        {anyActive && (
          <button
            onClick={clearFilters}
            className="shrink-0 px-2 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Deletes everything the current view matches, in two presses.
 *
 * The count comes from Rust rather than `items.length`: search is capped, so
 * the list on screen routinely understates what a delete would take, and a
 * confirm showing the wrong number is worse than no confirm at all.
 *
 * Inline rather than `window.confirm` — native dialogs are unreliable inside
 * the WebView2 host, the same reason `FolderRow` in Settings confirms this way.
 */
function DeleteMatching() {
  const countMatching = useCliptack((s) => s.countMatching);
  const deleteMatching = useCliptack((s) => s.deleteMatching);
  const query = useCliptack((s) => s.query);
  const typeChips = useCliptack((s) => s.typeChips);
  const activeSourceApps = useCliptack((s) => s.activeSourceApps);
  const activeFolderId = useCliptack((s) => s.activeFolderId);

  const [pending, setPending] = useState<MatchCount | null>(null);

  // Changing the view invalidates the number already on the button, so the
  // confirm stands down rather than delete a set the user has stopped looking
  // at. This is the guard that makes the two-press flow safe.
  useEffect(() => {
    setPending(null);
  }, [query, typeChips, activeSourceApps, activeFolderId]);

  if (!pending) {
    return (
      <button
        onClick={() => {
          void countMatching().then((c) => {
            if (c && c.total > 0) setPending(c);
          });
        }}
        title="Delete everything matching this view"
        className="shrink-0 px-2 text-xs text-zinc-500 transition-colors hover:text-red-400"
      >
        Delete these
      </button>
    );
  }

  return (
    <span className="flex shrink-0 items-center gap-1 text-xs">
      <span className="text-zinc-400">
        {pending.total} item{pending.total === 1 ? "" : "s"}
        {/* Pinned rows are counted, not carved out: the user narrowed the view,
            and quietly sparing some of what it shows would be its own surprise.
            Saying so is the honest half of that. */}
        {pending.pinned > 0 && (
          <span className="text-amber-500/80"> ({pending.pinned} pinned)</span>
        )}
      </span>
      <button
        onClick={() => {
          setPending(null);
          void deleteMatching();
        }}
        className="rounded px-1.5 py-0.5 text-red-400 transition-colors hover:bg-red-500/10"
      >
        Delete
      </button>
      <button
        onClick={() => setPending(null)}
        className="rounded px-1.5 py-0.5 text-zinc-500 transition-colors hover:text-zinc-300"
      >
        Cancel
      </button>
    </span>
  );
}

function Chip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={[
        "shrink-0 rounded-full border px-2.5 py-1 text-xs transition-colors",
        active
          ? "border-accent/60 bg-accent/15 text-accent"
          : "border-edge text-zinc-400 hover:border-zinc-600 hover:text-zinc-200",
      ].join(" ")}
    >
      {label}
    </button>
  );
}
