import { useEffect, useRef, useState } from "react";
import { useCliptack } from "../store/useCliptack";

/**
 * The "move to folder" menu, opened with Ctrl+M.
 *
 * Entries are "No folder", every folder in the order the Alt+digit shortcuts
 * use, and a trailing "New folder…" that swaps the list for a name field. It
 * owns its keyboard while open for the same reason TransformMenu does: the
 * panel's own bindings would otherwise move the selection underneath it.
 */
export function FolderMenu() {
  const open = useCliptack((s) => s.folderMenuOpen);
  const folders = useCliptack((s) => s.folders);
  const item = useCliptack((s) => s.items[s.selected]);
  const close = useCliptack((s) => s.closeFolderMenu);
  const assign = useCliptack((s) => s.assignSelectedToFolder);
  const createFolder = useCliptack((s) => s.createFolder);

  const [active, setActive] = useState(0);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  // 0 = No folder, 1..n = folders, n+1 = New folder…
  const count = folders.length + 2;

  // Start on the item's current folder so Enter without moving is a no-op
  // rather than a surprise.
  useEffect(() => {
    if (!open) return;
    const at = folders.findIndex((f) => f.id === item?.folderId);
    setActive(at >= 0 ? at + 1 : 0);
    setNaming(false);
    setName("");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (naming) nameRef.current?.focus();
  }, [naming]);

  const choose = (index: number) => {
    if (index === 0) void assign(null);
    else if (index <= folders.length) void assign(folders[index - 1].id);
    else setNaming(true);
  };

  const submitName = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const folder = await createFolder(trimmed);
    if (folder) void assign(folder.id);
  };

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (naming) {
        // Typing belongs to the input; only Enter and Escape are ours.
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setNaming(false);
        } else if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          void submitName();
        } else {
          e.stopPropagation();
        }
        return;
      }
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          setActive((i) => (i + 1) % count);
          return;
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          setActive((i) => (i - 1 + count) % count);
          return;
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          close();
          return;
        case "Enter":
          e.preventDefault();
          e.stopPropagation();
          choose(active);
          return;
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  if (!open) return null;

  const rows = ["No folder", ...folders.map((f) => f.name), "New folder…"];

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/50"
      onMouseDown={close}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="max-h-[80%] w-72 overflow-hidden rounded-lg border border-edge bg-panel shadow-xl"
      >
        <div className="border-b border-edge px-3 py-2">
          <p className="text-[12px] text-zinc-200">Move to folder</p>
          <p className="text-[10px] leading-4 text-zinc-600">Enter moves · Esc cancels</p>
        </div>

        {naming ? (
          <div className="p-3">
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Folder name"
              maxLength={40}
              className="w-full rounded border border-edge bg-panelalt px-2 py-1.5 text-[12px] text-zinc-100 outline-none focus:border-accent/60"
            />
            <p className="mt-1.5 text-[10px] text-zinc-600">
              Enter creates it and moves the item · Esc goes back
            </p>
          </div>
        ) : (
          <ul className="max-h-72 overflow-y-auto py-1">
            {rows.map((label, i) => (
              <li key={i}>
                <button
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(i)}
                  className={[
                    "block w-full truncate px-3 py-1.5 text-left text-[12px]",
                    i === active ? "bg-accent/20 text-zinc-100" : "text-zinc-400",
                    i === 0 || i === rows.length - 1 ? "italic" : "",
                  ].join(" ")}
                >
                  {label}
                  {i > 0 && i <= folders.length && folders[i - 1].id === item?.folderId
                    ? "  ✓"
                    : ""}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
