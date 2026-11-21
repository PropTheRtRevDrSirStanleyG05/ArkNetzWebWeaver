// Built-in demo site, so anonymous guest browsing works with zero
// network and zero registry: the shell opens this when there is no
// registry entry yet. It is clearly labelled a demo in the UI — it is
// NOT a real site from the network.
import type { SiteDocument } from "./types.js";

/** The demo's About page (hunt 4: the nav linked here but the reader
 *  always rendered the home document, so the address changed and the
 *  content never did). Real content, shared by the reader and the
 *  static export — both resolve it from DEMO_SITE.pages["about"]. */
export const DEMO_ABOUT: SiteDocument = {
  domain: "welcome.arknetz",
  title: "About the protocol",
  theme: { layout: "docs", accent: "#2563eb", font: "system-ui" },
  nav: [
    { label: "Home", href: "arknetz://welcome.arknetz" },
    { label: "About the protocol", href: "arknetz://welcome.arknetz/about" },
  ],
  blocks: [
    { type: "h2", text: "What ArkNetz is" },
    {
      type: "p",
      text: "ArkNetz is a zero-server web: sites are small typed JSON documents stored in public GitHub repositories, media lives on the Internet Archive, and the app in your hand is the browser, the builder, and the reader in one. There is no server to run and no hosting bill — the network is the repos.",
    },
    { type: "h2", text: "How a site loads" },
    {
      type: "p",
      text: "A domain is looked up in a sharded registry — sixteen public repos, one per first hex digit of the domain's SHA-256. The registry entry points at the site's own repo; the site document is fetched from raw.githubusercontent.com, cached with ETags, and decompressed with Zstd. A repeat visit transfers nothing.",
    },
    { type: "h2", text: "Who stores what" },
    {
      type: "p",
      text: "Text and structure live in GitHub repos. Images, audio, and video live on the Internet Archive under the publisher's own account. Your drafts, keys, and reading lists live on your device, in IndexedDB — the network never sees them.",
    },
    {
      type: "quote",
      text: "This demo site is bundled with the app so guest browsing works with no network at all. Real sites resolve through the registry — none have been published yet.",
    },
  ],
};

export const DEMO_SITE: SiteDocument = {
  domain: "welcome.arknetz",
  title: "Welcome to ArkNetzWebWeaver",
  theme: { layout: "docs", accent: "#2563eb", font: "system-ui" },
  nav: [
    { label: "Home", href: "arknetz://welcome.arknetz" },
    { label: "About the protocol", href: "arknetz://welcome.arknetz/about" },
  ],
  pages: { about: DEMO_ABOUT },
  blocks: [
    {
      type: "hero",
      title: "The zero-server web",
      subtitle: "A zero-server, $0/month web. Sites are tiny compressed JSON on GitHub, media lives on the Internet Archive, and you own your domain.",
    },
    { type: "h2", text: "How it works" },
    {
      type: "p",
      text: "You are browsing as a guest — no sign-in was needed. Reads come from raw.githubusercontent.com with ETag caching, so a repeat visit costs almost nothing.",
    },
    {
      type: "cols",
      columns: [
        [{ type: "h3", text: "Sites" }, { type: "p", text: "Typed semantic blocks only. No raw HTML, no trackers." }],
        [{ type: "h3", text: "Media" }, { type: "p", text: "Attachments upload to the Internet Archive in the background and embed as hotlinks." }],
        [{ type: "h3", text: "Mail & Drive" }, { type: "p", text: "Protocol mail and ArkDrive land after the shell, in that order." }],
      ],
    },
    {
      type: "quote",
      text: "This is a demo site bundled with the shell. Real sites resolve through the sharded registry — no sites have been published yet.",
    },
    {
      type: "code",
      language: "text",
      text: "arknetz://welcome.arknetz\nregistry shard: SHA256(domain)[0] -> arknetz-registry-0x",
    },
  ],
};
