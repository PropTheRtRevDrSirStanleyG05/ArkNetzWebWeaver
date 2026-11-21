// ArkNetzWebWeaver — theme presets + dark/light mode (builder phase).
// Presets become CSS Custom Properties; the renderer already reads
// --an-accent, and the editor preview uses the same variables, so a
// theme change is visible in the live canvas instantly, with no reload.

import type { ThemePreset } from "./types.js";

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: "academic",
    name: "Academic / University",
    accent: "#1d4ed8",
    font: "Georgia, 'Times New Roman', serif",
    background: "#ffffff",
    foreground: "#111827",
    muted: "#6b7280",
  },
  {
    id: "tech-docs",
    name: "Tech Docs",
    accent: "#0f766e",
    font: "ui-monospace, 'SF Mono', Menlo, monospace",
    background: "#ffffff",
    foreground: "#0f172a",
    muted: "#64748b",
  },
  {
    id: "editorial",
    name: "Editorial Magazine",
    accent: "#b91c1c",
    font: "Georgia, serif",
    background: "#fffbeb",
    foreground: "#1c1917",
    muted: "#78716c",
  },
  {
    id: "portfolio",
    name: "Minimalist Portfolio",
    accent: "#111827",
    font: "system-ui, -apple-system, sans-serif",
    background: "#fafafa",
    foreground: "#111827",
    muted: "#9ca3af",
  },
];

export function themePreset(id: string): ThemePreset | undefined {
  return THEME_PRESETS.find((t) => t.id === id);
}

export type ColorMode = "light" | "dark";

export const DARK_OVERRIDES: Pick<ThemePreset, "background" | "foreground" | "muted"> = {
  background: "#111827",
  foreground: "#f9fafb",
  muted: "#9ca3af",
};

/** Root class toggled on <html> while dark mode is on. The dark
 *  stylesheet (appThemeCss) scopes every rule under it, so one toggle
 *  darkens the whole app — topbar, sidebar, editor chrome, reader —
 *  not just the editor preview. */
export const DARK_MODE_CLASS = "an-dark";

/** Id of the <style> element the editor injects for dark mode. */
export const DARK_STYLE_ELEMENT_ID = "an-dark-theme";

/** App-wide dark-mode stylesheet, scoped under .an-dark. Light mode
 *  needs no overrides (the base stylesheet is light), so it returns "".
 *
 *  This exists because the base styles and the renderer's READER_CSS
 *  hardcode light surfaces — notably `pre{background:#f3f4f6}` — so
 *  toggling variables on the preview alone left the chrome light and,
 *  worse, left code blocks as light-grey text on a light-grey
 *  background in the dark preview. The rules here beat the hardcoded
 *  ones on specificity (.an-dark pre beats pre) and cover every app
 *  surface, including code blocks in both the reader and the preview:
 *  dark background #1f2937 with light text #f9fafb. */
