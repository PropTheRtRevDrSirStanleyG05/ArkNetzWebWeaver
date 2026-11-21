// ArkNetzWebWeaver — P2P site sharing adapter.
// A peer who has a site bundle cached can serve it directly to
// another reader instead of the GitHub CDN. Verification (P2P-SPEC.md
// §8.1): the received bytes are SHA-256-checked when the caller can
// supply an expected hash, and the decompressed document is ALWAYS
// parsed and checked against the requested domain. A bundle that
// fails any check is discarded and the caller falls back to the CDN.
//
// HONEST GAP: registry entries carry no content hash today, so a
// first-time fetch cannot be verified against the registry pointer —
// only against the parsed document and the serving peer's ad. Full
// registry-pointer verification needs a protocol change (an optional
// `siteSha256` on registry entries). This adapter never claims a
// check it did not perform: `fetchFromPeer` reports which checks ran.

import { decompressJson } from "../zstd.js";
import { parseSiteDocument } from "../registry.js";
import type { P2PConnection } from "./transport.js";
import { TransferHub, sha256HexBytes } from "./transfer.js";
import { P2P_CHANNEL_LABELS, type PeerAd } from "./types.js";

export interface SiteFetchResult {
  /** The raw .zst bytes, exactly as received. */
  bytes: Uint8Array;
  /** True when the bytes matched the caller-supplied expected hash. */
  hashChecked: boolean;
  /** True when the document parsed and its domain matched. */
  documentChecked: boolean;
}

export interface SiteSharingOptions {
  /** The local peer's ad (for the `serves` check on the serve side). */
  selfAd: PeerAd | null;
  /** True when the user allows other peers to fetch bundles from me. */
  serveSites: boolean;
  /** Look up a cached bundle to serve (IndexedDB cache in phase 2).
   *  Null = I do not have this bundle cached (never a fresh CDN
   *  fetch on someone else's behalf — serving costs no GitHub
   *  traffic). */
  getCachedBundle?: (domain: string) => Promise<Uint8Array | null>;
}

interface PendingFetch {
  domain: string;
  resolve: (bytes: Uint8Array | null) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class SiteSharing {
  private hub: TransferHub | null = null;
  private pendingFetch: PendingFetch | null = null;

  constructor(private readonly options: SiteSharingOptions) {}

  /** Attach to a peer connection (creates the site channel + hub).
   *  Call once per peer. */
  attach(connection: P2PConnection): void {
    const channel = connection.createChannel(P2P_CHANNEL_LABELS.site);
    this.hub = new TransferHub(channel);
    this.hub.onControl = (msg) => {
      if (msg.t === "site-request") {
        void this.handleSiteRequest(msg.domain);
        return;
      }
      if (msg.t === "site-error" && this.pendingFetch?.domain === msg.domain) {
        this.finishFetch(null);
      }
    };
    this.hub.onTransfer = (kind, payload) => {
      if (kind === "site-bundle" && this.pendingFetch) {
        this.finishFetch(payload);
      }
    };
    channel.onclose = () => {
      this.finishFetch(null);
      this.hub?.detach();
      this.hub = null;
    };
  }

  detach(): void {
    this.finishFetch(null);
    this.hub?.detach();
    this.hub = null;
  }

  private finishFetch(bytes: Uint8Array | null): void {
    const pending = this.pendingFetch;
    if (!pending) return;
    this.pendingFetch = null;
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(bytes);
  }

  /** Serve-side: answer a peer's site request with my cached bundle,
   *  or a site-error when I cannot serve it. */
  private async handleSiteRequest(domain: string): Promise<void> {
    const hub = this.hub;
    if (!hub) return;
    const deny = (reason: string): void => {
      try {
        hub.sendControl({ t: "site-error", domain, reason });
      } catch {
        // Channel gone — nothing to tell.
      }
    };
    if (!this.options.serveSites) return deny("serving is off on this peer");
    const selfAd = this.options.selfAd;
    if (!selfAd || !selfAd.serves.includes(domain.toLowerCase())) {
      return deny(`this peer does not serve ${domain}`);
    }
    const bundle = (await this.options.getCachedBundle?.(domain)) ?? null;
    if (!bundle) return deny(`this peer has no cached bundle for ${domain}`);
    const ok = await hub.sendTransfer("site-bundle", bundle);
    if (!ok) {
      hub.onError?.(new Error(`serving ${domain} to a peer failed`));
    }
  }

  /** Fetch a site bundle from this peer. Resolves with the verified
   *  bytes, or null on any failure (the caller falls back to the CDN
   *  — null is not an error here). `expectedSha256` is checked when
   *  supplied; the document check always runs. Only one fetch at a
   *  time per peer (a second call while one is in flight returns
   *  null immediately — the caller retries over the CDN instead). */
  async fetchFromPeer(domain: string, expectedSha256?: string): Promise<SiteFetchResult | null> {
    const hub = this.hub;
    if (!hub || this.pendingFetch) return null;
    const received = await new Promise<Uint8Array | null>((resolve) => {
      const timer = setTimeout(() => this.finishFetch(null), 30_000);
      this.pendingFetch = { domain, resolve, timer };
      try {
        hub.sendControl({ t: "site-request", domain });
      } catch {
        this.finishFetch(null);
      }
    });
    if (!received) return null;
    if (expectedSha256) {
      const actual = await sha256HexBytes(received);
      if (actual !== expectedSha256) return null;
    }
    // The document check always runs: decompress + parse + domain.
    try {
      const doc = parseSiteDocument(await decompressJson(received));
      if (doc.domain.toLowerCase() !== domain.toLowerCase()) return null;
    } catch {
      return null;
    }
    return { bytes: received, hashChecked: Boolean(expectedSha256), documentChecked: true };
  }
}
