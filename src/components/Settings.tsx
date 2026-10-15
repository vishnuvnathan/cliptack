import { useEffect, useState } from "react";
import { BackupSection } from "./BackupSection";
import { ShortcutRecorder } from "./ShortcutRecorder";
import { securityInfo, setCaptureExclusion } from "../lib/ipc";
import { isSettingsKey, useBackKeys } from "../lib/useBackKeys";
import { ACCENT_PRESETS, isHex } from "../lib/theme";
import type { CaptureStatus, SecurityInfo, ThemeMode } from "../lib/types";
import { useCliptack } from "../store/useCliptack";

export function Settings() {
  const settings = useCliptack((s) => s.settings);
  const updateSettings = useCliptack((s) => s.updateSettings);
  const setView = useCliptack((s) => s.setView);
  useBackKeys(isSettingsKey);

  const [capture, setCapture] = useState<CaptureStatus | null>(null);
  const [security, setSecurity] = useState<SecurityInfo | null>(null);

  // Ask the backend what the platform can actually do, so the toggle below can
  // say "unsupported here" instead of pretending to work.
  useEffect(() => {
    if (!settings) return;
    void setCaptureExclusion(settings.captureExclusion)
      .then(setCapture)
      .catch(() => undefined);
  }, [settings?.captureExclusion]);

  // Platform facts, not preferences: whether secrets are really encrypted and
  // whether pasting can work at all. Fetched once.
  useEffect(() => {
    void securityInfo().then(setSecurity).catch(() => undefined);
  }, []);

  if (!settings) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-zinc-600">
        Loading settings…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-edge px-4 py-3">
        <h1 className="text-[15px] text-zinc-100">Settings</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setView("help")}
            className="rounded border border-edge px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
          >
            All shortcuts
          </button>
          <button
            onClick={() => setView("list")}
            className="rounded border border-edge px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
          >
            Back (Esc)
          </button>
        </div>
      </div>

      {/* min-h-0 on both levels, for the reason spelled out in App.tsx: a
          flex-1 child defaults to min-height:auto, so it grows to fit its
          content instead of shrinking, and the overflow-y-auto below it
          then has nothing to scroll. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <AppearanceSection />

        <ShortcutsSection pasteSupported={security ? security.pasteSupported : true} />

        <Toggle
          label="Paste directly into the active app"
          description={pasteDescription(security)}
          checked={settings.autoPaste}
          disabled={security ? !security.pasteSupported : false}
          onChange={(v) => void updateSettings({ autoPaste: v })}
        />

        <Toggle
          label="Hide Cliptack from screen capture"
          description={captureDescription(capture)}
          checked={settings.captureExclusion}
          disabled={capture ? !capture.supported : false}
          onChange={(v) => void updateSettings({ captureExclusion: v })}
        />

        <Toggle
          label="Reopen the panel where I left it"
          description="Off: the panel centres on the monitor under your cursor each time. On: it returns to the last place you dragged it."
          checked={settings.rememberPosition}
          onChange={(v) => void updateSettings({ rememberPosition: v })}
        />

        <Toggle
          label="Launch on startup"
          description="Start Cliptack with Windows, straight to the tray."
          checked={settings.launchOnStartup}
          onChange={(v) => void updateSettings({ launchOnStartup: v })}
        />

        <FolderList />

        <BackupSection />

        <CredentialSecurityNote encrypted={security?.secretsEncrypted ?? null} />

        <HistorySection />

        <div className="mt-5 border-t border-edge pt-3 text-[11px] leading-5 text-zinc-600">
          <p>Everything stays on this machine. Cliptack makes no network requests.</p>
        </div>
      </div>
    </div>
  );
}

/**
 * The two global shortcuts, and the choice of what gets saved.
 *
 * Changes go through `updateSettings` with `quiet`, so a refusal (the key
 * belongs to another app, say) shows up under the field that caused it instead
 * of in the panel-wide error banner, and the previous binding stays registered.
 */
function ShortcutsSection({ pasteSupported }: { pasteSupported: boolean }) {
  const settings = useCliptack((s) => s.settings);
  const updateSettings = useCliptack((s) => s.updateSettings);

  if (!settings) return null;

  const shortcutMode = settings.captureMode === "shortcut";

  return (
    <div className="pb-2">
      <h2 className="text-[13px] text-zinc-200">Shortcuts</h2>

      <p className="mt-2 text-[12px] text-zinc-400">Open Cliptack</p>
      <div className="mt-1">
        <ShortcutRecorder
          label="Open Cliptack"
          value={settings.toggleShortcut}
          onChange={(value) => updateSettings({ toggleShortcut: value }, { quiet: true })}
        />
      </div>

      <p className="mt-4 text-[12px] text-zinc-400">Hide or show stickies</p>
      <div className="mt-1 flex items-start gap-2">
        <ShortcutRecorder
          label="Hide or show stickies"
          value={settings.stickiesShortcut}
          onChange={(value) => updateSettings({ stickiesShortcut: value }, { quiet: true })}
        />
        {settings.stickiesShortcut && (
          <button
            onClick={() => void updateSettings({ stickiesShortcut: "" }, { quiet: true })}
            className="rounded px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-300"
          >
            Turn off
          </button>
        )}
      </div>
      <p className="mt-1.5 text-[11px] leading-4 text-zinc-600">
        Clears every sticky off the screen, say before a screen share, and brings them back. Also in
        the tray menu. Off until you pick a key, so it never takes one from another app.
      </p>

      <p className="mt-4 text-[12px] text-zinc-400">What Cliptack saves</p>
      <div className="mt-1.5 space-y-1.5" role="radiogroup" aria-label="What Cliptack saves">
        <CaptureOption
          checked={!shortcutMode}
          title="Everything I copy"
          description="Every copy is saved to history automatically."
          onSelect={() => void updateSettings({ captureMode: "auto" }, { quiet: true })}
        />
        <CaptureOption
          checked={shortcutMode}
          title="Only what I choose"
          description={
            pasteSupported
              ? "Ordinary copies are not saved. Select something and press the shortcut below: Cliptack copies it and keeps it."
              : "Ordinary copies are not saved. Press the shortcut below, then copy what you want kept within a couple of seconds."
          }
          onSelect={() => void updateSettings({ captureMode: "shortcut" }, { quiet: true })}
        />
      </div>

      {shortcutMode && (
        <div className="mt-3">
          <p className="text-[12px] text-zinc-400">Copy and save</p>
          <div className="mt-1">
            <ShortcutRecorder
              label="Copy and save"
              value={settings.captureShortcut}
              onChange={(value) => updateSettings({ captureShortcut: value }, { quiet: true })}
            />
          </div>
          <p className="mt-1.5 text-[11px] leading-4 text-zinc-600">
            Anything a password manager marks private is still never saved. Notes,
            credentials and items already in history are unaffected.
          </p>
        </div>
      )}

      <div className="mt-4 border-t border-edge" />
    </div>
  );
}

function CaptureOption({
  checked,
  title,
  description,
  onSelect,
}: {
  checked: boolean;
  title: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input
        type="radio"
        name="capture-mode"
        checked={checked}
        onChange={onSelect}
        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-accent"
      />
      <span className="min-w-0">
        <span className="block text-[12px] text-zinc-200">{title}</span>
        <span className="block text-[11px] leading-4 text-zinc-500">{description}</span>
      </span>
    </label>
  );
}

const THEME_CHOICES: { id: ThemeMode; label: string }[] = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
  { id: "system", label: "System" },
];

