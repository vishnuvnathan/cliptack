// Renders promo.html to an MP4, one frame at a time.
//
//   node promo/render.mjs                       -> docs/media/cliptack-promo.mp4
//   node promo/render.mjs --stills 5.5,14.8     -> PNG stills, for checking a frame
//   node promo/render.mjs --fps 30 --out x.mp4
//
// No dependencies: it starts Chrome (or Edge) headless and talks to it over the
// DevTools protocol with Node's built-in WebSocket (Node 22+), then pipes PNG
// screenshots into ffmpeg, which must be on PATH. Set CHROME to pick a browser.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const FPS = Number(args.fps ?? 60);
const OUT = resolve(args.out ?? join(here, "..", "docs", "media", "cliptack-promo.mp4"));
const PORT = 9333;

const browser = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].find((p) => p && existsSync(p));
if (!browser) throw new Error("No Chrome or Edge found; set CHROME to its path.");

const profile = mkdtempSync(join(tmpdir(), "cliptack-promo-"));
const chrome = spawn(browser, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--hide-scrollbars", "--force-color-profile=srgb", "--window-size=1920,1080", "about:blank",
], { stdio: "ignore" });

async function pageSocket() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Chrome did not open a debugging port.");
}

const ws = new WebSocket(await pageSocket());
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let nextId = 0;
const pending = new Map(), waiters = [];
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) {
    const { ok, fail } = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? fail(new Error(msg.error.message)) : ok(msg.result);
  } else if (msg.method) {
    for (const w of waiters.filter((w) => w.method === msg.method)) { waiters.splice(waiters.indexOf(w), 1); w.ok(msg.params); }
  }
};
// A call that never answers (Chrome died, the machine slept) fails instead of
// leaving ffmpeg waiting on stdin forever.
const send = (method, params = {}) => new Promise((ok, fail) => {
  const id = ++nextId;
  const timer = setTimeout(() => { pending.delete(id); fail(new Error(`${method} timed out`)); }, 30000);
  pending.set(id, { ok: (v) => { clearTimeout(timer); ok(v); }, fail: (e) => { clearTimeout(timer); fail(e); } });
  ws.send(JSON.stringify({ id, method, params }));
});
const once = (method) => new Promise((ok) => waiters.push({ method, ok }));
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
const loaded = once("Page.loadEventFired");
await send("Page.navigate", { url: pathToFileURL(join(here, "promo.html")).href + "?render" });
await loaded;
await evaluate("document.fonts.ready.then(() => document.fonts.size)");
const duration = await evaluate("window.__promo.DURATION");

const frameAt = async (t) => {
  await evaluate(`window.__promo.seek(${t}); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  const { data } = await send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true });
  return Buffer.from(data, "base64");
};

try {
  if (args.stills) {
    for (const t of args.stills.split(",").map(Number)) {
      const file = join(args.dir ?? process.cwd(), `still-${t.toFixed(2)}.png`);
      writeFileSync(file, await frameAt(t));
      console.log(file);
    }
  } else {
    const ffmpeg = spawn("ffmpeg", [
      "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-",
      "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", OUT + ".part",
    ], { stdio: ["pipe", "inherit", "inherit"] });
    const done = new Promise((r, j) => ffmpeg.on("close", (c) => (c ? j(new Error(`ffmpeg exited ${c}`)) : r())));
    const total = Math.round(duration * FPS);
    const started = Date.now();
    for (let f = 0; f < total; f++) {
      let png;
      try { png = await frameAt(f / FPS); } catch (e) { ffmpeg.kill(); throw e; }
      if (!ffmpeg.stdin.write(png)) await new Promise((r) => ffmpeg.stdin.once("drain", r));
      if (f % FPS === 0) process.stdout.write(`\r${f}/${total} frames  ${((Date.now() - started) / 1000).toFixed(0)}s`);
    }
    ffmpeg.stdin.end();
    await done;
    renameSync(OUT + ".part", OUT); // only a finished render replaces the old one
    console.log(`\n${OUT}`);
  }
} finally {
  ws.close();
  chrome.kill();
  await new Promise((r) => setTimeout(r, 500));
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
