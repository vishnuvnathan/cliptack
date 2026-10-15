import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { ResizeGrips } from "./ResizeGrips";
import {
  closeSticky,
  copyItem,
  getItem,
  getSettings,
  getStickyColor,
  onItemUpdated,
  onSettingsChanged,
  onStickyAssigned,
  onWindowGeometry,
  readBlob,
  saveNote,
  saveStickyGeometry,
  setStickyColor,
  startStickyMove,
  startStickyResize,
  stickyAssignment,
  stickyEditAsNote,
} from "../lib/ipc";
import { STICKY_PAPERS, paperFor, paperStyle, useTheme } from "../lib/theme";
import type { Item, Settings } from "../lib/types";

/** Quiet time after the last keystroke before a note edit is written. */
const AUTOSAVE_MS = 600;
/** Quiet time after a move or resize before the position is written. */
const GEOMETRY_MS = 500;

const MONO = new Set(["code", "json", "path"]);

/**
 * The root of every sticky window. Holds which item the window shows, which
 * can change under it: a spare starts with none and is handed one, and a clip
 * card switches to the note made from it ("Edit as note"). The card is keyed
 * by id, so a switch starts it fresh rather than carrying one item's state
 * into another.
 */
export function StickyHost({ initialId }: { initialId: string | null }) {
  const [id, setId] = useState(initialId);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onStickyAssigned(setId).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    // A spare may have been handed its item before the listener above was up.
    if (!initialId) {
      void stickyAssignment()
        .then((assigned) => {
          if (assigned && !cancelled) setId((current) => current ?? assigned);
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [initialId]);

  return id ? <StickyWindow key={id} id={id} /> : null;
}

/**
 * One item pinned to the screen. Rendered in its own window, with none of the
 * panel's store: it loads its item by id, follows settings through an event,
 * and talks to Rust only through ipc.ts like everything else.
 *
 * Notes are editable and autosave; everything else is read-only, because the
 * history records what was copied and a sticky is not a way round that. A
 * text clip offers "Edit as note" instead, which edits a copy.
 */
export function StickyWindow({ id }: { id: string }) {
  const [item, setItem] = useState<Item | null>(null);
  const [missing, setMissing] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [preview, setPreview] = useState(false);
  const [color, setColor] = useState("default");
  const [picking, setPicking] = useState(false);

  // The note body. Held in a ref as well as state so a save can tell whether
  // the text moved on while the save was in flight.
  const [draft, setDraft] = useState("");
  const draftRef = useRef("");
  const dirty = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  useTheme(settings?.theme, settings?.accent);

  /**
   * Leaves the draft alone while it holds unsaved typing: the reload is
   * usually our own save echoing back, and replacing the text mid-word would
   * eat keystrokes. If the panel saved the same note meanwhile, the next save
   * from here wins -- last write wins, as with any two editors.
   */
  const load = useCallback(async () => {
    try {
      const loaded = await getItem(id);
      if (!loaded) {
        setMissing(true);
        return;
      }
      setItem(loaded);
      if (!dirty.current) {
        draftRef.current = loaded.content ?? "";
        setDraft(draftRef.current);
      }
    } catch (e) {
      setError(String(e));
    }
  }, [id]);

  const flush = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
    }
    if (!dirty.current || !item) return;
    const sent = draftRef.current;
    try {
      const saved = await saveNote(id, item.title ?? "", sent);
      if (draftRef.current === sent) dirty.current = false;
      setItem(saved);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [id, item]);

  const onEdit = (value: string) => {
    draftRef.current = value;
    dirty.current = true;
    setDraft(value);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
  };

  useEffect(() => {
    void load();
    void getStickyColor(id)
      .then(setColor)
      .catch(() => undefined);
    void getSettings()
      .then(setSettings)
      .catch(() => undefined);

    const unlisteners: Array<() => void> = [];
    const track = (p: Promise<() => void>) => {
      void p.then((fn) => unlisteners.push(fn));
    };

    track(
      onItemUpdated((updated) => {
        if (updated === id) void load();
      }),
    );
    track(onSettingsChanged(setSettings));

    // A drag fires a move event per frame; only where it comes to rest is
    // worth a write.
    let geometryTimer: ReturnType<typeof setTimeout> | undefined;
    track(
      onWindowGeometry(() => {
        if (geometryTimer) clearTimeout(geometryTimer);
        geometryTimer = setTimeout(() => void saveStickyGeometry(id).catch(() => undefined), GEOMETRY_MS);
      }),
    );

    return () => {
      if (geometryTimer) clearTimeout(geometryTimer);
      unlisteners.forEach((fn) => fn());
    };
  }, [id, load]);

  /** Copies what is stored, so an unsaved edit is written first. */
  const copy = useCallback(async () => {
    await flush();
    try {
      await copyItem(id);
      setCopied(true);
      setError(null);
      setTimeout(() => setCopied(false), 1200);
    } catch (e) {
      setError(String(e));
    }
  }, [flush, id]);

  const close = useCallback(async () => {
    await flush();
    try {
      await closeSticky(id);
    } catch (e) {
      setError(String(e));
    }
  }, [flush, id]);

  /** Shown at once; a failed save puts the old colour back and says why. */
  const pickColor = useCallback(
    async (next: string) => {
      setPicking(false);
      const before = color;
      setColor(next);
      try {
        await setStickyColor(id, next);
        setError(null);
      } catch (e) {
        setColor(before);
        setError(String(e));
      }
    },
    [color, id],
  );

  /**
   * Clips stay read-only -- the history records what was copied -- so editing
   * one makes a note from it. Rust switches this window over to the note; the
   * host above remounts the card on the new id.
   */
  const editAsNote = useCallback(async () => {
    try {
      await stickyEditAsNote(id);
    } catch (e) {
      setError(String(e));
    }
  }, [id]);

  const isNote = item?.kind === "note";
  const editable = !!item && !isNote && !item.blobPath && item.contentType !== "image";
  const paper = paperFor(color);

  // Ctrl+C with nothing selected copies the whole item: the card *is* the
  // selection. Ctrl+S and Ctrl+E mirror the panel's note editor. There is no
  // Escape binding on purpose -- a sticky that closed on a stray key would be
  // gone from the screen without the user ever deciding that.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "c" && !hasSelection()) {
        e.preventDefault();
        void copy();
      } else if (key === "s" && isNote) {
        e.preventDefault();
        void flush();
      } else if (key === "e" && isNote) {
        e.preventDefault();
        setPreview((p) => !p);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [copy, flush, isNote]);

  return (
    <div
      data-paper={paper.panel ? paper.name : undefined}
      style={paperStyle(paper)}
      className="relative flex h-screen w-screen flex-col overflow-hidden rounded-lg border border-edge bg-panel font-ui text-zinc-200 antialiased"
    >
      {/* The accent band is what tells a Stash card apart from any other
          frameless window sitting on top. On a paper it takes the paper's ink. */}
      <div className="h-[3px] shrink-0 bg-accent" />

      <div
        onMouseDown={(e) => {
          if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
          e.preventDefault();
          void startStickyMove();
        }}
        className="flex h-7 shrink-0 cursor-grab items-center gap-0.5 bg-panelalt pl-3 pr-1 active:cursor-grabbing"
      >
        <span className="pointer-events-none min-w-0 flex-1 truncate text-[12px] text-zinc-400">
          {missing ? "Deleted" : item?.title || "(empty)"}
        </span>
        {isNote && (
          <StripButton title={preview ? "Edit (Ctrl+E)" : "Preview (Ctrl+E)"} onClick={() => setPreview((p) => !p)}>
            <span className="px-0.5 text-[10px] uppercase tracking-wide">{preview ? "edit" : "view"}</span>
          </StripButton>
        )}
        {editable && (
          <StripButton title="Edit as note" onClick={() => void editAsNote()}>
            <PencilIcon />
          </StripButton>
        )}
        {!missing && (
          <span data-color-toggle className="flex">
            <StripButton title="Colour" onClick={() => setPicking((p) => !p)}>
              {/* All the papers, not the current one: on its own paper the
                  current colour is invisible and the button reads as empty. */}
              <Swatch fill={WHEEL} />
            </StripButton>
          </span>
        )}
        {!missing && (
          <StripButton title="Copy (Ctrl+C)" onClick={() => void copy()}>
            {copied ? <span className="px-0.5 text-[10px] text-accent">copied</span> : <CopyIcon />}
          </StripButton>
        )}
        <StripButton title="Close" onClick={() => void close()}>
          <CloseIcon />
        </StripButton>
      </div>

      {picking && <ColorPicker current={color} onPick={(c) => void pickColor(c)} onDismiss={() => setPicking(false)} />}

      <div className="flex min-h-0 flex-1 flex-col">
        {missing ? (
          <p className="px-3 py-2 text-[12px] text-zinc-500">This item was deleted.</p>
        ) : item ? (
          <Body item={item} draft={draft} preview={preview} onEdit={onEdit} />
        ) : null}
      </div>

      {error && (
        <div className="shrink-0 border-t border-red-900/50 bg-red-950/40 px-3 py-1 text-[11px] text-red-300">
          {error}
        </div>
      )}

      <ResizeGrips start={(dir) => void startStickyResize(dir)} />
    </div>
  );
}

