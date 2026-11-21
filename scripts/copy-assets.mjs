// Copy static frontend assets into dist/ after tsc.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

mkdirSync("dist", { recursive: true });
cpSync("src/index.html", "dist/index.html");
cpSync("src/styles.css", "dist/styles.css");
cpSync("src/favicon.svg", "dist/favicon.svg");

// Vendor the Zstd ESM web build (@bokuweb/zstd-wasm, MIT) so the
// Tauri webview can load it without a bundler or a CDN:
//   dist/vendor/zstd/index.web.js (+ module.js, zstd.js, simple/,
//   errors/, zstd.wasm)
// src/lib/zstd.ts dynamically imports ./vendor/zstd/index.web.js in the
// browser; init() resolves zstd.wasm from import.meta.url, i.e. the
// vendored copy next to the module. Only .js and .wasm are copied —
// no .d.ts, no source maps.
const esmDir = "node_modules/@bokuweb/zstd-wasm/dist/esm";
const vendorDir = "dist/vendor/zstd";
if (existsSync(esmDir)) {
  rmSync(vendorDir, { recursive: true, force: true });
  mkdirSync(vendorDir, { recursive: true });
  const copyJsWasm = (src, dest) => {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) {
      const s = join(src, entry);
      const d = join(dest, entry);
      if (statSync(s).isDirectory()) {
        copyJsWasm(s, d);
      } else if (entry.endsWith(".js") || entry.endsWith(".wasm")) {
        cpSync(s, d);
      }
    }
  };
  copyJsWasm(esmDir, vendorDir);
  console.log("zstd web build vendored to dist/vendor/zstd/");
} else {
  console.log("WARNING: @bokuweb/zstd-wasm ESM build not found — Zstd will not load in the browser build. Run `npm install`.");
}

// Vendor the Argon2id ESM build (@noble/hashes, MIT) the same way:
// src/lib/drive/crypto.ts dynamically imports
// ../../vendor/noble-hashes/argon2.js in the browser. The package is a
// flat directory of .js files with relative imports, so copying all of
// them preserves the module graph. No .d.ts, no source maps.
const nobleDir = "node_modules/@noble/hashes";
const nobleVendorDir = "dist/vendor/noble-hashes";
if (existsSync(nobleDir)) {
  rmSync(nobleVendorDir, { recursive: true, force: true });
  mkdirSync(nobleVendorDir, { recursive: true });
  for (const entry of readdirSync(nobleDir)) {
    const s = join(nobleDir, entry);
    if (!statSync(s).isDirectory() && entry.endsWith(".js")) cpSync(s, join(nobleVendorDir, entry));
  }
  console.log("noble-hashes vendored to dist/vendor/noble-hashes/");
} else {
  console.log("WARNING: @noble/hashes not found — Argon2id will not load in the browser build. Run `npm install`.");
}

// Copy the protocol-root actions (register.yml etc.) into dist/ so
// the packaged app and the tests read the same files that ship.
const protocolDir = "protocol";
if (existsSync(protocolDir)) {
  cpSync(protocolDir, "dist/protocol", { recursive: true });
  console.log("protocol/ copied to dist/protocol/");
}

console.log("assets copied to dist/");
