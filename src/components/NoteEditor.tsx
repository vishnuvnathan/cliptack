import { useEffect, useState } from "react";
import { getItem } from "../lib/ipc";
import { useCliptack } from "../store/useCliptack";
import { RichNoteEditor } from "./LazyNoteEditor";

export function NoteEditor() {
  const editingNoteId = useCliptack((s) => s.editingNoteId);
  const saveNote = useCliptack((s) => s.saveNote);
  const setView = useCliptack((s) => s.setView);

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [source, setSource] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!editingNoteId) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    void getItem(editingNoteId).then((item) => {
      if (cancelled || !item) return;
      setTitle(item.title ?? "");
      setContent(item.content ?? "");
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [editingNoteId]);

  // Ctrl+S saves; Ctrl+E switches to the Markdown source and back; Escape goes
  // back to the list without hiding the panel, so a stray Escape never costs
  // you a half-written note. Ctrl+Shift+S is strikethrough, not save.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      e.stopPropagation();
      void saveNote(title, content);
    }
    if (mod && !e.shiftKey && e.key.toLowerCase() === "e") {
      e.preventDefault();
      e.stopPropagation();
      setSource((s) => !s);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setView("list");
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <div className="flex items-center gap-3 border-b border-edge px-4 py-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Untitled note"
          className="flex-1 bg-transparent text-[15px] text-zinc-100 outline-none placeholder:text-zinc-500"
        />
        <button
          onClick={() => setSource((s) => !s)}
          aria-pressed={source}
          title="Edit the Markdown source (Ctrl+E)"
          className={[
            "rounded border px-2 py-1 text-xs",
            source ? "border-accent/50 text-accent" : "border-edge text-zinc-400 hover:text-zinc-200",
          ].join(" ")}
        >
          Markdown
        </button>
      </div>

      {/* Mounted once the note is in, so the editor starts on the right text
          and takes focus from the beginning. */}
      {loaded && (
        <RichNoteEditor
          value={content}
          onChange={setContent}
          source={source}
          onSourceChange={setSource}
          variant="panel"
          autoFocus
        />
      )}

      <div className="flex items-center justify-between border-t border-edge px-4 py-2 text-[11px] text-zinc-500">
        <span>Ctrl+S save · Ctrl+E markdown · Esc back</span>
        <button
          onClick={() => void saveNote(title, content)}
          className="rounded bg-accent/20 px-2.5 py-1 text-accent hover:bg-accent/30"
        >
          Save
        </button>
      </div>
    </div>
  );
}
