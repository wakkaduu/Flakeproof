// Draws a fabricated group chat as plain phone screenshots with NO branding: no logo, no app name, no
// app colours. For the demo video and for testing the screenshot reader without anyone's real messages.
//
//   node scripts/decoy-chat/render.mjs [outDir]        (default: ./decoy-chat-out)
//   CHROME=/path/to/chrome node scripts/decoy-chat/render.mjs
//
// Needs any Chromium or Chrome. The chat is in ./chat.mjs: "Sam" is the host (right-hand bubbles).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CHAT, HOST } from './chat.mjs';

const out = resolve(process.argv[2] ?? 'decoy-chat-out');
mkdirSync(out, { recursive: true });

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    try { return execFileSync('which', [name], { encoding: 'utf8' }).trim(); } catch { /* try the next */ }
  }
  const cache = join(homedir(), '.cache', 'ms-playwright'); // a Playwright download works too
  if (existsSync(cache)) for (const d of readdirSync(cache).filter((x) => x.startsWith('chromium-'))) {
    for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) if (existsSync(join(cache, d, sub))) return join(cache, d, sub);
  }
  throw new Error('No Chrome or Chromium found. Install one or set CHROME=/path/to/chrome');
}
const CHROME = findChrome();

const VIEW_W = 390, VIEW_H = 844, HEADER = 56, FOOTER = 58;
const colors = ['#b4417a', '#2f6fb3', '#a05a00', '#2f8a5a', '#7a4fb0', '#b03a3a'];
const people = [...new Set(CHAT.filter((c) => c[0] !== 's').map((c) => c[1]))].filter((n) => n !== HOST);
const colorOf = (n) => colors[people.indexOf(n) % colors.length];
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function bubble(item, prev) {
  if (item[0] === 's') return `<div class="sep"><span>${esc(item[1])}</span></div>`;
  const [kind, who, time, text] = item;
  const me = who === HOST;
  const sameRun = prev && prev[0] !== 's' && prev[1] === who; // the sender name is printed only at the start of a run
  const body = kind === 'i' ? '<div class="photo"></div>' : `<div>${esc(text)}</div>`;
  return `<div class="row ${me ? 'me' : 'them'}"><div class="b">${!me && !sameRun ? `<div class="n" style="color:${colorOf(who)}">${esc(who)}</div>` : ''}${body}<div class="t">${time}</div></div></div>`;
}
const messages = CHAT.map((it, k) => bubble(it, CHAT[k - 1])).join('');
const css = `*{box-sizing:border-box;margin:0}html,body{width:${VIEW_W}px}body{font-family:system-ui,'Noto Sans',sans-serif;background:#e9edf2;height:${VIEW_H}px;overflow:hidden;position:relative}
header{position:absolute;top:0;left:0;right:0;height:${HEADER}px;background:#243447;color:#fff;display:flex;align-items:center;padding:0 16px;font-weight:600;font-size:17px;z-index:2}header small{font-weight:400;opacity:.7;margin-left:10px;font-size:12px}
.view{position:absolute;top:${HEADER}px;bottom:${FOOTER}px;left:0;right:0;overflow:hidden}
main{padding:8px 10px;display:flex;flex-direction:column;gap:3px}.row{display:flex}.row.me{justify-content:flex-end}.b{max-width:78%;padding:6px 9px 4px;border-radius:12px;font-size:15px;line-height:1.3}
.them .b{background:#fff}.me .b{background:#d6e4ff}.n{font-size:13px;font-weight:700;margin-bottom:1px}.t{font-size:10.5px;color:#7b8794;text-align:right;margin-top:1px}
.sep{text-align:center;margin:6px 0}.sep span{background:#cfd6de;color:#425466;font-size:12px;padding:3px 10px;border-radius:10px}
.photo{width:210px;height:130px;border-radius:8px;background:linear-gradient(135deg,#9fb4c7,#c9d6e2)}
footer{position:absolute;bottom:0;left:0;right:0;height:${FOOTER}px;background:#f6f8fa;border-top:1px solid #d3d9e0;display:flex;align-items:center;padding:0 12px;z-index:2}
footer div{flex:1;height:38px;background:#fff;border-radius:19px;border:1px solid #d3d9e0;color:#98a2ad;font-size:14px;line-height:36px;padding-left:14px}`;
const page = (y, script = '') => `<!doctype html><meta charset=utf-8><style>${css}</style><header>Weekend crew<small>6 people</small></header>
<div class="view"><main style="transform:translateY(-${y}px)">${messages}</main></div><footer><div>Message</div></footer>${script}`;

// 1) measure how tall the whole chat is, 2) take a screenshot per window, each overlapping the last by ~20%
const probe = join(out, '_probe.html');
writeFileSync(probe, page(0, '<script>document.body.dataset.h=Math.ceil(document.querySelector("main").getBoundingClientRect().height)</script>'));
const dom = execFileSync(CHROME, ['--headless=new', '--no-sandbox', '--dump-dom', `file://${probe}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const total = Number(/data-h="(\d+)"/.exec(dom)?.[1]);
if (!total) throw new Error('could not measure the chat height');
const view = VIEW_H - HEADER - FOOTER, step = Math.floor(view * 0.8);
let n = 0;
for (let y = 0; ; y += step) {
  n++;
  const file = join(out, `shot${n}`);
  writeFileSync(`${file}.html`, page(y));
  execFileSync(CHROME, ['--headless=new', '--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=2', `--window-size=${VIEW_W},${VIEW_H}`, `--screenshot=${file}.png`, `file://${file}.html`], { stdio: 'ignore' });
  if (y + view >= total) break;
}
console.log(`${CHAT.filter((c) => c[0] !== 's').length} messages -> ${n} screenshots in ${out} (shot1.png ... shot${n}.png)`);