/**
 * Theme and accent. Both apply the instant they change: updateSettings sets
 * the store optimistically, and useTheme in App restyles from there, so there
 * is no save step to forget.
 */
function AppearanceSection() {
  const settings = useCliptack((s) => s.settings);
  const updateSettings = useCliptack((s) => s.updateSettings);
  const [draft, setDraft] = useState(settings?.accent ?? "");

  // Keep the field in step when a swatch (or a rejected save) changes the value.
  useEffect(() => {
    if (settings) setDraft(settings.accent);
  }, [settings?.accent]);

  if (!settings) return null;

  const commitDraft = (value: string) => {
    const hex = value.startsWith("#") ? value : `#${value}`;
    if (isHex(hex)) void updateSettings({ accent: hex.toLowerCase() });
  };

  return (
    <div className="pb-2">
      <h2 className="text-[13px] text-zinc-200">Appearance</h2>

      <div className="mt-2 inline-flex rounded border border-edge p-0.5" role="radiogroup" aria-label="Theme">
        {THEME_CHOICES.map((choice) => (
          <button
            key={choice.id}
            role="radio"
            aria-checked={settings.theme === choice.id}
            onClick={() => void updateSettings({ theme: choice.id })}
            className={[
              "rounded px-3 py-1 text-[12px] transition-colors",
              settings.theme === choice.id
                ? "bg-accent/20 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-200",
            ].join(" ")}
          >
            {choice.label}
          </button>
        ))}
      </div>
      {settings.theme === "system" && (
        <p className="mt-1 text-[11px] text-zinc-600">Follows your Windows light/dark setting.</p>
      )}

      <p className="mt-3 text-[12px] text-zinc-400">Accent colour</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {ACCENT_PRESETS.map((preset) => {
          const active = settings.accent.toLowerCase() === preset.hex;
          return (
            <button
              key={preset.hex}
              title={preset.name}
              aria-label={preset.name}
              aria-pressed={active}
              onClick={() => void updateSettings({ accent: preset.hex })}
              style={{ backgroundColor: preset.hex }}
              className={[
                "h-5 w-5 rounded-full border",
                active ? "border-zinc-100 ring-2 ring-zinc-500" : "border-edge",
              ].join(" ")}
            />
          );
        })}
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            // Apply as soon as it is a complete colour; partial input is left
            // alone rather than flashing the default.
            const v = e.target.value.trim();
            commitDraft(v);
          }}
          onBlur={() => setDraft(settings.accent)}
          onKeyDown={(e) => e.stopPropagation()}
          spellCheck={false}
          maxLength={7}
          aria-label="Custom accent colour"
          placeholder="#7aa2f7"
          className={[
            "w-20 rounded border bg-panelalt px-2 py-0.5 font-mono text-[11px] text-zinc-200 outline-none",
            draft && !isHex(draft.startsWith("#") ? draft : `#${draft}`)
              ? "border-red-900"
              : "border-edge focus:border-accent/60",
          ].join(" ")}
        />
      </div>

      <div className="mt-4 border-t border-edge" />
    </div>
  );
}

