import { useEffect, useState } from "react";

const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

const KEY_NAMES: Record<string, string> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/** "CommandOrControl+Shift+KeyV" -> "Ctrl + Shift + V". Display only. */
export function formatShortcut(value: string): string {
  return value
    .split("+")
    .map((token) => {
      const t = token.trim();
      switch (t.toLowerCase()) {
        case "commandorcontrol":
        case "cmdorctrl":
        case "commandorctrl":
        case "cmdorcontrol":
          return IS_MAC ? "⌘" : "Ctrl";
        case "ctrl":
        case "control":
          return "Ctrl";
        case "super":
        case "cmd":
        case "command":
          return IS_MAC ? "⌘" : "Win";
        case "alt":
        case "option":
          return IS_MAC ? "⌥" : "Alt";
        case "shift":
          return "Shift";
      }
      if (/^Key[A-Z]$/.test(t)) return t.slice(3);
      if (/^Digit[0-9]$/.test(t)) return t.slice(5);
      return KEY_NAMES[t] ?? t;
    })
    .join(" + ");
}

/**
 * The main key, as the backend names it.
 *
 * `event.code` is preferred over `event.key` so the recording does not depend
 * on the keyboard layout or on what Alt turns a letter into. It is empty for
 * keystrokes injected without a scan code -- remote-desktop clients, remapping
 * tools -- so those fall back to `key` for the cases that are unambiguous.
 */
function mainKey(e: KeyboardEvent): string | null {
  if (e.code) return e.code;
  if (/^[a-z]$/i.test(e.key)) return `Key${e.key.toUpperCase()}`;
  if (/^[0-9]$/.test(e.key)) return `Digit${e.key}`;
  if (/^F([1-9]|1[0-2])$/.test(e.key)) return e.key;
  return null;
}

/** Builds the string the backend parses from a keydown, or says why it cannot. */
function fromEvent(e: KeyboardEvent): { value?: string; hint?: string } {
  if (["Control", "Alt", "Shift", "Meta", "AltGraph"].includes(e.key)) return {};

  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");

  if (mods.length === 0) return { hint: "Hold Ctrl, Alt or Shift as well" };

  const key = mainKey(e);
  if (!key) return { hint: "That key cannot be used in a shortcut" };
  return { value: [...mods, key].join("+") };
}

/**
 * Click, press the combination, done. Escape cancels.
 *
 * `onChange` resolves to an error message when the backend refuses the key
 * (another app owns it, say); it is shown under the field and the previous
 * binding stays in force, so a failed attempt costs nothing.
 *
 * Stash's own current global shortcuts cannot be recorded: the OS delivers
 * them to Stash's handler rather than to this field.
 */
export function ShortcutRecorder({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => Promise<string | null>;
  label: string;
}) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;

    const onKeyDown = (e: KeyboardEvent) => {
      // Capture phase: nothing else in the panel may see these keys while a
      // combination is being recorded.
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        setRecording(false);
        setHint(null);
        return;
      }

      const result = fromEvent(e);
      if (result.hint) setHint(result.hint);
      if (!result.value) return;

      setRecording(false);
      setHint(null);
      void onChange(result.value).then(setError);
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recording, onChange]);

  return (
    <div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            setError(null);
            setHint(null);
            setRecording((r) => !r);
          }}
          onBlur={() => {
            setRecording(false);
            setHint(null);
          }}
          aria-label={`${label}: ${formatShortcut(value)}. Click to change.`}
          className={[
            "min-w-[9rem] rounded border px-3 py-1 text-left font-mono text-[12px] transition-colors",
            recording
              ? "border-accent/60 bg-accent/10 text-zinc-100"
              : "border-edge bg-panelalt text-zinc-200 hover:border-zinc-600",
          ].join(" ")}
        >
          {recording ? "Press a combination…" : formatShortcut(value)}
        </button>
        {recording && <span className="text-[11px] text-zinc-600">Esc cancels</span>}
      </div>
      {hint && <p className="mt-1 text-[11px] text-zinc-500">{hint}</p>}
      {error && <p className="mt-1 text-[11px] leading-4 text-red-400">{error}</p>}
    </div>
  );
}