function Body({
  item,
  draft,
  preview,
  onEdit,
}: {
  item: Item;
  draft: string;
  preview: boolean;
  onEdit: (value: string) => void;
}) {
  if (item.kind === "note") {
    return preview ? (
      <div className="prose-stash min-h-0 flex-1 overflow-y-auto px-3 py-2 text-[13px] leading-6 text-zinc-200">
        <ReactMarkdown>{draft || "*Nothing here yet.*"}</ReactMarkdown>
      </div>
    ) : (
      <textarea
        value={draft}
        onChange={(e) => onEdit(e.target.value)}
        placeholder="Markdown…"
        spellCheck={false}
        // A blank sticky is opened to be typed into, and a clip switched to a
        // note was switched to be edited. Focus inside a window the OS has not
        // activated stays inside it, so a card restored at launch steals nothing.
        autoFocus
        className="min-h-0 flex-1 resize-none bg-transparent px-3 py-2 font-mono text-[12.5px] leading-6 text-zinc-200 outline-none placeholder:text-zinc-600"
      />
    );
  }

  if (item.contentType === "image" && item.blobPath) {
    return <StickyImage relPath={item.blobPath} />;
  }

  if (item.contentType === "hex_color" && item.content) {
    const value = item.content.trim();
    const color = value.startsWith("#") ? value : `#${value}`;
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        <div className="min-h-0 flex-1 rounded border border-edge" style={{ backgroundColor: color }} />
        <div className="select-text font-mono text-[13px] text-zinc-200">{color}</div>
      </div>
    );
  }

  return (
    <pre
      className={[
        "min-h-0 flex-1 select-text overflow-auto whitespace-pre-wrap break-words px-3 py-2 leading-5 text-zinc-200",
        MONO.has(item.contentType) ? "font-mono text-[12px]" : "font-ui text-[13px]",
      ].join(" ")}
    >
      {item.content}
    </pre>
  );
}

