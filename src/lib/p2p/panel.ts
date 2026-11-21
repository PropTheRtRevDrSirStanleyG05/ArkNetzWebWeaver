// ArkNetzWebWeaver — P2P settings panel (phase 2 wiring).
// The P2P transport core (src/lib/p2p/) ships with a settings store,
// a host, and per-feature adapters, but no UI surface: this module is
// the dedicated P2P panel — master switch + per-feature toggles, peer
// ID rotation/reset, TURN configuration, the relay privacy note, and
// the connection-diagnostics line. Everything is off by default and
// stays off until the user opts in here; the panel says so plainly.
//
// Licence: MIT. No new dependencies.

import type { P2PSettings } from "./types.js";
import type { IceDiagnostics } from "./ice.js";
import { P2P_FREETURN_NOTE, P2P_NO_ACCOUNT_NOTE, P2P_OPENRELAY_DEMO_NOTE, P2P_RELAY_PRIVACY_NOTE } from "./ice.js";
import { defaultP2PSettings } from "./types.js";

export const P2P_PANEL_ID = "p2p";
export const P2P_PANEL_TITLE = "P2P";
export const P2P_PANEL_DESCRIPTION =
  "Optional peer-to-peer transport — faster site loads, live collab, mail and drive between your devices. Off by default; GitHub stays the fallback.";

export interface P2PPeerRow {
  peerId: string;
  address: string | null;
  /** The describeIcePath summary for this connection ("Direct (host)",
   *  "Relayed through freeturn.net…", …). */
  diagnostics: IceDiagnostics | null;
}

