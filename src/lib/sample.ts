// Built-in demo site, so anonymous guest browsing works with zero
// network and zero registry: the shell opens this when there is no
// registry entry yet. It is clearly labelled a demo in the UI — it is
// NOT a real site from the network.
import type { SiteDocument } from "./types.js";

export const DEMO_SITE: SiteDocument = {
  domain: "welcome.arknetz",
  title: "Welcome to ArkNetzWebWeaver",
  theme: { layout: "docs", accent: "#2563eb", font: "system-ui" },
  nav: [
    { label: "Home", href: "arknetz://welcome.arknetz" },
    { label: "About the protocol", href: "arknetz://welcome.arknetz/about" },
  ],
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
      text: "This is a demo site bundled with the shell. Real sites resolve through the sharded registry once the central repos exist.",
    },
    {
      type: "code",
      language: "text",
      text: "arknetz://welcome.arknetz\nregistry shard: SHA256(domain)[0] -> arknetz-registry-0x",
    },
  ],
};
