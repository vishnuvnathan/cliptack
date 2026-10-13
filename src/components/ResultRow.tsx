import { memo, useEffect, useState } from "react";
import { readBlob } from "../lib/ipc";
import type { ContentType, Item } from "../lib/types";

const TYPE_LABEL: Record<ContentType, string> = {
  url: "link",
  hex_color: "color",
  json: "json",
  code: "code",
  email: "email",
  path: "path",
  image: "image",
  text: "text",
  markdown: "note",
  credential: "cred",
};

interface Props {
  item: Item;
  active: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  /** Takes the id rather than closing over the row, so the store action can be
      passed straight through without a new identity on every render. */
  onDelete: (id: string) => void;
  onPopOut: (id: string) => void;
}

/**
 * Memoised on identity: the virtualizer re-renders the window on every scroll
 * frame, and only the row entering or leaving selection should actually update.
 */
export const ResultRow = memo(function ResultRow({
  item,
  active,
  onClick,
  onDoubleClick,
  onDelete,
  onPopOut,
}: Props) {
  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={[
        "group flex h-14 cursor-default items-center gap-3 border-l-2 px-4",
        active
          ? "border-l-accent bg-accent/10"
          : "border-l-transparent hover:bg-panelalt",
      ].join(" ")}
    >
      <Preview item={item} />

      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] leading-5 text-zinc-100">
          {item.title || "(empty)"}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] leading-4 text-zinc-500">
          <span>{TYPE_LABEL[item.contentType]}</span>
          {item.sourceApp && (
            <>
              <span aria-hidden="true">&middot;</span>
              <span className="truncate">{item.sourceApp}</span>
            </>
          )}
          <span aria-hidden="true">&middot;</span>
          <span>{relativeTime(item.updatedAt)}</span>
        </div>
      </div>

      {item.pinned && <PinIcon />}

      {/* Not offered on a credential at all, rather than offered and refused:
          a password is never put on screen, so there is no choice to make. */}
      {item.contentType !== "credential" && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onPopOut(item.id);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          title="Pop out to screen (Ctrl+O)"
          aria-label={`Pop ${item.title || "item"} out to screen`}
          className="shrink-0 rounded p-1 leading-none text-zinc-600 opacity-0 transition hover:bg-zinc-800 hover:text-zinc-200 focus-visible:opacity-100 group-hover:opacity-100"
        >
          <PopOutIcon />
        </button>
      )}

      {/*
        Delete was keyboard-only for its whole life, which made it effectively
        invisible -- the binding is not something you discover by using the app.
        stopPropagation is load-bearing twice over: without it the click also
        selects the row, and the second half of a double-click would land on
        whichever row slid up to take this one's place.
      */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete(item.id);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        title="Delete (Ctrl+Backspace)"
        aria-label={`Delete ${item.title || "item"}`}
        className="shrink-0 rounded p-1 leading-none text-zinc-600 opacity-0 transition hover:bg-zinc-800 hover:text-zinc-200 focus-visible:opacity-100 group-hover:opacity-100"
      >
        <CloseIcon />
      </button>
    </div>
  );
});

function Preview({ item }: { item: Item }) {
  if (item.contentType === "credential") {
    return (
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-accent/40 bg-accent/10 text-accent">
        <KeyIcon />
      </div>
    );
  }
  if (item.contentType === "image" && item.blobPath) {
    return <Thumbnail relPath={item.blobPath} />;
  }
  if (item.contentType === "hex_color" && item.content) {
    const color = item.content.trim().startsWith("#")
      ? item.content.trim()
      : `#${item.content.trim()}`;
    return (
      <div
        className="h-8 w-8 shrink-0 rounded border border-edge"
        style={{ backgroundColor: color }}
      />
    );
  }
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-edge bg-panelalt text-[10px] uppercase text-zinc-500">
      {item.kind === "note" ? "md" : TYPE_LABEL[item.contentType].slice(0, 3)}
    </div>
  );
}

/**
 * Thumbnails are fetched through the `read_blob` command rather than a file
 * URL, so the webview never needs filesystem access. The object URL is revoked
 * on unmount so scrolling a long list does not leak blobs.
 */
function Thumbnail({ relPath }: { relPath: string }) {
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

  if (!url) {
    return <div className="h-8 w-8 shrink-0 rounded border border-edge bg-panelalt" />;
  }
  return (
    <img
      src={url}
      alt=""
      className="h-8 w-8 shrink-0 rounded border border-edge object-cover"
    />
  );
}

function KeyIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-[15px] w-[15px]"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="15" r="4" />
      <path d="M10.9 12.1L20 3M17 6l2 2M14 9l2 2" />
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

function PopOutIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3 w-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 2h5v5M14 2L7.5 8.5M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 shrink-0 text-accent"
      fill="currentColor"
      aria-label="Pinned"
    >
      <path d="M6 1h4l-.5 4.5 2.5 2v1H8.5V14L8 15l-.5-1V8.5H4v-1l2.5-2L6 1Z" />
    </svg>
  );
}

function relativeTime(ms: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
