// Top-of-screen dropdown menu (hunt 5, Stanley's direction: "most of
// the stuff at the top can live in a drop down menu").
//
// On narrow screens (<=700px) the panel navigation (16 buttons in 4
// rows) and the toolbar's secondary actions (Back, Forward, + Tab,
// Bookmark, Edit site) collapse into a menu hanging off the sticky
// topbar, so the first viewport is content, not chrome. What stays
// visible: the brand, the sign-in state, the menu button itself, the
// tab row, and the address bar + Go — the browser's primary controls.
//
// Desktop is untouched: the nodes stay in their original places and
// the menu button is display:none (styles.css). The move is done by
// re-parenting the live nodes, so every listener main.ts attached
// (panel switching, back/forward, edit toggle) travels with them, and
// panels.ts buildNav keeps re-rendering into the moved #panel-nav.
//
// Wiring: index.html calls initTopMenu() from an inline module script
// (main.ts is owned by another agent this hunt). A later main.ts
// wiring must call the same init — the call is idempotent, so a
// double wire is harmless, but the inline script should then be
// removed to keep one owner.

export interface TopMenuOptions {
  /** #topmenu-btn — the 44px trigger in the topbar. */
  button?: HTMLElement | null;
  /** #topmenu — the dropdown container inside the topbar. */
  menu?: HTMLElement | null;
  /** #panel-nav — moved into the menu on mobile, restored on desktop. */
  nav?: HTMLElement | null;
  /** .an-panels — the nav's original parent (nav is its first child). */
  panelsHome?: HTMLElement | null;
  /** .an-toolbar — the toolbar buttons' original parent. */
  toolbar?: HTMLElement | null;
  /** Toolbar buttons that move into the menu (default: the five ids). */
  toolbarButtons?: HTMLElement[];
  /** [data-topmenu-slot="panels"] — menu slot for the nav. */
  panelsSlot?: HTMLElement | null;
  /** [data-topmenu-slot="tools"] — menu slot for the toolbar buttons. */
  toolsSlot?: HTMLElement | null;
  /** Narrow-screen query (default: window.matchMedia max-width 700px). */
  mediaQuery?: MediaQueryList | null;
  /** Document for the outside-tap / Escape listeners (default: global). */
  doc?: Document | null;
}

const TOOLBAR_BUTTON_IDS = ["back-btn", "forward-btn", "new-tab-btn", "bookmark-btn", "edit-toggle-btn"];
const NARROW_QUERY = "(max-width: 700px)";

/** Is `node` still a child of `parent` (a recorded anchor may have moved). */
function isChildOf(node: Node | null, parent: Node | null): node is Node {
  return !!node && !!parent && node.parentNode === parent;
}

export function initTopMenu(opts: TopMenuOptions = {}): void {
  const doc =
    opts.doc ??
    (typeof document !== "undefined" ? document : null);
  if (!doc) return;
  const button = opts.button ?? doc.getElementById("topmenu-btn");
  const menu = opts.menu ?? doc.getElementById("topmenu");
  // Without a trigger or a menu there is nothing to wire (e.g. an old
  // cached shell) — never throw from an init.
  if (!button || !menu) return;
  // Idempotent: a second init (e.g. inline script + a later main.ts
  // wiring) must not double-wire the toggle — one click would open
  // then immediately close again.
  if (button.dataset.topmenuInit === "1") return;
  button.dataset.topmenuInit = "1";

  const nav = opts.nav ?? doc.getElementById("panel-nav");
  const panelsHome = opts.panelsHome ?? doc.querySelector<HTMLElement>(".an-panels");
  const toolbar = opts.toolbar ?? doc.querySelector<HTMLElement>(".an-toolbar");
  const toolbarButtons =
    opts.toolbarButtons ??
    TOOLBAR_BUTTON_IDS.map((id) => doc.getElementById(id)).filter(
      (el): el is HTMLElement => !!el,
    );
  const panelsSlot =
    opts.panelsSlot ?? doc.querySelector<HTMLElement>('[data-topmenu-slot="panels"]');
  const toolsSlot =
    opts.toolsSlot ?? doc.querySelector<HTMLElement>('[data-topmenu-slot="tools"]');
  const mq =
    opts.mediaQuery ??
    (typeof window !== "undefined" ? window.matchMedia(NARROW_QUERY) : null);

  // Original anchors, recorded once: the nav sits directly before the
  // panel host, each toolbar button before its next sibling.
  const navAnchor = nav ? nav.nextSibling : null;
  const toolbarAnchors = new Map<HTMLElement, Node | null>();
  for (const btn of toolbarButtons) toolbarAnchors.set(btn, btn.nextSibling);

  let open = false;

  const setOpen = (next: boolean): void => {
    open = next;
    menu.hidden = !next;
    button.setAttribute("aria-expanded", String(next));
  };
  const close = (): void => {
    if (open) setOpen(false);
  };

  /** Move the nodes into the menu on narrow screens, home on desktop. */
  const place = (narrow: boolean): void => {
    if (narrow) {
      if (nav && panelsSlot) panelsSlot.appendChild(nav);
      if (toolsSlot) for (const btn of toolbarButtons) toolsSlot.appendChild(btn);
    } else {
      if (nav && panelsHome) {
        // The host never moves, so the recorded anchor stays valid;
        // fall back to first-child if it ever stops being one.
        panelsHome.insertBefore(nav, isChildOf(navAnchor, panelsHome) ? navAnchor : panelsHome.firstChild);
      }
      if (toolbar) {
        // Restore last-to-first so each recorded anchor is already
        // home (or never moved) when its button is inserted before it.
        for (let i = toolbarButtons.length - 1; i >= 0; i--) {
          const btn = toolbarButtons[i]!;
          const anchor = toolbarAnchors.get(btn) ?? null;
          toolbar.insertBefore(btn, isChildOf(anchor, toolbar) ? anchor : null);
        }
      }
      close();
    }
  };

  button.addEventListener("click", () => setOpen(!open));

  // Selection closes: a panel button or a toolbar action inside the
  // menu fires its own handler first (target phase), then this bubble
  // listener closes the menu — so hunt-4 scrollBelowTopbar still lands
  // the panel heading below the sticky topbar with the menu gone.
  menu.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    if (target && typeof target.closest === "function" && target.closest("button, a")) close();
  });

  // Outside tap closes; taps on the trigger or inside the menu do not.
  doc.addEventListener("click", (event) => {
    if (!open) return;
    const target = event.target as Node | null;
    if (!target) return;
    if (menu.contains(target) || button.contains(target)) return;
    close();
  });

  // Escape closes and returns focus to the trigger.
  doc.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !open) return;
    close();
    button.focus();
  });

  if (mq) {
    const onChange = (): void => place(mq.matches);
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", onChange);
    else mq.addListener(onChange);
    place(mq.matches);
  } else {
    place(false);
  }
}
