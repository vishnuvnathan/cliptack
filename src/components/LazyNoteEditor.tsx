import { lazy, Suspense } from "react";
import type { RichNoteEditorProps } from "./RichNoteEditor";

// Tiptap, ProseMirror and the Markdown parser are most of the bundle, and only
// an open note needs them. Every window is its own webview parsing its own
// copy, so they load as a separate chunk rather than with the list.
const load = () => import("./RichNoteEditor");
const Editor = lazy(() => load().then((m) => ({ default: m.RichNoteEditor })));

/** Starts fetching the editor chunk; harmless to call more than once. */
export function preloadNoteEditor() {
  void load();
}

export function RichNoteEditor(props: RichNoteEditorProps) {
  return (
    <Suspense fallback={<div className="min-h-0 flex-1" />}>
      <Editor {...props} />
    </Suspense>
  );
}
