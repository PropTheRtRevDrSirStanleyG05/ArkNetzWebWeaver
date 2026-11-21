// ArkNetzWebWeaver — P2P transport core (arknetz-p2p/1), phase 1.
// Optional WebRTC transport, OFF by default. See P2P-SPEC.md.
// Phase 1 builds the core only — no feature is wired to it yet
// (phase 2). Nothing in this directory touches the DOM, IndexedDB,
// the UI, or the real GitHub API directly: network goes through
// injected fetch functions, connections through an injected factory.

export * from "./types.js";
export * from "./ice.js";
export * from "./identity.js";
export * from "./signaling.js";
export * from "./transport.js";
export * from "./transfer.js";
export * from "./peer-manager.js";
export * from "./site-sharing.js";
export * from "./collab-p2p.js";
export * from "./mail-p2p.js";
export * from "./drive-p2p.js";
