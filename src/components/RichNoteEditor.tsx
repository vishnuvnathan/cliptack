import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Extension, type Editor } from "@tiptap/core";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { losesContent, noteExtensions, readMarkdown } from "../lib/noteMarkdown";

/**
 * A note body, edited as formatted text or as its Markdown source. Either way
 * the value in and out is Markdown -- that is what is stored, searched, copied
 * and exported, so the editor is a view onto it and never the other way round.
 *
 * The panel gets a toolbar; a sticky gets the same commands in a bubble over
 * the selection, because a full toolbar would cover a good part of a small card.
 */
export interface RichNoteEditorProps {
  value: string;
  onChange: (markdown: string) => void;
  /** Showing the Markdown source instead of the formatted view. */
  source: boolean;
  onSourceChange: (source: boolean) => void;
  variant: "panel" | "sticky";
  autoFocus?: boolean;
}

export function RichNoteEditor({
  value,
  onChange,
  source,
  onSourceChange,
  variant,
  autoFocus = false,
}: RichNoteEditorProps) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // The Markdown the editor holds, as last loaded into it or written out of it.
  // A `value` equal to this is our own edit coming back, and reloading it would
  // move the caret; anything else came from outside and replaces the content.
  // `null` when the editor holds nothing that matches the note.
  const shown = useRef<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const openLink = useRef(() => setLinking(true));
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const extensions = useMemo(
    () => [
      ...noteExtensions(variant === "panel" ? "Write something…  # heading, - list, [ ] task" : "Write something…"),
      // Ctrl+E is the source toggle in both editors (handled by their own key
      // listeners, which still see the event). Taken here first so the stock
      // inline-code binding on the same key does not also fire.
      Extension.create({
        name: "cliptackKeys",
        priority: 1000,
        addKeyboardShortcuts: () => ({
          "Mod-e": () => true,
          "Mod-k": () => {
            openLink.current();
            return true;
          },
        }),
      }),
    ],
    [variant],
  );

  const editor = useEditor({
    extensions,
    editorProps: {
      attributes: {
        class: [
          "note-editor prose-cliptack text-[13px] leading-6 text-zinc-200",
          variant === "panel" ? "px-4 py-3" : "px-3 py-2",
        ].join(" "),
      },
    },
    onUpdate: ({ editor }) => {
      const markdown = readMarkdown(editor);
      shown.current = markdown;
      onChangeRef.current(markdown);
    },
  });

  // Loads outside changes, and checks each one survives the trip: a note with
  // an image or raw HTML would be cut down by the first edit, so it stays in
  // source instead, and is checked again whenever the user switches back.
  useEffect(() => {
    if (!alive(editor) || source || value === shown.current) return;
    editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
    if (losesContent(value, readMarkdown(editor))) {
      shown.current = null;
      setNotice("This note has Markdown the editor can't show (an image or HTML), so it stays as source.");
      onSourceChange(true);
      return;
    }
    shown.current = value;
    setNotice(null);
  }, [editor, value, source, onSourceChange]);

  useEffect(() => {
    if (!autoFocus) return;
    if (source) textareaRef.current?.focus();
    else if (alive(editor)) editor.commands.focus("end");
  }, [autoFocus, source, editor]);

  useEffect(() => {
    if (source) setLinking(false);
  }, [source]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {variant === "panel" && alive(editor) && !source && <Toolbar editor={editor} onLink={() => setLinking(true)} />}
      {linking && alive(editor) && <LinkField editor={editor} onDone={() => setLinking(false)} />}
      {source && notice && (
        <div className="shrink-0 border-b border-edge bg-panelalt px-3 py-1.5 text-[11px] text-zinc-400">{notice}</div>
      )}

      <EditorContent
        editor={editor}
        className={source ? "hidden" : "min-h-0 flex-1 cursor-text overflow-y-auto"}
        onMouseDown={(e) => {
          // A click in the empty space under the last line still puts the caret
          // in the note, as it did in the textarea this replaced.
          if (e.target === e.currentTarget) {
            e.preventDefault();
            editor?.commands.focus("end");
          }
        }}
      />
      {source && (
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChangeRef.current(e.target.value)}
          placeholder="Markdown…"
          spellCheck={false}
          className={[
            "min-h-0 flex-1 resize-none bg-transparent font-mono leading-6 text-zinc-200 outline-none placeholder:text-zinc-600",
            variant === "panel" ? "px-4 py-3 text-[13px]" : "px-3 py-2 text-[12.5px]",
          ].join(" ")}
        />
      )}

      {variant === "sticky" && alive(editor) && !source && (
        <BubbleMenu
          editor={editor}
          className="flex items-center gap-0.5 rounded-md border border-edge bg-panelalt p-0.5 shadow-lg"
        >
          <FormatButtons editor={editor} onLink={() => setLinking(true)} compact />
        </BubbleMenu>
      )}
    </div>
  );
}