export interface P2PPanelDeps {
  settings: P2PSettings;
  /** This device's peer id (short, stable until rotated). */
  peerId: string;
  /** This device's protocol address ("user@domain") when known. */
  selfAddress: string | null;
  /** Currently connected peers (empty = none — the honest state). */
  connectedPeers: P2PPeerRow[];
  /** ICE servers in effect right now (STUN always, TURN when enabled). */
  iceServersInEffect: string[];
  /** Called with the new settings when the user flips a toggle or
   *  edits a TURN field. The integration pass owns persistence
   *  (the P2P store); the caller re-renders with the updated copy. */
  onSettingsChange?: (next: P2PSettings) => void;
  /** Rotate the peer id (old id stops being advertised). */
  onRotatePeerId?: () => void;
  /** Reset the peer id AND clear every P2P setting + TURN key. */
  onResetPeerId?: () => void;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function section(title: string, body: string): string {
  return `<section><h3>${esc(title)}</h3>${body}</section>`;
}

/** One feature toggle row. Disabled when the master switch is off —
 *  a per-feature toggle means nothing while P2P itself is off, and
 *  the panel must not let the user build a state that reads as
 *  "collab on" while the master is off. */
function featureToggle(
  id: string,
  label: string,
  hint: string,
  checked: boolean,
  masterOn: boolean,
): string {
  return (
    `<p><button id="${id}" type="button" aria-pressed="${checked}"${masterOn ? "" : " disabled"}>` +
    `${checked ? "Turn off" : "Turn on"} ${esc(label)}</button></p>` +
    `<p class="an-note">${esc(hint)}</p>`
  );
}

/** Render the P2P panel to HTML from live settings + diagnostics. */
export function renderP2PPanelHtml(deps: P2PPanelDeps): string {
  const settings = { ...defaultP2PSettings(), ...deps.settings };
  const h = `<h2>${esc(P2P_PANEL_TITLE)}</h2>`;
  const masterOn = settings.enabled;

  const intro = section(
    "Peer-to-peer (optional)",
    `<p>Peer-to-peer is an optional accelerator under the features you already have. When it is on, this device talks directly to other ArkNetz devices over encrypted WebRTC data channels; when it is off — the default — everything works exactly as before over GitHub. GitHub stays the fallback and the source of truth either way: a peer that cannot be reached, or a transfer that fails, silently falls back to the repo.</p>` +
      `<p><button id="an-p2p-toggle-master" type="button" aria-pressed="${masterOn}">${masterOn ? "Turn off peer-to-peer" : "Turn on peer-to-peer"}</button></p>` +
      `<p class="an-note">All of peer-to-peer is off by default. Turning on the master switch alone changes nothing — each feature below is a separate opt-in.</p>`,
  );

  const features = section(
    "Features",
    featureToggle(
      "an-p2p-toggle-sites",
      "peer site loading",
      "Try a peer first when opening a site, then fall back to the CDN. A peer serves only sites it owns.",
      settings.sites,
      masterOn,
    ) +
      featureToggle(
        "an-p2p-toggle-collab",
        "live collaboration",
        "Block edits and cursors ride the data channel as well as the relay branch. The relay stays the convergence safety net, and the relay poll slows to 30 s while P2P is connected.",
        settings.collab,
        masterOn,
      ) +
      featureToggle(
        "an-p2p-toggle-mail",
        "peer mail delivery",
        "Deliver mail straight to an online peer when they are connected; otherwise the mail still goes to their GitHub inbox.",
        settings.mail,
        masterOn,
      ) +
      featureToggle(
        "an-p2p-toggle-drive",
        "ArkDrive device sync",
        "Offer freshly uploaded chunks to your own online devices. The repo blobs stay the durable copy — P2P only moves bytes faster.",
        settings.drive,
        masterOn,
      ) +
      featureToggle(
        "an-p2p-toggle-serve",
        "serve my sites to peers",
        "Let other devices fetch sites you own from this device. Only your own domains, only over an encrypted channel.",
        settings.serveSites,
        masterOn,
      ),
  );

  const identity = section(
    "This device",
    `<p>Peer ID: <code>${esc(deps.peerId)}</code></p>` +
      `<p>${deps.selfAddress ? `Address: <code>${esc(deps.selfAddress)}</code>` : "No protocol address yet — sign in with GitHub and claim a domain to get one."}</p>` +
      `<p><button id="an-p2p-rotate-id" type="button">Rotate peer ID</button> <button id="an-p2p-reset-id" type="button">Reset peer ID and clear all P2P settings</button></p>` +
      `<p class="an-note">Rotating the peer ID stops advertising the old one — peers that only knew the old ID will find this device again through its address ad. Resetting also wipes every toggle above and any TURN key you entered, back to the all-off default.</p>`,
  );

  const turn = section(
    "Relay (TURN) — only when direct fails",
    `<p><button id="an-p2p-toggle-turn" type="button" aria-pressed="${settings.turn.enabled}"${masterOn ? "" : " disabled"}>${settings.turn.enabled ? "Turn off relay fallback" : "Turn on relay fallback"}</button></p>` +
      `<p class="an-note">${esc(P2P_FREETURN_NOTE)}</p>` +
      `<p class="an-note">${esc(P2P_OPENRELAY_DEMO_NOTE)}</p>` +
      `<p class="an-note">${esc(P2P_NO_ACCOUNT_NOTE)}</p>` +
      `<label><input id="an-p2p-turn-freeturn" type="checkbox"${settings.turn.useFreeTurn ? " checked" : ""}${masterOn ? "" : " disabled"}> Include the freeturn.net no-account relay as a fallback (on by default, needs no signup)</label>` +
      `<label><input id="an-p2p-turn-openrelay-demo" type="checkbox"${settings.turn.useOpenRelayDemo ? " checked" : ""}${masterOn ? "" : " disabled"}> Include Open Relay's public demo credential as a fallback (off by default — shared community credential, shared quota)</label>` +
      `<label>Per-user TURN provider <select id="an-p2p-turn-provider"${masterOn ? "" : " disabled"}>` +
      `<option value="none"${settings.turn.provider === "none" ? " selected" : ""}>None — no-account fallbacks only</option>` +
      `<option value="metered-openrelay"${settings.turn.provider === "metered-openrelay" ? " selected" : ""}>Metered Open Relay (your own API key)</option>` +
      `<option value="cloudflare"${settings.turn.provider === "cloudflare" ? " selected" : ""}>Cloudflare TURN (your own token)</option>` +
      `<option value="custom"${settings.turn.provider === "custom" ? " selected" : ""}>Custom TURN server (your own URLs + credential)</option>` +
      `</select></label>` +
      `<label>Provider API key / credential (optional, yours only) <input id="an-p2p-turn-apikey" type="password" autocomplete="off" placeholder="Your own Metered API key or Cloudflare token" value="${esc(settings.turn.apiKey)}"${masterOn ? "" : " disabled"}></label>` +
      `<label>Custom TURN URLs, comma-separated (provider “custom” only) <input id="an-p2p-turn-urls" type="text" placeholder="turns:turn.example.org:5349" value="${esc(settings.turn.urls.join(", "))}"${masterOn ? "" : " disabled"}></label>` +
      `<p class="an-note">Your own keys stay on this device, in the same encrypted store as the settings. No account of yours was created to provide a relay — the defaults need no account at all.</p>`,
  );

  const privacy = section("Relay privacy", `<p class="an-note">${esc(P2P_RELAY_PRIVACY_NOTE)}</p>`);

  const diagnostics = section(
    "Connections",
    (deps.connectedPeers.length === 0
      ? `<p>No P2P peers connected. ${masterOn ? "Peers appear here once a connection opens — presence is discovered through the relay poll, so a peer you share a site or a team with shows up within a poll cycle." : "Turn peer-to-peer on above to connect."}</p>`
      : `<ul>${deps.connectedPeers
          .map(
            (peer) =>
              `<li><code>${esc(peer.peerId.slice(0, 12))}</code>${peer.address ? ` — ${esc(peer.address)}` : ""}<br>${esc(peer.diagnostics?.summary ?? "Connection open; diagnostics unavailable.")}</li>`,
          )
          .join("")}</ul>`) +
      `<p class="an-note">ICE servers in effect: ${deps.iceServersInEffect.length ? esc(deps.iceServersInEffect.join(", ")) : "none"}</p>`,
  );

  return h + intro + features + identity + turn + privacy + diagnostics;
}

/**
 * Mount the P2P panel into `root`: render, then bind the toggles,
 * the TURN fields, and the peer-ID buttons. A toggle flips its
 * setting, notifies onSettingsChange, and re-renders in place so the
 * button labels and the disabled states stay truthful.
 */
export function mountP2PPanel(root: HTMLElement, deps: P2PPanelDeps): void {
  let settings: P2PSettings = { ...defaultP2PSettings(), ...deps.settings };
  const render = (): void => {
    root.innerHTML = renderP2PPanelHtml({ ...deps, settings });
    const $ = (id: string) => root.querySelector<HTMLElement>(`#${id}`) as HTMLButtonElement | HTMLInputElement | null;
    const flip = (mutate: (next: P2PSettings) => void): void => {
      const next: P2PSettings = {
        ...settings,
        turn: { ...settings.turn, urls: [...settings.turn.urls] },
      };
      mutate(next);
      settings = next;
      deps.onSettingsChange?.(settings);
      render();
    };
    const masterBtn = $("an-p2p-toggle-master");
    masterBtn?.addEventListener("click", () => flip((next) => {
      next.enabled = !next.enabled;
    }));
    const featureBtn = (id: string, key: "sites" | "collab" | "mail" | "drive" | "serveSites"): void => {
      $(id)?.addEventListener("click", () =>
        flip((next) => {
          next[key] = !next[key];
        }),
      );
    };
    featureBtn("an-p2p-toggle-sites", "sites");
    featureBtn("an-p2p-toggle-collab", "collab");
    featureBtn("an-p2p-toggle-mail", "mail");
    featureBtn("an-p2p-toggle-drive", "drive");
    featureBtn("an-p2p-toggle-serve", "serveSites");
    $("an-p2p-toggle-turn")?.addEventListener("click", () =>
      flip((next) => {
        next.turn.enabled = !next.turn.enabled;
      }),
    );
    const turnCheckbox = (id: string, key: "useFreeTurn" | "useOpenRelayDemo"): void => {
      const input = $(id) as HTMLInputElement | null;
      input?.addEventListener("change", () => {
        flip((next) => {
          next.turn[key] = input.checked;
        });
      });
    };
    turnCheckbox("an-p2p-turn-freeturn", "useFreeTurn");
    turnCheckbox("an-p2p-turn-openrelay-demo", "useOpenRelayDemo");
    const providerSelect = $("an-p2p-turn-provider") as HTMLSelectElement | null;
    providerSelect?.addEventListener("change", () => {
      const value = providerSelect.value;
      flip((next) => {
        next.turn.provider =
          value === "metered-openrelay" || value === "cloudflare" || value === "custom"
            ? value
            : "none";
      });
    });
    const apiKeyInput = $("an-p2p-turn-apikey") as HTMLInputElement | null;
    apiKeyInput?.addEventListener("change", () => {
      flip((next) => {
        next.turn.apiKey = apiKeyInput.value.trim();
      });
    });
    const urlsInput = $("an-p2p-turn-urls") as HTMLInputElement | null;
    urlsInput?.addEventListener("change", () => {
      flip((next) => {
        next.turn.urls = urlsInput.value
          .split(",")
          .map((u) => u.trim())
          .filter((u) => u !== "");
      });
    });
    $("an-p2p-rotate-id")?.addEventListener("click", () => {
      deps.onRotatePeerId?.();
      render();
    });
    $("an-p2p-reset-id")?.addEventListener("click", () => {
      deps.onResetPeerId?.();
      settings = { ...defaultP2PSettings() };
      render();
    });
  };
  render();
}