/**
 * The retention rules, stated, plus the button that applies them now.
 *
 * Paired deliberately: the paragraph explaining what is pruned automatically is
 * exactly the explanation the button needs, and splitting them would mean
 * writing the same sentence twice.
 *
 * No undo here. The undo bar carries a single item; this is a few hundred, and
 * a confirm reporting a real count is the honest trade. The 24-hour grace
 * window still applies underneath — nothing is unlinked from disk immediately.
 */
function HistorySection() {
  const clearClipHistory = useCliptack((s) => s.clearClipHistory);
  const [confirming, setConfirming] = useState(false);
  const [cleared, setCleared] = useState<number | null>(null);

  return (
    <div className="mt-5 border-t border-edge pt-3">
      <h2 className="text-[13px] text-zinc-200">History</h2>
      <p className="mt-1 text-[11px] leading-4 text-zinc-600">
        Cliptack keeps the newest 1000 unpinned clips. Pinned items, notes and
        credentials are never pruned — and clearing below leaves them too.
      </p>

      <div className="mt-2 flex items-center gap-2">
        {confirming ? (
          <>
            <span className="text-[11px] text-zinc-500">Delete all captured clips?</span>
            <button
              onClick={() => {
                setConfirming(false);
                void clearClipHistory().then(setCleared);
              }}
              className="text-[11px] text-red-400 hover:text-red-300"
            >
              Clear
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="text-[11px] text-zinc-500 hover:text-zinc-200"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            onClick={() => {
              setCleared(null);
              setConfirming(true);
            }}
            className="rounded border border-edge px-2 py-1 text-[11px] text-zinc-400 transition-colors hover:border-red-900 hover:text-red-400"
          >
            Clear clip history
          </button>
        )}

        {cleared !== null && (
          <span className="text-[11px] text-zinc-500">
            {cleared === 0
              ? "Nothing to clear."
              : `Cleared ${cleared} clip${cleared === 1 ? "" : "s"}.`}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Rename and delete only. Creating one lives on the chip row, where you are
 * when you realise you want it.
 */
function FolderList() {
  const folders = useCliptack((s) => s.folders);
  const renameFolder = useCliptack((s) => s.renameFolder);
  const deleteFolder = useCliptack((s) => s.deleteFolder);

  if (folders.length === 0) {
    return (
      <div className="mt-5 border-t border-edge pt-3">
        <h2 className="text-[13px] text-zinc-200">Folders</h2>
        <p className="mt-1.5 text-[11px] text-zinc-600">
          None yet. Use the + on the filter row to add one.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-5 border-t border-edge pt-3">
      <h2 className="text-[13px] text-zinc-200">Folders</h2>
      <p className="mt-1 text-[11px] leading-4 text-zinc-600">
        Deleting a folder unfiles its items. Nothing is lost.
      </p>

      <ul className="mt-2 space-y-1">
        {folders.map((folder) => (
          <FolderRow
            key={folder.id}
            id={folder.id}
            name={folder.name}
            onRename={renameFolder}
            onDelete={deleteFolder}
          />
        ))}
      </ul>
    </div>
  );
}

/**
 * Rename and delete are inline rather than `window.prompt`/`confirm`: those are
 * unreliable inside a WebView2 host, and a dialog that silently returns null
 * would look like a dead button.
 */
function FolderRow({
  id,
  name,
  onRename,
  onDelete,
}: {
  id: string;
  name: string;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [confirming, setConfirming] = useState(false);

  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== name) void onRename(id, draft);
    else setDraft(name);
  };

  return (
    <li className="flex items-center gap-2 rounded border border-edge bg-panelalt px-2.5 py-1.5">
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft(name);
              setEditing(false);
            }
          }}
          className="min-w-0 flex-1 rounded border border-accent/60 bg-transparent px-1.5 py-0.5 text-[12px] text-zinc-100 outline-none"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-200">{name}</span>
      )}

      {confirming ? (
        <>
          <span className="shrink-0 text-[11px] text-zinc-500">Items stay.</span>
          <button
            onClick={() => void onDelete(id)}
            className="shrink-0 text-[11px] text-red-400 hover:text-red-300"
          >
            Delete
          </button>
          <button
            onClick={() => setConfirming(false)}
            className="shrink-0 text-[11px] text-zinc-500 hover:text-zinc-200"
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          <button
            onClick={() => setEditing(true)}
            className="shrink-0 text-[11px] text-zinc-500 hover:text-zinc-200"
          >
            Rename
          </button>
          <button
            onClick={() => setConfirming(true)}
            className="shrink-0 text-[11px] text-zinc-500 hover:text-red-400"
          >
            Delete
          </button>
        </>
      )}
    </li>
  );
}