/**
 * `useEditor` tears down the instance it made during render if the component
 * has not committed within a millisecond, and hands over a fresh one. A slow
 * first commit -- this module arrives lazily, under Suspense -- is enough, and
 * effects in that commit still hold the dead instance. They skip it and run
 * again when the replacement arrives.
 */
function alive(editor: Editor | null): editor is Editor {
  return !!editor && !editor.isDestroyed;
}

function Toolbar({ editor, onLink }: { editor: Editor; onLink: () => void }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-edge px-3 py-1">
      <FormatButtons editor={editor} onLink={onLink} />
    </div>
  );
}

/** Shared by the panel toolbar and the sticky's bubble; `compact` is the bubble's cut. */
function FormatButtons({ editor, onLink, compact = false }: { editor: Editor; onLink: () => void; compact?: boolean }) {
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      h1: e.isActive("heading", { level: 1 }),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      task: e.isActive("taskList"),
      quote: e.isActive("blockquote"),
      codeBlock: e.isActive("codeBlock"),
      link: e.isActive("link"),
    }),
  });
  if (!active) return null;

  const chain = () => editor.chain().focus();

  return (
    <>
      <Btn title="Bold (Ctrl+B)" on={active.bold} run={() => chain().toggleBold().run()}>
        <span className="font-bold">B</span>
      </Btn>
      <Btn title="Italic (Ctrl+I)" on={active.italic} run={() => chain().toggleItalic().run()}>
        <span className="font-serif italic">I</span>
      </Btn>
      <Btn title="Strikethrough (Ctrl+Shift+S)" on={active.strike} run={() => chain().toggleStrike().run()}>
        <span className="line-through">S</span>
      </Btn>
      <Btn title="Inline code (`text`)" on={active.code} run={() => chain().toggleCode().run()}>
        <CodeIcon />
      </Btn>
      <Sep />
      {compact ? (
        <Btn title="Heading" on={active.h2} run={() => chain().toggleHeading({ level: 2 }).run()}>
          <span className="text-[11px] font-semibold">H</span>
        </Btn>
      ) : (
        ([1, 2, 3] as const).map((level) => (
          <Btn
            key={level}
            title={`Heading ${level} (${"#".repeat(level)} then space)`}
            on={active[`h${level}`]}
            run={() => chain().toggleHeading({ level }).run()}
          >
            <span className="text-[11px] font-semibold">H{level}</span>
          </Btn>
        ))
      )}
      <Sep />
      <Btn title="Bulleted list (- then space)" on={active.bullet} run={() => chain().toggleBulletList().run()}>
        <BulletIcon />
      </Btn>
      {!compact && (
        <Btn title="Numbered list (1. then space)" on={active.ordered} run={() => chain().toggleOrderedList().run()}>
          <NumberIcon />
        </Btn>
      )}
      <Btn title="Checklist ([ ] then space)" on={active.task} run={() => chain().toggleTaskList().run()}>
        <TaskIcon />
      </Btn>
      {!compact && (
        <>
          <Sep />
          <Btn title="Quote (> then space)" on={active.quote} run={() => chain().toggleBlockquote().run()}>
            <QuoteIcon />
          </Btn>
          <Btn title="Code block (``` then space)" on={active.codeBlock} run={() => chain().toggleCodeBlock().run()}>
            <CodeBlockIcon />
          </Btn>
          <Btn title="Divider (--- )" on={false} run={() => chain().setHorizontalRule().run()}>
            <RuleIcon />
          </Btn>
        </>
      )}
      <Sep />
      <Btn title="Link (Ctrl+K)" on={active.link} run={onLink}>
        <LinkIcon />
      </Btn>
    </>
  );
}

