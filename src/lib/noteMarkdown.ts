import type { Editor, Extensions } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

/**
 * A link whose text is its own address is written back bare. The stock
 * renderer turns every one into `[https://x](https://x)`, which is what a
 * plain-text paste of the note would then show.
 */
const BareLink = Link.extend({
  renderMarkdown: (node, h, ctx) => {
    const href = (node.attrs?.href as string | undefined) ?? "";
    const text = h.renderChildren(node);
    return ctx?.meta?.markText === href && !node.attrs?.title ? text : `[${text}](${href})`;
  },
});

/**
 * Everything the note editor understands. Notes are stored as Markdown, so this
 * is deliberately only what Markdown can hold: no colour, size, font, alignment
 * or underline. Tables have no toolbar button but are here so a note that has
 * one does not lose it -- without the extension the parser drops tables whole.
 */
export function noteExtensions(placeholder: string): Extensions {
  return [
    StarterKit.configure({ underline: false, link: false }),
    BareLink.configure({ openOnClick: false, autolink: true, defaultProtocol: "https" }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit,
    Placeholder.configure({ placeholder }),
    Markdown,
  ];
}

/** The editor's Markdown, without the blank lines it leaves after a final block. */
export function readMarkdown(editor: Editor): string {
  return editor.getMarkdown().replace(/\n+$/, "");
}

/**
 * Whether loading `before` into the editor and writing it out again (`after`)
 * dropped anything. The editor rewrites syntax freely -- `*` bullets become `-`,
 * table cells get padded -- but must never lose a letter or digit. It does lose
 * them for what it cannot show, such as an image's address or raw HTML tags, so
 * a note like that stays in Markdown source rather than being quietly cut down
 * by the first keystroke.
 */
export function losesContent(before: string, after: string): boolean {
  const counts = new Map<string, number>();
  for (const ch of after.match(/[\p{L}\p{N}]/gu) ?? []) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  for (const ch of before.match(/[\p{L}\p{N}]/gu) ?? []) {
    const left = counts.get(ch) ?? 0;
    if (left === 0) return true;
    counts.set(ch, left - 1);
  }
  return false;
}