/**
 * Says what encryption does and, just as importantly, what it does not. DPAPI
 * ties the ciphertext to the Windows account, which makes a stolen cliptack.db
 * useless — but it does not stop a program running as you from asking Windows
 * to decrypt it. The old warning was blunter and, until now, correct; watering
 * it down to "encrypted ✓" would trade one inaccuracy for another.
 */
function CredentialSecurityNote({ encrypted }: { encrypted: boolean | null }) {
  if (encrypted === null) return null;

  if (!encrypted) {
    return (
      <div className="mt-5 rounded-md border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2.5">
        <p className="text-[12px] text-amber-300">Credentials are not encrypted</p>
        <p className="mt-1 text-[11px] leading-[1.5] text-amber-400/80">
          This platform has no key store Cliptack can use, so passwords are stored as plain text in
          cliptack.db. Anyone who can read that file can read them.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-5 rounded-md border border-edge bg-panelalt px-3 py-2.5">
      <p className="text-[12px] text-zinc-300">Credentials are encrypted</p>
      <p className="mt-1 text-[11px] leading-[1.5] text-zinc-500">
        Passwords are sealed with Windows DPAPI under your account, so cliptack.db is unreadable on
        another machine or from another Windows account. It is not protection against a program
        running as you — that program can ask Windows to decrypt them, exactly as Cliptack does.
      </p>
      <p className="mt-1.5 text-[11px] leading-[1.5] text-zinc-500">
        A copied password is cleared from the clipboard after 30 seconds. Keep a backup elsewhere:
        this file is the only copy, and it is tied to this Windows account.
      </p>
    </div>
  );
}

function pasteDescription(status: SecurityInfo | null): string {
  if (status && !status.pasteSupported) {
    return status.pasteReason ?? "Not supported on this platform.";
  }
  return "Enter pastes into the window you came from. Ctrl+Enter copies without pasting.";
}

function captureDescription(status: CaptureStatus | null): string {
  if (!status) return "Keeps the panel and stickies out of screen shares and recordings.";
  if (!status.supported) {
    return status.reason ?? "Not supported on this platform.";
  }
  if (status.reason) return status.reason;
  return "Keeps the panel and stickies out of screen shares and recordings.";
}

function Toggle({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label
      className={[
        "flex items-start gap-3 py-2.5",
        disabled ? "opacity-50" : "cursor-pointer",
      ].join(" ")}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
      />
      <span className="min-w-0">
        <span className="block text-[13px] text-zinc-200">{label}</span>
        <span className="block text-[11px] leading-4 text-zinc-500">{description}</span>
      </span>
    </label>
  );
}
