import { isHelpKey, useBackKeys } from "../lib/useBackKeys";
import { useStash } from "../store/useStash";
import { formatShortcut } from "./ShortcutRecorder";

interface Row {
  keys: string;
  does: string;
}

const GROUPS: Array<{ title: string; rows: Row[] }> = [
  {
    title: "Browsing",
    rows: [
      { keys: "↑ / ↓", does: "Move the selection" },
      { keys: "Enter", does: "Paste the selection into the app you came from" },
      { keys: "Ctrl+Enter", does: "Copy the selection without pasting" },
      { keys: "Ctrl+T", does: "Paste as… (transform the text first)" },
      { keys: "Alt+1…9", does: "Show only the folder at that position" },
      { keys: "Alt+0", does: "Clear the folder filter" },
      { keys: "Esc", does: "Hide the panel" },
    ],
  },
  {
    title: "Managing items",
    rows: [
      { keys: "Ctrl+N", does: "New note" },
      { keys: "Ctrl+K", does: "New credential" },
      { keys: "Ctrl+Shift+E", does: "Edit the selected note or credential" },
      { keys: "Ctrl+P", does: "Pin / unpin" },
      { keys: "Ctrl+O", does: "Pop out as an always-on-top sticky" },
      { keys: "Ctrl+M", does: "Move to a folder" },
      { keys: "Ctrl+Backspace", does: "Delete" },
      { keys: "Ctrl+Z", does: "Undo the last delete" },
    ],
  },
  {
    title: "Credentials",
    rows: [
      { keys: "Ctrl+Shift+Enter", does: "Paste the password (only into a password field)" },
      { keys: "Ctrl+Shift+C", does: "Copy the password" },
      { keys: "Ctrl+Shift+U", does: "Reveal / hide the password" },
    ],
  },
  {
    title: "Windows",
    rows: [
      { keys: "Ctrl+,", does: "Open settings (press again, or Esc, to go back)" },
      { keys: "F1 or Ctrl+/", does: "Show this list (press again, or Esc, to go back)" },
    ],
  },
];

export function HelpView() {
  const settings = useStash((s) => s.settings);
  const setView = useStash((s) => s.setView);
  useBackKeys(isHelpKey);

  const globals: Row[] = [];
  if (settings) {
    globals.push({
      keys: formatShortcut(settings.toggleShortcut),
      does: "Show / hide Stash from anywhere",
    });
    if (settings.captureMode === "shortcut") {
      globals.push({
        keys: formatShortcut(settings.captureShortcut),
        does: "Copy the selection and save it to Stash",
      });
    }
  }

  const groups = globals.length
    ? [{ title: "Anywhere (global)", rows: globals }, ...GROUPS]
    : GROUPS;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-edge px-4 py-3">
        <h1 className="text-[15px] text-zinc-100">Keyboard shortcuts</h1>
        <button
          onClick={() => setView("list")}
          className="rounded border border-edge px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
        >
          Back (Esc)
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {groups.map((g) => (
          <section key={g.title} className="pb-4">
            <h2 className="text-[13px] text-zinc-200">{g.title}</h2>
            <ul className="mt-1.5 space-y-1">
              {g.rows.map((r) => (
                <li key={r.keys + r.does} className="flex items-baseline gap-3 text-[12px]">
                  <kbd className="w-36 shrink-0 font-mono text-zinc-300">{r.keys}</kbd>
                  <span className="text-zinc-500">{r.does}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <p className="text-[11px] text-zinc-600">
          Change the global shortcuts in Settings.
        </p>
      </div>
    </div>
  );
}