/** Same blob route as the list thumbnails; the object URL is revoked on unmount. */
function StickyImage({ relPath }: { relPath: string }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let revoked = false;
    let objectUrl: string | undefined;
    void readBlob(relPath)
      .then((blob) => {
        if (revoked) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [relPath]);

  if (!url) return <div className="flex-1" />;
  return <img src={url} alt="" className="min-h-0 flex-1 object-contain p-1" draggable={false} />;
}

function StripButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded px-1 leading-none text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
    >
      {children}
    </button>
  );
}

/** The paper swatches, dropped under the title strip. Any click outside it or
 *  Escape puts it away -- it only ever closes itself, never the card. */
function ColorPicker({
  current,
  onPick,
  onDismiss,
}: {
  current: string;
  onPick: (name: string) => void;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // The strip's Colour button is left to its own toggle; dismissing here as
    // well would close the picker on mousedown and reopen it on click.
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (ref.current?.contains(target) || target.closest("[data-color-toggle]")) return;
      onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onDismiss]);

  return (
    <div
      ref={ref}
      className="absolute right-1 top-[34px] z-10 flex gap-1 rounded-md border border-edge bg-panelalt p-1.5 shadow-lg"
    >
      {STICKY_PAPERS.map((p) => (
        <button
          key={p.name}
          title={p.label}
          aria-label={p.label}
          aria-pressed={p.name === current}
          onClick={() => onPick(p.name)}
          className={[
            "flex h-5 w-5 items-center justify-center rounded-full",
            p.name === current ? "ring-2 ring-zinc-400" : "hover:ring-1 hover:ring-zinc-500",
          ].join(" ")}
        >
          <Swatch fill={p.swatch} size="h-4 w-4" />
        </button>
      ))}
    </div>
  );
}

const WHEEL = `conic-gradient(${STICKY_PAPERS.filter((p) => p.panel)
  .map((p) => `rgb(${p.accent})`)
  .join(", ")}, rgb(${STICKY_PAPERS[1].accent}))`;

function Swatch({ fill, size = "h-2.5 w-2.5" }: { fill: string; size?: string }) {
  return <span className={`${size} block rounded-full border border-zinc-500`} style={{ background: fill }} />;
}

/** Any highlighted text, in the page or inside the note's textarea. */
function hasSelection(): boolean {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement) return el.selectionStart !== el.selectionEnd;
  return (window.getSelection()?.toString() ?? "") !== "";
}

function CopyIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3 w-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3 w-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.5 2.5l3 3L6 13H3v-3z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3 w-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
