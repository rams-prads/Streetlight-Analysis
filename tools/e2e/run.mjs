// Browser tests: drives headless Chrome over the DevTools Protocol (Node 22+ built-in WebSocket, no packages).
//   node tools/e2e/run.mjs                    run every suite, each in a fresh Chrome
//   node tools/e2e/run.mjs core.mjs           run one suite
// The app opens from file:// at 19:30 on the snapshot day (after sunset). Screenshots go to the OS temp folder.
// Set CHROME to the browser's path if it is not in the usual place.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SUITES = ['core.mjs', 'confidence.mjs', 'server.mjs'];
const [, , suite] = process.argv;
if (!suite) {
  let failedSuites = 0;
  for (const s of SUITES) {
    console.log(`\n=== ${s}`);
    failedSuites += spawnSync(process.execPath, [fileURLToPath(import.meta.url), s], { stdio: 'inherit' }).status ? 1 : 0;
  }
  console.log(failedSuites ? `\n${failedSuites} suite(s) FAILED` : '\nall suites passed');
  process.exit(failedSuites ? 1 : 0);
}
const pageUrl = `${pathToFileURL(path.join(here, '..', '..', 'index.html')).href}?now=2026-10-13T19:30`;
const stepsFile = path.resolve(here, suite);
const outDir = path.join(os.tmpdir(), 'slgis-e2e', path.basename(suite, '.mjs'));
const CHROME = process.env.CHROME ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('Chrome not found: set CHROME to its path'); process.exit(1); }
const PORT = 9333;
const profile = path.join(outDir, 'chrome-profile');
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* a locked profile from a crashed run: reuse it */ }
fs.mkdirSync(outDir, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars',
  '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let version = null;
for (let i = 0; i < 60 && !version; i++) {
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); }
}
if (!version) { console.error('Chrome did not start'); chrome.kill(); process.exit(1); }

const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let seq = 0;
const pending = new Map();
const logs = [];
const listeners = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
    return;
  }
  const p = msg.params ?? {};
  if (msg.method === 'Runtime.consoleAPICalled') logs.push({ type: p.type, text: p.args.map((a) => a.value ?? a.description ?? '').join(' ') });
  else if (msg.method === 'Runtime.exceptionThrown') { const d = p.exceptionDetails; const frames = (d.stackTrace?.callFrames ?? []).slice(0, 6).map((f) => `${f.functionName || '(anon)'}@${f.url.split('/').pop()}:${f.lineNumber + 1}`).join(' < '); logs.push({ type: 'EXCEPTION', text: `${d.exception?.description ?? d.text} ${frames ? `[${frames}]` : `[${(d.url ?? '').split('/').pop()}:${(d.lineNumber ?? 0) + 1}]`}` }); }
  else if (msg.method === 'Log.entryAdded') logs.push({ type: `log:${p.entry.level}`, text: `${p.entry.text} ${p.entry.url ?? ''}` });
  else if (msg.method === 'Network.loadingFailed' && !p.canceled) logs.push({ type: 'NETFAIL', text: `${p.errorText} ${p.blockedReason ?? ''}` });
  for (const l of listeners) l(msg);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const waitEvent = (method, timeout = 15000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeout);
  listeners.push(function l(msg) { if (msg.method === method) { clearTimeout(t); listeners.splice(listeners.indexOf(l), 1); resolve(msg.params); } });
});

await send('Runtime.enable');
await send('Page.enable');
await send('Log.enable');
await send('Network.enable');

const api = {
  sleep,
  logs,
  send,
  pageUrlBase: pageUrl,
  async viewport(width, height, mobile = false) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  },
  async goto(url = pageUrl) {
    const loaded = waitEvent('Page.loadEventFired', 30000);
    await send('Page.navigate', { url });
    await loaded;
  },
  async eval(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n  in: ${expr.slice(0, 160)}`);
    return r.result.value;
  },
  async shot(name) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, name), Buffer.from(r.data, 'base64'));
    console.log(`  [shot] ${name}`);
  },
  async shotClip(name, clip) {
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 2 } });
    fs.writeFileSync(path.join(outDir, name), Buffer.from(r.data, 'base64'));
    console.log(`  [shot] ${name}`);
  },
  async move(x, y) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }); },
  async click(x, y) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  },
  async key(key, code = key, keyCode = 0) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
  },
  async type(text) { await send('Input.insertText', { text }); },
};

let failed = 0;
const check = (cond, label, extra = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`);
  if (!cond) failed++;
};
try {
  const steps = await import(pathToFileURL(path.resolve(stepsFile)).href);
  await steps.default(api, check);
} catch (err) {
  console.log(`  FAIL  step crashed: ${err.message}`);
  failed++;
} finally {
  const noisy = logs.filter((l) => /EXCEPTION|error|NETFAIL/i.test(l.type));
  console.log(`\nconsole: ${logs.length} messages, ${noisy.length} errors/exceptions/network failures`);
  for (const l of logs) console.log(`  [${l.type}] ${l.text.slice(0, 300)}`);
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  ws.close();
  chrome.kill();
  process.exit(failed ? 1 : 0);
}
