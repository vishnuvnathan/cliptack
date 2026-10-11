import { useEffect } from "react";
import { useStash } from "../store/useStash";

/**
 * The reason deleting needs no confirmation dialog.
 *
 * A confirm taxes every delete to guard against the rare wrong one; an undo
 * offer costs nothing until you need it, which suits a panel driven at speed
 * from the keyboard. The 24h grace window in `retention.rs` was already
 * preserving the row -- this is what finally reaches it.
 */
const DISMISS_MS = 8000;

export function UndoBar() {
  const lastDeleted = useStash((s) => s.lastDeleted);
  const undoDelete = useStash((s) => s.undoDelete);
  const dismissUndo = useStash((s) => s.dismissUndo);

  // Keyed on the id so deleting a second item restarts the countdown rather
  // than inheriting the remains of the first one's.
  const id = lastDeleted?.item.id;
  useEffect(() => {
    if (!id) return;
    const timer = setTimeout(dismissUndo, DISMISS_MS);
    return () => clearTimeout(timer);
  }, [id, dismissUndo]);

  if (!lastDeleted) return null;

  const { item, secretErased } = lastDeleted;
  const title = item.title?.trim() || "item";

  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-edge bg-panelalt px-4 py-1.5 text-[11px] text-zinc-400">
      <span className="min-w-0 flex-1 truncate">
        Deleted <span className="text-zinc-200">{title}</span>
        {/* Stated before the offer is taken, not after: the password is
            already gone and no undo brings it back. */}
        {secretErased && <span className="text-zinc-500"> · password erased</span>}
      </span>

      <button
        onClick={() => void undoDelete()}
        className="shrink-0 rounded px-1.5 py-0.5 text-accent transition-colors hover:bg-accent/10"
      >
        {secretErased ? "Restore without password" : "Undo"}
        <span className="ml-1.5 text-zinc-600">Ctrl+Z</span>
      </button>

      <button
        onClick={dismissUndo}
        aria-label="Dismiss"
        className="shrink-0 rounded px-1 leading-none text-zinc-600 transition-colors hover:text-zinc-300"
      >
        ✕
      </button>
    </div>
  );
}