/**
 * Edits the link at the caret, or makes one: from the selection if there is
 * one, otherwise by inserting the address itself. Empty removes the link.
 */
function LinkField({ editor, onDone }: { editor: Editor; onDone: () => void }) {
  const existing = (editor.getAttributes("link").href as string | undefined) ?? "";
  const [href, setHref] = useState(existing);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const apply = useCallback(() => {
    const raw = href.trim();
    if (!raw) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    } else {
      // "example.com" means the website, not a relative path in no document.
      const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#") ? raw : `https://${raw}`;
      if (editor.state.selection.empty && !editor.isActive("link")) {
        editor
          .chain()
          .focus()
          .insertContent({ type: "text", text: raw, marks: [{ type: "link", attrs: { href: url } }] })
          .run();
      } else {
        editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
      }
    }
    onDone();
  }, [editor, href, onDone]);

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-edge bg-panelalt px-3 py-1">
      <LinkIcon />
      <input
        ref={inputRef}
        value={href}
        onChange={(e) => setHref(e.target.value)}
        onKeyDown={(e) => {
          // Kept from the editor's own Escape, which in the panel goes back
          // to the list.
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            apply();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            editor.commands.focus();
            onDone();
          }
        }}
        placeholder="https://…  (Enter to apply, empty to remove)"
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent text-[12px] text-zinc-200 outline-none placeholder:text-zinc-500"
      />
      {existing && (
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            editor.chain().focus().extendMarkRange("link").unsetLink().run();
            onDone();
          }}
          className="text-[11px] text-zinc-500 hover:text-zinc-200"
        >
          Remove
        </button>
      )}
    </div>
  );
}

function Btn({
  title,
  on,
  run,
  children,
}: {
  title: string;
  on: boolean;
  run: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={on}
      // Keeps focus (and the selection) in the editor while the button is pressed.
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
      className={[
        "flex h-6 min-w-6 items-center justify-center rounded px-1 text-[12px] leading-none transition-colors",
        on ? "bg-accent/20 text-accent" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <span className="mx-0.5 h-4 w-px bg-edge" aria-hidden="true" />;
}

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const CodeIcon = () => (
  <Icon>
    <path d="M6 4L2 8l4 4M10 4l4 4-4 4" />
  </Icon>
);
const BulletIcon = () => (
  <Icon>
    <circle cx="3" cy="4" r="0.8" fill="currentColor" />
    <circle cx="3" cy="8" r="0.8" fill="currentColor" />
    <circle cx="3" cy="12" r="0.8" fill="currentColor" />
    <path d="M6 4h8M6 8h8M6 12h8" />
  </Icon>
);
const NumberIcon = () => (
  <Icon>
    <path d="M2 3h1v3M2 6h2M2 10h2l-2 2.5h2M6 4.5h8M6 11h8" />
  </Icon>
);
const TaskIcon = () => (
  <Icon>
    <rect x="2" y="2.5" width="4" height="4" rx="0.8" />
    <path d="M2.8 11.2l1 1 1.8-2.2" />
    <path d="M8 4.5h6M8 11h6" />
  </Icon>
);
const QuoteIcon = () => (
  <Icon>
    <path d="M3 3v10M6 5h8M6 8h8M6 11h5" />
  </Icon>
);
const CodeBlockIcon = () => (
  <Icon>
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
    <path d="M6 6.5L4.5 8 6 9.5M10 6.5l1.5 1.5L10 9.5" />
  </Icon>
);
const RuleIcon = () => (
  <Icon>
    <path d="M2 8h12" />
  </Icon>
);
const LinkIcon = () => (
  <Icon>
    <path d="M7 9a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.6.6M9 7a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.6-.6" />
  </Icon>
);
