// P2P phase-2 screenshot harness: serve the built frontend, drive
// headless Chrome over CDP (Node 24 built-in WebSocket, no deps),
// open the P2P panel, screenshot at desktop + 390px widths.
// Usage: node p2p-panel-shots.mjs <dist-dir> <out-dir>
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const [distDir, outDir] = process.argv.slice(2);
if (!distDir || !outDir) {
  console.error("usage: node p2p-panel-shots.mjs <dist-dir> <out-dir>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
// Every CDP round-trip gets a hard timeout so a hang becomes a loud
// error instead of silence (a 120s silent hang bit the first version).
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms)),
  ]);
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
const server = http.createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    let file = path.join(distDir, urlPath === "/" ? "index.html" : urlPath);
    if (!file.startsWith(distDir)) throw new Error("bad path");
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/`;
log("serving", base);

// Chrome for Testing from the Puppeteer cache (the Hatch-patched
// /opt/meta-chromium/chrome refuses to start here: "Hatch WebGL
// domain policy is required for browser startup").
const CHROME = `${process.env.HOME}/.cache/puppeteer/chrome/linux-156.0.8078.47/chrome-linux64/chrome`;
const CDP_PORT = 9444;
const chrome = spawn(CHROME, [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  `--remote-debugging-port=${CDP_PORT}`,
  "--user-data-dir=/tmp/p2p-shots-profile2",
  "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
chrome.stderr.on("data", (d) => process.stderr.write(`[chrome] ${d}`));
const cleanup = () => { try { chrome.kill(); } catch {} server.close(); };
process.on("exit", cleanup);

let devtoolsUrl = "";
for (let i = 0; i < 30 && !devtoolsUrl; i++) {
  await new Promise((r) => setTimeout(r, 200));
  try {
    const out = execSync(`curl -s --max-time 2 http://127.0.0.1:${CDP_PORT}/json/version 2>/dev/null || true`, { encoding: "utf8" });
    const m = /"webSocketDebuggerUrl":\s*"([^"]+)"/.exec(out);
    if (m) devtoolsUrl = m[1];
  } catch { /* not up yet */ }
}
if (!devtoolsUrl) {
  console.error("could not reach chrome devtools on", CDP_PORT);
  process.exit(1);
}
log("devtools up:", devtoolsUrl);

const ws = new WebSocket(devtoolsUrl);
await withTimeout(new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = (e) => reject(new Error(`ws error: ${e.message ?? e.type}`));
}), 15000, "websocket open");
log("websocket open");
let msgId = 0;
const pending = new Map();
// Flat mode: session messages go directly on the browser socket with a
// top-level `sessionId` attribute — NOT via Target.sendMessageToTarget
// (Chrome rejects that under flat mode with -32000, and the error reply
// went to an id nobody listened to, which was the silent hang).
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
function send(method, params = {}) {
  return withTimeout(new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  }), 20000, `browser ${method}`);
}
const created = await send("Target.createTarget", { url: "about:blank" });
log("target created:", created.result?.targetId);
const attached = await send("Target.attachToTarget", { targetId: created.result.targetId, flatten: true });
const sessionId = attached.result.sessionId;
log("attached, session:", sessionId);
async function sendSession(method, params = {}) {
  const id = ++msgId;
  const promise = new Promise((resolve) => pending.set(id, resolve));
  ws.send(JSON.stringify({ id, sessionId, method, params }));
  const reply = await withTimeout(promise, 20000, `session ${method}`);
  if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
}
async function evalJs(expression) {
  const r = await sendSession("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}
async function shot(name) {
  const r = await sendSession("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(outDir, name), Buffer.from(r.data, "base64"));
  log("wrote", name);
}

await sendSession("Page.enable");
await sendSession("Runtime.enable");
await sendSession("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await sendSession("Page.navigate", { url: base });
log("navigated, waiting for boot");
await new Promise((r) => setTimeout(r, 2500));
// The app boots async (init renders tabs + mounts panels).
const navReady = await evalJs(`!!document.querySelector('button[data-panel="p2p"]')`);
log("p2p nav button present:", navReady);
if (!navReady) {
  log("page text:", (await evalJs(`document.body.innerText.slice(0, 500)`)));
  throw new Error("P2P nav button not found");
}
await evalJs(`document.querySelector('button[data-panel="p2p"]').click()`);
await new Promise((r) => setTimeout(r, 1500));
await shot("p2p-panel-desktop.png");
// Toggle the master switch on, screenshot again (features enabled).
await evalJs(`document.getElementById('an-p2p-toggle-master')?.click()`);
await new Promise((r) => setTimeout(r, 800));
await shot("p2p-panel-desktop-on.png");
// 390px mobile width.
await sendSession("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await new Promise((r) => setTimeout(r, 800));
await shot("p2p-panel-390px.png");
// And the master-on state at 390px (fresh click may be needed after reflow).
await evalJs(`document.querySelector('button[data-panel="p2p"]')?.click()`);
await new Promise((r) => setTimeout(r, 1200));
await shot("p2p-panel-390px-after-nav.png");
// Lower sections at desktop width: scroll the TURN block into view
// (relay privacy note + provider/API-key fields), then the bottom
// (This device peer ID + Rotate/Reset, connections + ICE servers in
// effect diagnostics). These sit below the fold in the shots above.
await sendSession("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await new Promise((r) => setTimeout(r, 500));
await evalJs(`document.getElementById('an-p2p-turn-provider')?.scrollIntoView({block:'start'})`);
await new Promise((r) => setTimeout(r, 600));
await shot("p2p-panel-desktop-turn.png");
await evalJs(`window.scrollTo(0, document.body.scrollHeight)`);
await new Promise((r) => setTimeout(r, 600));
await shot("p2p-panel-desktop-bottom.png");

ws.close();
chrome.kill();
server.close();
log("done");
process.exit(0);
