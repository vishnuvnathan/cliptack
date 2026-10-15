import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { readBlob } from "../lib/ipc";
import { isCredential, type Item } from "../lib/types";
import { useCliptack } from "../store/useCliptack";
import { CredentialCard } from "./CredentialCard";

/**
 * The right half of the list view.
 *
 * It renders straight from `items[selected]` with no IPC of its own:
 * `search_items` already returns each row's full `content`, so arrowing through
 * the list stays instant. The one exception is revealing a password, which is a
 * deliberate click.
 */
export function PreviewPane() {
  const items = useCliptack((s) => s.items);
  const selected = useCliptack((s) => s.selected);
  const folders = useCliptack((s) => s.folders);
  const openFolderMenu = useCliptack((s) => s.openFolderMenu);

  const item = items[selected];

  if (!item) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center text-[12px] text-zinc-600">
        Nothing selected
      </div>
    );
  }

  const folder = folders.find((f) => f.id === item.folderId);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-4 py-2">
        <span className="truncate text-[12px] text-zinc-100">{item.title || "(empty)"}</span>
        <span
          className={[
            "shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
            isCredential(item) ? "bg-accent/15 text-accent" : "bg-panelalt text-zinc-500",
          ].join(" ")}
        >
          {isCredential(item) ? "cred" : item.kind === "note" ? "note" : item.contentType}
        </span>
        {/* What `sort:used` ranks by. Shown only once it is non-zero, so a
            history full of "used 0×" does not add noise to every row. */}
        {item.useCount > 0 && (
          <span
            className="ml-auto shrink-0 text-[11px] tabular-nums text-zinc-500"
            title="Times copied or pasted from Cliptack. Rank by this with sort:used"
          >
            used {item.useCount}×
          </span>
        )}
        <button
          onClick={openFolderMenu}
          title="Move to folder (Ctrl+M)"
          className={[
            "shrink-0 truncate text-[11px] hover:text-zinc-200",
            folder ? "text-zinc-500" : "text-zinc-600",
            item.useCount > 0 ? "" : "ml-auto",
          ].join(" ")}
        >
          {folder ? folder.name : "Add to folder"}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <Body item={item} />
      </div>

      <Hints item={item} />
    </div>
  );
}

function Body({ item }: { item: Item }) {
  if (isCredential(item)) {
    return <CredentialCard item={item} />;
  }

  if (item.contentType === "image" && item.blobPath) {
    return <ImageBody relPath={item.blobPath} />;
  }

  if (item.kind === "note") {
    return (
      <div className="prose-cliptack text-[13px] leading-6 text-zinc-200">
        <ReactMarkdown>{item.content || "*This note is empty.*"}</ReactMarkdown>
      </div>
    );
  }

  return (
    <pre className="select-text whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.6] text-zinc-300">
      {item.content || ""}
    </pre>
  );
}

/** Same object-URL discipline as the row thumbnails: revoked on unmount. */
function ImageBody({ relPath }: { relPath: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;

    void readBlob(relPath)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [relPath]);

  if (!url) return <div className="h-32 rounded border border-edge bg-panelalt" />;
  return (
    <div>
      <img
        src={url}
        alt=""
        onLoad={(e) =>
          setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
        }
        className="max-h-full max-w-full rounded object-contain"
      />
      {/* The pixel size of what is on the clipboard, which the scaled-down
          preview cannot show. */}
      {size && (
        <p className="mt-2 text-[11px] tabular-nums text-zinc-500">
          {size.w} × {size.h} px
        </p>
      )}
    </div>
  );
}

function Hints({ item }: { item: Item }) {
  // Delete is on every variant. It is the one action with a consequence, and
  // the row's ✕ only shows on hover -- a keyboard user would otherwise never
  // meet it.
  const hints = isCredential(item)
    ? [
        ["↵", "username"],
        ["Ctrl+⇧+C", "password"],
        ["Ctrl+⇧+E", "edit"],
        ["Ctrl+M", "folder"],
        ["Ctrl+⌫", "delete"],
      ]
    : item.kind === "note"
      ? [
          ["↵", "copy"],
          ["Ctrl+⇧+E", "edit"],
          ["Ctrl+M", "folder"],
          ["Ctrl+⌫", "delete"],
        ]
      : [
          ["↵", "copy"],
          ["Ctrl+M", "folder"],
          ["Ctrl+⌫", "delete"],
        ];

  return (
    <div className="flex shrink-0 items-center gap-3 border-t border-edge px-4 py-2 text-[11px] text-zinc-500">
      {hints.map(([key, label]) => (
        <span key={label}>
          <span className="text-zinc-300">{key}</span> {label}
        </span>
      ))}
    </div>
  );
}
