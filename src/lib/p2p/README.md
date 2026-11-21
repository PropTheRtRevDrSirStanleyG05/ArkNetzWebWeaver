# P2P transport core — `src/lib/p2p/`

Optional WebRTC peer-to-peer transport (arknetz-p2p/1), OFF by
default. Full spec: `~/workspace/arknetzwebweaver/P2P-SPEC.md`.

## What is here (phase 1)

| File | What it does |
|---|---|
| `types.ts` | Shared shapes: settings, peer ads, signal + control messages. |
| `ice.ts` | No-account ICE servers (STUN default-on, TURN opt-in), assembly, connection diagnostics, settings UI copy. |
| `identity.ts` | Peer IDs (random per device) + peer-ad build/parse/validate. |
| `signaling.ts` | Peer-ad publish/fetch + sealed signal Issues in `protocol-inbox`. |
| `transport.ts` | `P2PConnection` interface, WebRTC adapter, loopback pair (tests). |
| `transfer.ts` | Chunked, SHA-256-verified transfer over one data channel + token bucket. |
| `peer-manager.ts` | Settings, known peers, offer/answer handshake, glare rule, timeouts. |
| `site-sharing.ts` | Serve/fetch cached site bundles, verified, CDN fallback. |
| `collab-p2p.ts` | Block ops + cursors over a data channel; relay stays authoritative. |
| `mail-p2p.ts` | Sealed envelopes direct; Issue inbox is the fallback. |
| `drive-p2p.ts` | Stored (encrypted) chunk transfer between devices that hold the key. |

## Rules the code enforces

- **Off by default.** Nothing runs unless the master switch and the
  per-feature flag are both on.
- **GitHub is the fallback and the source of truth.** Every adapter
  returns "not available" on failure and the feature uses its GitHub
  path — P2P never replaces a GitHub write.
- **No shared keys.** TURN credentials are per-user (entered by the
  user) or the published no-account fallbacks in `ice.ts`. The
  static-auth endpoint is deliberately absent.
- **No secret in an ad.** Peer ads are public JSON; signals are
  sealed to the recipient's mail key before they are posted.
- **Verification before trust.** Site bundles, mail envelopes, and
  drive chunks are all verified on receipt; failures are discarded,
  never partially used.
- **Node has no WebRTC.** Tests run against the loopback transport;
  the WebRTC adapter is browser-only and throws a plain error in Node.

## Tests

`tests/p2p-*.test.ts` — identity, signaling, transport, transfer,
peer manager, ICE assembly, and the four adapters, all against
loopback + mocked GitHub fetch. Nothing touches real GitHub or real
WebRTC.