export function appThemeCss(mode: ColorMode): string {
  if (mode === "light") return "";
  return [
    `.${DARK_MODE_CLASS}{--an-bg:#111827;--an-fg:#f9fafb;--an-muted:#9ca3af;color-scheme:dark}`,
    `.${DARK_MODE_CLASS} body{background:#111827;color:#f9fafb}`,
    `.${DARK_MODE_CLASS} .an-topbar{background:#0b1220;color:#f9fafb}`,
    `.${DARK_MODE_CLASS} .an-tabbar{background:#1f2937;border-bottom-color:#374151}`,
    `.${DARK_MODE_CLASS} .an-tab{background:#1f2937;color:#f9fafb;border-color:#374151}`,
    `.${DARK_MODE_CLASS} .an-tab[aria-selected="true"]{background:#2563eb;color:#fff;border-color:#2563eb}`,
    `.${DARK_MODE_CLASS} button{background:#1f2937;color:#f9fafb;border-color:#4b5563}`,
    `.${DARK_MODE_CLASS} input,.${DARK_MODE_CLASS} select,.${DARK_MODE_CLASS} textarea{background:#1f2937;color:#f9fafb;border-color:#4b5563}`,
    `.${DARK_MODE_CLASS} .an-note{color:#9ca3af}`,
    `.${DARK_MODE_CLASS} .an-footer{border-top-color:#374151;color:#9ca3af}`,
    `.${DARK_MODE_CLASS} .an-editor-bar{background:#1f2937;border-color:#374151}`,
    `.${DARK_MODE_CLASS} .an-editor-bar #editor-status{color:#d1d5db}`,
    `.${DARK_MODE_CLASS} .an-ed-block{background:#1f2937;border-color:#374151}`,
    `.${DARK_MODE_CLASS} .an-ed-block[data-selected="true"]{border-color:#2563eb}`,
    `.${DARK_MODE_CLASS} .an-ed-bar{color:#9ca3af}`,
    `.${DARK_MODE_CLASS} .an-ed-bar .an-ed-label{color:#f9fafb}`,
    `.${DARK_MODE_CLASS} .an-ed-text:focus{background:#1e3a5f}`,
    `.${DARK_MODE_CLASS} .an-preview{border-color:#4b5563}`,
    `.${DARK_MODE_CLASS} .an-panel-btn{background:#1f2937;color:#f9fafb;border-color:#4b5563}`,
    `.${DARK_MODE_CLASS} .an-panel-btn[aria-selected="true"]{background:#f9fafb;color:#111827;border-color:#f9fafb}`,
    // B5 (re-check): the panels strip kept its light #f9fafb background
    // while inheriting light text — light-on-light, unreadable. The
    // strip, its host and its headings/labels all go dark here; the
    // inputs/buttons inside are already covered by the generic dark
    // rules above, and .an-note is covered by the global .an-note rule.
    `.${DARK_MODE_CLASS} .an-panels{background:#1f2937;border-bottom-color:#374151;color:#f9fafb}`,
    `.${DARK_MODE_CLASS} .an-panel-host{color:#f9fafb}`,
    `.${DARK_MODE_CLASS} .an-panel-host h2,.${DARK_MODE_CLASS} .an-panel-host h3{color:#f9fafb}`,
    `.${DARK_MODE_CLASS} .an-panel-host label{color:#d1d5db}`,
    `.${DARK_MODE_CLASS} #panel-host{border-top-color:#374151}`,
    `.${DARK_MODE_CLASS} .an-diff-added{color:#6ee7b7;background:#064e3b}`,
    `.${DARK_MODE_CLASS} .an-diff-removed{color:#fca5a5;background:#450a0a;text-decoration:line-through}`,
    `.${DARK_MODE_CLASS} .an-diff-changed{color:#fcd34d;background:#451a03}`,
    `.${DARK_MODE_CLASS} .an-diff-same{color:#9ca3af}`,
    `.${DARK_MODE_CLASS} .an-site{background:#111827;color:#f9fafb}`,
    `.${DARK_MODE_CLASS} .an-site blockquote{color:#9ca3af}`,
    `.${DARK_MODE_CLASS} .an-hero,.${DARK_MODE_CLASS} .an-card,.${DARK_MODE_CLASS} .an-app,.${DARK_MODE_CLASS} .an-docs-sidebar{border-color:#374151}`,
    // Code blocks: the renderer's hardcoded light-grey background is
    // overridden here — dark surface, light text, readable in both the
    // reader and the live preview.
    `.${DARK_MODE_CLASS} .an-site pre,.${DARK_MODE_CLASS} pre{background:#1f2937;color:#f9fafb;border:1px solid #374151}`,
    `.${DARK_MODE_CLASS} .an-site pre code,.${DARK_MODE_CLASS} pre code{background:transparent;color:#f9fafb}`,
  ].join("\n");
}

/** CSS Custom Properties for a preset in a colour mode. The reader and
 *  the editor preview both consume these, so they never diverge. */
export function themeCssVariables(preset: ThemePreset, mode: ColorMode): string {
  const bg = mode === "dark" ? DARK_OVERRIDES.background : preset.background;
  const fg = mode === "dark" ? DARK_OVERRIDES.foreground : preset.foreground;
  const muted = mode === "dark" ? DARK_OVERRIDES.muted : preset.muted;
  return [
    `--an-accent:${preset.accent}`,
    `--an-font:${preset.font}`,
    `--an-bg:${bg}`,
    `--an-fg:${fg}`,
    `--an-muted:${muted}`,
  ].join(";");
}

/** Apply a preset to a document's theme (accent + font only — the
 *  document keeps its own layout). */
export function applyPresetToDocument(
  doc: { theme?: { layout?: string; accent?: string; font?: string } },
  preset: ThemePreset,
): void {
  doc.theme = { ...(doc.theme ?? {}), accent: preset.accent, font: preset.font };
}
