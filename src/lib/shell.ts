// ArkNetzWebWeaver — shell state: tabs, per-tab history, bookmarks.
// Thread turn 19: tabbed browsing with bookmarks and back/forward.
// Pure logic, store-injected so it is testable in Node; the browser wires
// an IndexedDB-backed store, tests wire the memory store.
// Guest mode is the default: tabs and bookmarks work with no sign-in.

export interface Tab {
  id: string;
  /** What the tab shows: an arknetz:// domain, an https: URL, or "home". */
  address: string;
  title: string;
  history: string[];
  historyIndex: number;
}

export interface Bookmark {
  address: string;
  title: string;
  addedAt: number;
}

export interface ShellStore {
  getTabs(): Promise<Tab[]>;
  saveTabs(tabs: Tab[]): Promise<void>;
  getBookmarks(): Promise<Bookmark[]>;
  saveBookmarks(bookmarks: Bookmark[]): Promise<void>;
}

export function createMemoryShellStore(): ShellStore {
  let tabs: Tab[] = [];
  let bookmarks: Bookmark[] = [];
  return {
    async getTabs() {
      return [...tabs];
    },
    async saveTabs(t) {
      tabs = [...t];
    },
    async getBookmarks() {
      return [...bookmarks];
    },
    async saveBookmarks(b) {
      bookmarks = [...b];
    },
  };
}

let tabCounter = 0;
export function newTabId(): string {
  tabCounter += 1;
  return `tab-${Date.now().toString(36)}-${tabCounter}`;
}

export class TabManager {
  private tabs: Tab[] = [];
  private activeId: string | null = null;

  constructor(private readonly store: ShellStore) {}

  async load(): Promise<void> {
    this.tabs = await this.store.getTabs();
    if (this.tabs.length === 0) {
      this.tabs = [this.makeTab("home", "ArkNetz — Home")];
    }
    this.activeId = this.tabs[0]?.id ?? null;
  }

  private makeTab(address: string, title: string): Tab {
    return { id: newTabId(), address, title, history: [address], historyIndex: 0 };
  }

  private async persist(): Promise<void> {
    await this.store.saveTabs(this.tabs);
  }

  list(): Tab[] {
    return [...this.tabs];
  }

  active(): Tab | null {
    return this.tabs.find((t) => t.id === this.activeId) ?? null;
  }

  async open(address: string, title?: string): Promise<Tab> {
    const tab = this.makeTab(address, title ?? address);
    this.tabs.push(tab);
    this.activeId = tab.id;
    await this.persist();
    return tab;
  }

  async close(id: string): Promise<void> {
    this.tabs = this.tabs.filter((t) => t.id !== id);
    if (this.tabs.length === 0) {
      this.tabs = [this.makeTab("home", "ArkNetz — Home")];
    }
    if (this.activeId === id) this.activeId = this.tabs[0]?.id ?? null;
    await this.persist();
  }

  async activate(id: string): Promise<void> {
    if (this.tabs.some((t) => t.id === id)) this.activeId = id;
  }

  async navigate(address: string, title?: string): Promise<Tab | null> {
    const tab = this.active();
    if (!tab) return null;
    // Truncate forward history, then push.
    tab.history = tab.history.slice(0, tab.historyIndex + 1);
    tab.history.push(address);
    tab.historyIndex = tab.history.length - 1;
    tab.address = address;
    if (title) tab.title = title;
    await this.persist();
    return tab;
  }

  async back(): Promise<Tab | null> {
    const tab = this.active();
    if (!tab || tab.historyIndex <= 0) return tab;
    tab.historyIndex -= 1;
    tab.address = tab.history[tab.historyIndex] as string;
    await this.persist();
    return tab;
  }

  async forward(): Promise<Tab | null> {
    const tab = this.active();
    if (!tab || tab.historyIndex >= tab.history.length - 1) return tab;
    tab.historyIndex += 1;
    tab.address = tab.history[tab.historyIndex] as string;
    await this.persist();
    return tab;
  }

  canBack(): boolean {
    const tab = this.active();
    return !!tab && tab.historyIndex > 0;
  }

  canForward(): boolean {
    const tab = this.active();
    return !!tab && tab.historyIndex < tab.history.length - 1;
  }
}

export class BookmarkManager {
  private bookmarks: Bookmark[] = [];

  constructor(private readonly store: ShellStore) {}

  async load(): Promise<void> {
    this.bookmarks = await this.store.getBookmarks();
  }

  list(): Bookmark[] {
    return [...this.bookmarks];
  }

  isBookmarked(address: string): boolean {
    return this.bookmarks.some((b) => b.address === address);
  }

  async add(address: string, title: string): Promise<void> {
    if (this.isBookmarked(address)) return;
    this.bookmarks.push({ address, title, addedAt: Date.now() });
    await this.store.saveBookmarks(this.bookmarks);
  }

  async remove(address: string): Promise<void> {
    this.bookmarks = this.bookmarks.filter((b) => b.address !== address);
    await this.store.saveBookmarks(this.bookmarks);
  }
}
