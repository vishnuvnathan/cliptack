import { create } from "zustand";
import * as ipc from "../lib/ipc";
import {
  emptyFilters,
  isCredential,
  TYPE_CHIPS,
  type ContentType,
  type CredentialDraft,
  type Filters,
  type Folder,
  type Item,
  type MatchCount,
  type Settings,
  type TransformOption,
  type TypeChipId,
} from "../lib/types";

export type View = "list" | "note" | "credential" | "settings";

/**
 * What the undo bar needs. `secretErased` is carried because a deleted
 * credential's password is gone immediately and cannot be restored — the offer
 * has to say that up front rather than surprise the user after they take it.
 */
export interface DeletedItem {
  item: Item;
  secretErased: boolean;
}

interface StashState {
  query: string;
  items: Item[];
  selected: number;
  loading: boolean;
  error: string | null;

  view: View;
  editingNoteId: string | null;
  editingCredentialId: string | null;

  typeChips: TypeChipId[];
  sourceApps: string[];
  activeSourceApps: string[];

  folders: Folder[];
  activeFolderId: string | null;

  /** Plaintext of the selected credential while it is revealed. Transient. */
  revealedPassword: string | null;

  settings: Settings | null;

  setQuery: (q: string) => void;
  refresh: () => Promise<void>;
  move: (delta: number) => void;
  select: (index: number) => void;

  toggleTypeChip: (id: TypeChipId) => void;
  toggleSourceApp: (app: string) => void;
  clearFilters: () => void;

  copySelected: () => Promise<void>;
  pasteSelected: () => Promise<void>;
  deleteSelected: () => Promise<void>;
  deleteById: (id: string) => Promise<void>;

  /**
   * The one item an undo would bring back, or null when there is nothing on
   * offer. Deliberately single: this is the "I just pressed the wrong key"
   * escape hatch, not a history stack.
   */
  lastDeleted: DeletedItem | null;
  undoDelete: () => Promise<void>;
  dismissUndo: () => void;

  /** Bulk paths. Both confirm in the UI first; neither is undoable. */
  countMatching: () => Promise<MatchCount | null>;
  deleteMatching: () => Promise<number>;
  clearClipHistory: () => Promise<number>;
  afterBulkDelete: () => Promise<void>;

  /** The "paste as" menu: null when closed, a list of options when open. */
  transforms: TransformOption[] | null;
  openTransforms: () => Promise<void>;
  closeTransforms: () => void;
  applyTransform: (transformId: string, paste: boolean) => Promise<void>;
  pinSelected: () => Promise<void>;

