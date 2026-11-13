// Chrome に偽のマイクを渡し、ページを ?autotest=8 で開いて、8秒録音した結果を読む。
// 使い方: node test/smoke.mjs   （CHROME で Chrome の場所を指定できる）
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  try { const f = await readFile(join(root, p === '/' ? 'index.html' : p)); res.writeHead(200, { 'content-type': types[extname(p)] || 'text/html; charset=utf-8' }); res.end(f); }
  catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const chrome = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = mkdtempSync(join(tmpdir(), 'rec-smoke-'));
const dbg = 9300 + Math.floor(Math.random() * 400);
const proc = spawn(chrome, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${dbg}`, `--user-data-dir=${profile}`,
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = null, out = null;
try {
  let target = null;
  for (let i = 0; i < 40 && !target; i++) { await sleep(250); try { target = (await (await fetch(`http://127.0.0.1:${dbg}/json`)).json()).find((t) => t.type === 'page'); } catch {} }
  if (!target) throw new Error('Chrome につながらない');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const wait = new Map(); const errors = [];
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m.result); wait.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || '')); };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; wait.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?autotest=8` });
  const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  let done = null;
  for (let i = 0; i < 80 && !done; i++) { await sleep(500); done = await ev('document.body.dataset.done || null'); }
  out = await ev(`JSON.stringify({ done: document.body.dataset.done || null, verdict: document.getElementById('verdict').textContent, kv: [...document.querySelectorAll('#kv dt')].map((d) => d.textContent + ': ' + d.nextElementSibling.textContent), state: document.getElementById('state').textContent, support: document.getElementById('support').textContent, log: document.getElementById('log').textContent })`);
  out = JSON.parse(out);
  if (errors.length) fail = 'ページでエラー: ' + errors.join(' / ');
  else if (out.done !== 'ok') fail = '録音が途切れなしで終わらなかった';
  ws.close();
} catch (e) { fail = String(e.message || e); }
proc.kill(); server.close(); await sleep(500); try { rmSync(profile, { recursive: true, force: true }); } catch {}
console.log(JSON.stringify(out, null, 1));
console.log(fail ? 'FAIL: ' + fail : 'PASS');
process.exit(fail ? 1 : 0);