  loadFolders: () => Promise<void>;
  setFolder: (id: string | null) => void;
  createFolder: (name: string) => Promise<Folder | null>;
  renameFolder: (id: string, name: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  assignSelectedToFolder: (folderId: string | null) => Promise<void>;

  openCredential: (id: string | null) => void;
  saveCredential: (draft: Omit<CredentialDraft, "id">) => Promise<void>;
  copySelectedUsername: () => Promise<void>;
  copySelectedPassword: () => Promise<void>;
  revealSelectedPassword: () => Promise<void>;
  clearRevealed: () => void;

  openNote: (id: string | null) => void;
  saveNote: (title: string, content: string) => Promise<void>;
  setView: (v: View) => void;

  loadSettings: () => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;

  bootstrap: () => Promise<void>;
}

/** Search runs on a trailing debounce so holding a key does not queue a query per keystroke. */
let searchTimer: ReturnType<typeof setTimeout> | undefined;
const DEBOUNCE_MS = 80;

/** Guards against an older, slower search overwriting a newer one's results. */
let searchSeq = 0;

function buildFilters(
  chips: TypeChipId[],
  sourceApps: string[],
  folderId: string | null,
): Filters {
  const contentTypes: ContentType[] = [];
  for (const chip of TYPE_CHIPS) {
    if (chips.includes(chip.id)) contentTypes.push(...chip.types);
  }
  return {
    ...emptyFilters(),
    contentTypes,
    sourceApps,
    folderIds: folderId ? [folderId] : [],
  };
}

export const useStash = create<StashState>((set, get) => ({
  query: "",
  items: [],
  selected: 0,
  loading: false,
  error: null,

  view: "list",
  editingNoteId: null,
  editingCredentialId: null,

  typeChips: [],
  sourceApps: [],
  activeSourceApps: [],

  folders: [],
  activeFolderId: null,

  revealedPassword: null,
  transforms: null,
  lastDeleted: null,

  settings: null,

  setQuery(q) {
    set({ query: q });
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void get().refresh(), DEBOUNCE_MS);
  },

  async refresh() {
    const seq = ++searchSeq;
    const { query, typeChips, activeSourceApps, activeFolderId } = get();
    set({ loading: true });
    try {
      const items = await ipc.searchItems(
        query,
        buildFilters(typeChips, activeSourceApps, activeFolderId),
      );
      if (seq !== searchSeq) return; // a newer search already landed
      set((s) => ({
        items,
        loading: false,
        error: null,
        // Keep the cursor in range without snapping to the top on every keystroke.
        selected: Math.min(s.selected, Math.max(0, items.length - 1)),
      }));
    } catch (e) {
      if (seq !== searchSeq) return;
      set({ loading: false, error: String(e) });
    }
  },

  // Both movement paths drop a revealed password: it belongs to the row you
  // were looking at, and leaving that row is the clearest signal you are done
  // with it. Same reasoning in `setView` and on `panel-opened`.
  move(delta) {
    const { items, selected } = get();
    if (items.length === 0) return;
    const next = Math.min(items.length - 1, Math.max(0, selected + delta));
    if (next === selected) return;
    set({ selected: next, revealedPassword: null });
  },

  select(index) {
    if (get().selected === index) return;
    set({ selected: index, revealedPassword: null });
  },

  toggleTypeChip(id) {
    set((s) => ({
      typeChips: s.typeChips.includes(id)
        ? s.typeChips.filter((c) => c !== id)
        : [...s.typeChips, id],
      selected: 0,
      revealedPassword: null,
    }));
    void get().refresh();
  },

  toggleSourceApp(app) {
    set((s) => ({
      activeSourceApps: s.activeSourceApps.includes(app)
        ? s.activeSourceApps.filter((a) => a !== app)
        : [...s.activeSourceApps, app],
      selected: 0,
    }));
    void get().refresh();
  },

  clearFilters() {
    set({
      typeChips: [],
      activeSourceApps: [],
      activeFolderId: null,
      selected: 0,
      revealedPassword: null,
    });
    void get().refresh();
  },

  /**
   * Enter on a row. A credential copies its username rather than its body --
   * `copy_item` refuses credentials outright, so this dispatch is not merely a
   * nicety, it is the only thing that makes Enter work on one.
   */
  async copySelected() {
    const { items, selected } = get();
    const item = items[selected];
    if (!item) return;
    if (isCredential(item)) {
      await get().copySelectedUsername();
      return;
    }
    try {
      await ipc.copyItem(item.id);
      await ipc.hidePanel();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  /**
   * What Enter does: paste into the window the panel was opened from.
   *
   * Falls back to a plain copy when auto-paste is off, and reports — rather
   * than swallows — a paste that could not be delivered. The item is on the
   * clipboard in every one of those cases, so the message says so instead of
   * reading as a failure.
   */
  async pasteSelected() {
    const { items, selected, settings } = get();
    const item = items[selected];
    if (!item) return;

    if (settings && !settings.autoPaste) {
      await get().copySelected();
      return;
    }

    try {
      const status = isCredential(item)
        ? await ipc.pasteCredentialField(item.id, "username")
        : await ipc.pasteItem(item.id);

      // The panel is already hidden by this point; the message is waiting when
      // it next opens.
      set({ error: status.pasted ? null : status.reason });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  /**
   * Asks Rust which transforms suit the selected item. An item with nothing
   * worth offering — an image, a credential — sets an error rather than opening
   * an empty menu, which would look like the key did nothing.
   */
  async openTransforms() {
    const { items, selected } = get();
    const item = items[selected];
    if (!item) return;
    try {
      const transforms = await ipc.transformsFor(item.id);
      if (transforms.length === 0) {
        set({ error: "Nothing to transform on this item" });
        return;
      }
      set({ transforms, error: null });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  closeTransforms() {
    if (get().transforms !== null) set({ transforms: null });
  },

  /**
   * `paste` follows whatever Enter would have done, so the transform menu does
   * not quietly change the action — only the text it acts on.
   */
  async applyTransform(transformId, paste) {
    const { items, selected, settings } = get();
    const item = items[selected];
    set({ transforms: null });
    if (!item) return;

    const wantPaste = paste && (settings?.autoPaste ?? true);
    try {
      if (wantPaste) {
        const status = await ipc.pasteItem(item.id, transformId);
        set({ error: status.pasted ? null : status.reason });
      } else {
        await ipc.copyItem(item.id, transformId);
        await ipc.hidePanel();
      }
    } catch (e) {
      set({ error: String(e) });
    }
  },

  async deleteSelected() {
    const { items, selected } = get();
    const item = items[selected];
    if (!item) return;
    await get().deleteById(item.id);
  },

  /**
   * Deletes by id so the row's ✕ and the keyboard both land here, and so the
   * action's identity is stable enough to hand to a memoised row.
   */
  async deleteById(id) {
    const { items, selected } = get();
    const index = items.findIndex((i) => i.id === id);
    const item = items[index];
    if (!item) return;

    // Drop it locally first: the row is gone from the user's point of view the
    // moment they press the key, and the query would return the same result.
    //
    // The cursor stays on whatever it was pointing at. Deleting *above* the
    // selection shifts everything up, so the index has to follow; deleting the
    // selected row itself leaves the index alone, which lands on the row that
    // slid into its place -- delete-delete-delete walks down the list, which is
    // the whole reason the binding exists. Only the last row clamps.
    const remaining = items.length - 1;
    const next = index < selected ? selected - 1 : selected;
    set({
      items: items.filter((i) => i.id !== id),
      selected: Math.max(0, Math.min(next, remaining - 1)),
    });

    try {
      const secretErased = await ipc.deleteItem(id);
      set({ lastDeleted: { item, secretErased } });
    } catch (e) {
      set({ error: String(e), lastDeleted: null });
      void get().refresh();
    }
  },

  async undoDelete() {
    const pending = get().lastDeleted;
    if (!pending) return;
    // Cleared up front: a failed restore must not leave the offer standing for
    // a second attempt that would fail the same way.
    set({ lastDeleted: null });
    try {
      const restored = await ipc.restoreItem(pending.item.id);
      if (!restored) {
        set({ error: "That item is past the 24-hour window and cannot be restored" });
        return;
      }
      await get().refresh();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  dismissUndo() {
    if (get().lastDeleted !== null) set({ lastDeleted: null });
  },

  async countMatching() {
    const { query, typeChips, activeSourceApps, activeFolderId } = get();
    try {
      return await ipc.countMatching(
        query,
        buildFilters(typeChips, activeSourceApps, activeFolderId),
      );
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
  },

  /**
   * Deletes everything the current view matches. Rust re-resolves the set from
   * the same query and filters rather than taking a list of ids from here, so
   * what goes is what the list was showing -- including anything past the
   * display cap that was never rendered.
   */
  async deleteMatching() {
    const { query, typeChips, activeSourceApps, activeFolderId } = get();
    try {
      const deleted = await ipc.deleteMatching(
        query,
        buildFilters(typeChips, activeSourceApps, activeFolderId),
      );
      await get().afterBulkDelete();
      return deleted;
    } catch (e) {
      set({ error: String(e) });
      return 0;
    }
  },

  async clearClipHistory() {
    try {
      const deleted = await ipc.clearClipHistory();
      await get().afterBulkDelete();
      return deleted;
    } catch (e) {
      set({ error: String(e) });
      return 0;
    }
  },

  /**
   * The source-app chips are derived from live rows, so a bulk delete can leave
   * them offering apps with nothing behind them. Refreshing both is what keeps
   * the filter row honest. The undo offer goes too -- it names a single item,
   * and after a bulk delete that is the wrong thing to point at.
   */
  async afterBulkDelete() {
    set({ lastDeleted: null, selected: 0 });
    await Promise.all([
      get().refresh(),
      ipc
        .listSourceApps()
        .then((sourceApps) =>
          set((s) => ({
            sourceApps,
            // Drop any active chip whose app no longer exists, or the list
            // would filter to nothing with no visible cause.
            activeSourceApps: s.activeSourceApps.filter((a) => sourceApps.includes(a)),
          })),
        )
        .catch(() => undefined),
    ]);
  },

  async pinSelected() {
    const { items, selected } = get();
    const item = items[selected];
    if (!item) return;
    try {
      await ipc.togglePin(item.id, !item.pinned);
      await get().refresh();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  /* -- folders ------------------------------------------------------------ */

  async loadFolders() {
    try {
      set({ folders: await ipc.listFolders() });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  setFolder(id) {
    set({ activeFolderId: id, selected: 0, revealedPassword: null });
    void get().refresh();
  },

  async createFolder(name) {
    try {
      const folder = await ipc.createFolder(name);
      await get().loadFolders();
      return folder;
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
  },

  async renameFolder(id, name) {
    try {
      await ipc.renameFolder(id, name);
      await get().loadFolders();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  async deleteFolder(id) {
    try {
      await ipc.deleteFolder(id);
      // Items survive as unfiled, but the active filter now points at nothing.
      if (get().activeFolderId === id) set({ activeFolderId: null });
      await get().loadFolders();
      await get().refresh();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  async assignSelectedToFolder(folderId) {
    const { items, selected } = get();
    const item = items[selected];
    if (!item) return;
    try {
      await ipc.setItemFolder(item.id, folderId);
      await get().refresh();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  /* -- credentials -------------------------------------------------------- */

  openCredential(id) {
    set({
      view: "credential",
      editingCredentialId: id,
      revealedPassword: null,
      lastDeleted: null,
    });
  },

  async saveCredential(draft) {
    const { editingCredentialId } = get();
    try {
      await ipc.saveCredential({ ...draft, id: editingCredentialId });
      set({ view: "list", editingCredentialId: null });
      await Promise.all([get().refresh(), get().loadFolders()]);
    } catch (e) {
      set({ error: String(e) });
    }
  },

  async copySelectedUsername() {
    const { items, selected } = get();
    const item = items[selected];
    if (!item) return;
    try {
      await ipc.copyCredentialField(item.id, "username");
      await ipc.hidePanel();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  async copySelectedPassword() {
    const { items, selected } = get();
    const item = items[selected];
    if (!item || !isCredential(item)) return;
    try {
      // The plaintext goes straight from Rust to the clipboard; nothing here
      // ever holds it.
      await ipc.copyCredentialField(item.id, "password");
      await ipc.hidePanel();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  async revealSelectedPassword() {
    const { items, selected, revealedPassword } = get();
    const item = items[selected];
    if (!item || !isCredential(item)) return;
    if (revealedPassword !== null) {
      set({ revealedPassword: null });
      return;
    }
    try {
      set({ revealedPassword: await ipc.revealPassword(item.id) });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  clearRevealed() {
    if (get().revealedPassword !== null) set({ revealedPassword: null });
  },

  openNote(id) {
    set({ view: "note", editingNoteId: id, revealedPassword: null, lastDeleted: null });
  },

  async saveNote(title, content) {
    const { editingNoteId } = get();
    try {
      await ipc.saveNote(editingNoteId, title, content);
      set({ view: "list", editingNoteId: null });
      await get().refresh();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  // Leaving the list drops the undo offer along with the revealed password: it
  // names a row in a list you are no longer looking at, and Ctrl+Z belongs to
  // the editor once one is open.
  setView(v) {
    set({ view: v, revealedPassword: null, lastDeleted: null });
  },

  async loadSettings() {
    try {
      set({ settings: await ipc.getSettings() });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  async updateSettings(patch) {
    const current = get().settings;
    if (!current) return;
    const next = { ...current, ...patch };
    set({ settings: next });
    try {
      set({ settings: await ipc.setSettings(next) });
    } catch (e) {
      set({ settings: current, error: String(e) });
    }
  },

  async bootstrap() {
    await Promise.all([
      get().refresh(),
      get().loadSettings(),
      get().loadFolders(),
      ipc
        .listSourceApps()
        .then((sourceApps) => set({ sourceApps }))
        .catch(() => undefined),
    ]);
  },
}));
