import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import { openDb, endLiveSessions, auditLog } from './db.mjs';
import {
  hashPassword, verifyPassword, newToken, sha256,
  sessionPassword, newSessionId, newClaimId,
} from './crypto.mjs';

const ROLES = ['admin', 'operator', 'auditor'];
const SIGNAL_WINDOW_MS = 5000;
const SIGNAL_MAX = 150;

function err(res, status, code, message) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: { code, message } }));
}

function ok(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJson(req, maxBytes) {
  return new Promise((resolve) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { resolve(undefined); }
    });
    req.on('error', () => resolve(null));
  });
}

export class RateLimiter {
  #hits = new Map();
  constructor(limit, windowMs) { this.limit = limit; this.windowMs = windowMs; }
  take(key) {
    const now = Date.now();
    let h = this.#hits.get(key);
    if (!h || now > h.reset) { h = { count: 0, reset: now + this.windowMs }; this.#hits.set(key, h); }
    h.count += 1;
    return h.count <= this.limit;
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let n = bytes; let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

// RFC 9110: невалидный/чужой Range игнорируем (null → 200), валидный неудовлетворимый → {unsatisfiable} (416),
// единственный диапазон `bytes=start-end` / `bytes=start-` / `bytes=-suffix` → {start,end} (206).
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start; let end;
  if (m[1] === '') {
    const suffix = parseInt(m[2], 10);
    if (suffix === 0) return { unsatisfiable: true };
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? Number.POSITIVE_INFINITY : parseInt(m[2], 10);
    if (end < start) return null; // last-byte-pos < first-byte-pos — byte-range-spec невалиден, игнорируем
    if (end > size - 1) end = size - 1;
  }
  if (size === 0 || start >= size) return { unsatisfiable: true };
  return { start, end };
}

function streamOut(stream, res) {
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

const BASE_STYLE = `
:root{color-scheme:dark;--bg:#070D17;--panel:#0F1A2C;--line:#1C2C44;--text:#EAF2FF;--muted:#8FA3BF;--accent:#35E0C4}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
h1,h2,h3{margin:0;line-height:1.15}
p{margin:0}
a{color:var(--accent)}
a:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:4px}
img{max-width:100%;height:auto}
svg{display:block;flex:none}
.wrap{max-width:1180px;margin:0 auto;padding:0 24px}
.site-head{border-bottom:1px solid var(--line);background:rgba(9,15,27,.92)}
.head-inner{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:76px}
.brand{display:flex;align-items:center;gap:12px;color:var(--text);text-decoration:none}
.brand-name{font-size:20px;font-weight:800}
.brand-sep{width:1px;height:24px;background:var(--line)}
.brand-sub{color:var(--muted);font-size:14px}
.head-nav{display:flex;gap:10px}
.nav-btn{display:inline-flex;align-items:center;gap:8px;padding:10px 18px;border:1px solid var(--line);border-radius:12px;color:var(--text);text-decoration:none;font-size:15px}
.nav-btn svg{width:18px;height:18px;color:var(--muted)}
.nav-btn:hover{border-color:var(--accent);color:var(--accent)}
.nav-btn:hover svg{color:var(--accent)}
.hero{display:grid;grid-template-columns:1.05fr .95fr;gap:40px;align-items:center;padding:72px 0 56px;background:radial-gradient(720px 420px at 78% 42%,rgba(53,224,196,.16),transparent 68%)}
.eyebrow{display:flex;align-items:center;gap:12px;color:var(--accent);font-size:13px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;margin:0 0 16px}
.eyebrow::before{content:"";width:30px;height:2px;background:var(--accent)}
h1{font-size:clamp(46px,7.2vw,76px);font-weight:900;letter-spacing:-.025em;margin:0 0 20px}
.lead{color:#B9C6DC;font-size:clamp(16px,1.5vw,18px);max-width:52ch}
.cta{display:flex;flex-wrap:wrap;gap:14px;margin:30px 0 0}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;background:var(--accent);border:1px solid var(--accent);color:#05231D;font-weight:700;font-size:16px;text-decoration:none;padding:14px 28px;border-radius:12px}
.btn svg{width:19px;height:19px}
.btn:hover{background:#5FEAD3;border-color:#5FEAD3}
.btn-ghost{background:transparent;color:var(--text);border-color:#2B3D5E}
.btn-ghost svg{color:var(--accent)}
.btn-ghost:hover{background:rgba(53,224,196,.08);border-color:var(--accent);color:var(--text)}
.chips{display:flex;flex-wrap:wrap;gap:14px 28px;list-style:none;margin:34px 0 0;padding:0}
.chips li{display:flex;align-items:center;gap:9px;color:#C4D1E6;font-size:15px}
.chips svg{width:19px;height:19px;color:var(--accent)}
.mascot{width:100%;max-width:640px;justify-self:end;filter:drop-shadow(0 24px 70px rgba(53,224,196,.18));-webkit-mask-image:linear-gradient(90deg,transparent,#000 7%,#000 93%,transparent),linear-gradient(180deg,transparent,#000 9%,#000 96%,transparent);-webkit-mask-composite:source-in;mask-image:linear-gradient(90deg,transparent,#000 7%,#000 93%,transparent),linear-gradient(180deg,transparent,#000 9%,#000 96%,transparent);mask-composite:intersect}
.section{padding:56px 0 0}
.section h2{font-size:clamp(24px,3.2vw,32px);font-weight:800;margin:0 0 22px}
.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}
.card{display:flex;flex-direction:column;gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:24px}
.card.active{border-color:rgba(53,224,196,.55);box-shadow:0 0 0 1px rgba(53,224,196,.18),0 22px 60px rgba(53,224,196,.1)}
.card-head{display:flex;align-items:center;gap:14px;margin-bottom:6px}
.os-icon{display:grid;place-items:center;width:48px;height:48px;border-radius:50%;background:#16233A;color:var(--text);flex:none}
.os-icon svg{width:24px;height:24px}
.card h3{font-size:19px;font-weight:700}
.file{margin:0;font-size:15px;word-break:break-all;color:var(--text)}
.meta{margin:0;color:var(--muted);font-size:13.5px}
.card .btn{margin-top:auto;width:100%}
.soon{display:block;text-align:center;margin-top:auto;padding:13px 16px;border:1px solid var(--line);border-radius:12px;color:var(--muted);font-size:15px;background:rgba(255,255,255,.015)}
.steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px}
.step{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:24px}
.step-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:22px}
.step-num{display:grid;place-items:center;width:34px;height:34px;border-radius:50%;border:1px solid rgba(53,224,196,.45);background:rgba(53,224,196,.1);color:var(--accent);font-weight:700;font-size:15px}
.step-head svg{width:22px;height:22px;color:var(--accent)}
.step h3{font-size:17px;font-weight:700;margin:0 0 8px}
.step p{color:var(--muted);font-size:14px}
.site-foot{border-top:1px solid var(--line);margin-top:64px}
.foot-inner{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px 20px;padding:22px 0;color:var(--muted);font-size:14px}
.foot-ver{opacity:.75}
.foot-love{display:inline-flex;align-items:center;gap:8px}
.foot-love svg{width:16px;height:16px;color:var(--accent)}
.invite-page{display:flex;justify-content:center;padding:72px 24px 0}
.invite-card{display:flex;flex-direction:column;align-items:flex-start;gap:14px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:36px;max-width:620px}
.invite-card h1{font-size:clamp(26px,4vw,38px);font-weight:800;margin:0}
.invite-card .lead{max-width:56ch}
.invite-card .cta{margin-top:6px}
@media (max-width:900px){
.hero{grid-template-columns:1fr;padding:48px 0 40px;background:radial-gradient(520px 360px at 60% 100%,rgba(53,224,196,.14),transparent 70%)}
.mascot{justify-self:center;max-width:520px}
.cards,.steps{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media (max-width:640px){
.head-inner{min-height:64px}
.brand-sub,.brand-sep{display:none}
.nav-btn{padding:9px 13px;font-size:14px}
.cards,.steps{grid-template-columns:1fr}
.section{padding:40px 0 0}
.invite-page{padding:48px 20px 0}
.invite-card{padding:26px}
}
@media (max-width:400px){
.nav-btn span{display:none}
}
`.trim();

const PLATFORMS = [
  { key: 'win32', label: 'Windows', icon: 'windows' },
  { key: 'darwin', label: 'macOS', icon: 'apple' },
  { key: 'linux', label: 'Linux', icon: 'linux' },
];

const BRAND_FILES = {
  'enot-mascot.svg': 'image/svg+xml',
  'enot-icon.svg': 'image/svg+xml',
  'icon.png': 'image/png',
  'mascot-site.png': 'image/png',
  'mascot-app.png': 'image/png',
};

const ICONS = {
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  play: '<polygon points="7 4 20 12 7 20 7 4"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11.5 14.5 15.5 9.5"/>',
  bolt: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.2-3 3.5"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7.1l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7.1l1.7-1.7"/>',
  playCircle: '<circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/>',
  idCard: '<rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8.5" cy="11" r="1.8"/><path d="M5.6 15.6c.7-1.3 1.7-2.1 2.9-2.1s2.2.8 2.9 2.1"/><line x1="14.5" y1="10" x2="19" y2="10"/><line x1="14.5" y1="13.5" x2="19" y2="13.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="10"/><polyline points="8 12.4 11 15.4 16 9.6"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 3 8.5c0 2.3 1.5 4.05 3 5.5l6 6z"/>',
  apple: '<path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/>',
  windows: '<path d="M0 0h11.377v11.372H0zM12.623 0H24v11.372H12.623zM0 12.623h11.377V24H0zM12.623 12.623H24V24H12.623z"/>',
  linux: '<path d="M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489a.424.424 0 00-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68-.09.189-.136.394-.132.602 0 .199.027.4.055.536.058.399.116.728.04.97-.249.68-.28 1.145-.106 1.484.174.334.535.47.94.601.81.2 1.91.135 2.774.6.926.466 1.866.67 2.616.47.526-.116.97-.464 1.208-.946.587-.003 1.23-.269 2.26-.334.699-.058 1.574.267 2.577.2.025.134.063.198.114.333l.003.003c.391.778 1.113 1.132 1.884 1.071.771-.06 1.592-.536 2.257-1.306.631-.765 1.683-1.084 2.378-1.503.348-.199.629-.469.649-.853.023-.4-.2-.811-.714-1.376v-.097l-.003-.003c-.17-.2-.25-.535-.338-.926-.085-.401-.182-.786-.492-1.046h-.003c-.059-.054-.123-.067-.188-.135a.357.357 0 00-.19-.064c.431-1.278.264-2.55-.173-3.694-.533-1.41-1.465-2.638-2.175-3.483-.796-1.005-1.576-1.957-1.56-3.368.026-2.152.236-6.133-3.544-6.139zm.529 3.405h.013c.213 0 .396.062.584.198.19.135.33.332.438.533.105.259.158.459.166.724 0-.02.006-.04.006-.06v.105a.086.086 0 01-.004-.021l-.004-.024a1.807 1.807 0 01-.15.706.953.953 0 01-.213.335.71.71 0 00-.088-.042c-.104-.045-.198-.064-.284-.133a1.312 1.312 0 00-.22-.066c.05-.06.146-.133.183-.198.053-.128.082-.264.088-.402v-.02a1.21 1.21 0 00-.061-.4c-.045-.134-.101-.2-.183-.333-.084-.066-.167-.132-.267-.132h-.016c-.093 0-.176.03-.262.132a.8.8 0 00-.205.334 1.18 1.18 0 00-.09.4v.019c.002.089.008.179.02.267-.193-.067-.438-.135-.607-.202a1.635 1.635 0 01-.018-.2v-.02a1.772 1.772 0 01.15-.768c.082-.22.232-.406.43-.533a.985.985 0 01.594-.2zm-2.962.059h.036c.142 0 .27.048.399.135.146.129.264.288.344.465.09.199.14.4.153.667v.004c.007.134.006.2-.002.266v.08c-.03.007-.056.018-.083.024-.152.055-.274.135-.393.2.012-.09.013-.18.003-.267v-.015c-.012-.133-.04-.2-.082-.333a.613.613 0 00-.166-.267.248.248 0 00-.183-.064h-.021c-.071.006-.13.04-.186.132a.552.552 0 00-.12.27.944.944 0 00-.023.33v.015c.012.135.037.2.08.334.046.134.098.2.166.268.01.009.02.018.034.024-.07.057-.117.07-.176.136a.304.304 0 01-.131.068 2.62 2.62 0 01-.275-.402 1.772 1.772 0 01-.155-.667 1.759 1.759 0 01.08-.668 1.43 1.43 0 01.283-.535c.128-.133.26-.2.418-.2zm1.37 1.706c.332 0 .733.065 1.216.399.293.2.523.269 1.052.468h.003c.255.136.405.266.478.399v-.131a.571.571 0 01.016.47c-.123.31-.516.643-1.063.842v.002c-.268.135-.501.333-.775.465-.276.135-.588.292-1.012.267a1.139 1.139 0 01-.448-.067 3.566 3.566 0 01-.322-.198c-.195-.135-.363-.332-.612-.465v-.005h-.005c-.4-.246-.616-.512-.686-.71-.07-.268-.005-.47.193-.6.224-.135.38-.271.483-.336.104-.074.143-.102.176-.131h.002v-.003c.169-.202.436-.47.839-.601.139-.036.294-.065.466-.065zm2.8 2.142c.358 1.417 1.196 3.475 1.735 4.473.286.534.855 1.659 1.102 3.024.156-.005.33.018.513.064.646-1.671-.546-3.467-1.089-3.966-.22-.2-.232-.335-.123-.335.59.534 1.365 1.572 1.646 2.757.13.535.16 1.104.021 1.67.067.028.135.06.205.067 1.032.534 1.413.938 1.23 1.537v-.043c-.06-.003-.12 0-.18 0h-.016c.151-.467-.182-.825-1.065-1.224-.915-.4-1.646-.336-1.77.465-.008.043-.013.066-.018.135-.068.023-.139.053-.209.064-.43.268-.662.669-.793 1.187-.13.533-.17 1.156-.205 1.869v.003c-.02.334-.17.838-.319 1.35-1.5 1.072-3.58 1.538-5.348.334a2.645 2.645 0 00-.402-.533 1.45 1.45 0 00-.275-.333c.182 0 .338-.03.465-.067a.615.615 0 00.314-.334c.108-.267 0-.697-.345-1.163-.345-.467-.931-.995-1.788-1.521-.63-.4-.986-.87-1.15-1.396-.165-.534-.143-1.085-.015-1.645.245-1.07.873-2.11 1.274-2.763.107-.065.037.135-.408.974-.396.751-1.14 2.497-.122 3.854a8.123 8.123 0 01.647-2.876c.564-1.278 1.743-3.504 1.836-5.268.048.036.217.135.289.202.218.133.38.333.59.465.21.201.477.335.876.335.039.003.075.006.11.006.412 0 .73-.134.997-.268.29-.134.52-.334.74-.4h.005c.467-.135.835-.402 1.044-.7zm2.185 8.958c.037.6.343 1.245.882 1.377.588.134 1.434-.333 1.791-.765l.211-.01c.315-.007.577.01.847.268l.003.003c.208.199.305.53.391.876.085.4.154.78.409 1.066.486.527.645.906.636 1.14l.003-.007v.018l-.003-.012c-.015.262-.185.396-.498.595-.63.401-1.746.712-2.457 1.57-.618.737-1.37 1.14-2.036 1.191-.664.053-1.237-.2-1.574-.898l-.005-.003c-.21-.4-.12-1.025.056-1.69.176-.668.428-1.344.463-1.897.037-.714.076-1.335.195-1.814.12-.465.308-.797.641-.984l.045-.022zm-10.814.049h.01c.053 0 .105.005.157.014.376.055.706.333 1.023.752l.91 1.664.003.003c.243.533.754 1.064 1.189 1.637.434.598.77 1.131.729 1.57v.006c-.057.744-.48 1.148-1.125 1.294-.645.135-1.52.002-2.395-.464-.968-.536-2.118-.469-2.857-.602-.369-.066-.61-.2-.723-.4-.11-.2-.113-.602.123-1.23v-.004l.002-.003c.117-.334.03-.752-.027-1.118-.055-.401-.083-.71.043-.94.16-.334.396-.4.69-.533.294-.135.64-.202.915-.47h.002v-.002c.256-.268.445-.601.668-.838.19-.201.38-.336.663-.336zm7.159-9.074c-.435.201-.945.535-1.488.535-.542 0-.97-.267-1.28-.466-.154-.134-.28-.268-.373-.335-.164-.134-.144-.333-.074-.333.109.016.129.134.199.2.096.066.215.2.36.333.292.2.68.467 1.167.467.485 0 1.053-.267 1.398-.466.195-.135.445-.334.648-.467.156-.136.149-.267.279-.267.128.016.034.134-.147.332a8.097 8.097 0 01-.69.468zm-1.082-1.583V5.64c-.006-.02.013-.042.029-.05.074-.043.18-.027.26.004.063 0 .16.067.15.135-.006.049-.085.066-.135.066-.055 0-.092-.043-.141-.068-.052-.018-.146-.008-.163-.065zm-.551 0c-.02.058-.113.049-.166.066-.047.025-.086.068-.14.068-.05 0-.13-.02-.136-.068-.01-.066.088-.133.15-.133.08-.031.184-.047.259-.005.019.009.036.03.03.05v.02h.003z"/>',
};

function icon(name) {
  const filled = ['apple', 'windows', 'linux', 'heart'].includes(name);
  const paint = filled
    ? 'fill="currentColor"'
    : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  return `<svg viewBox="0 0 24 24" ${paint} aria-hidden="true">${ICONS[name]}</svg>`;
}

function page(res, title, bodyHtml) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(title)}</title><link rel="icon" href="/brand/enot-icon.svg" type="image/svg+xml">` +
    `<style>${BASE_STYLE}</style></head><body>${bodyHtml}</body></html>`);
}

function siteHeader() {
  return `<header class="site-head"><div class="wrap head-inner">` +
    `<a class="brand" href="/downloads"><img src="/brand/enot-icon.svg" alt="" width="40" height="40">` +
    `<span class="brand-name">EnotDesk</span><span class="brand-sep" aria-hidden="true"></span>` +
    `<span class="brand-sub">Удалённая поддержка</span></a>` +
    `<nav class="head-nav" aria-label="Основная навигация">` +
    `<a class="nav-btn" href="/downloads#download" aria-label="Помощь">${icon('help')}<span>Помощь</span></a>` +
    `<a class="nav-btn" href="/invite" aria-label="Оператор">${icon('chat')}<span>Оператор</span></a>` +
    `</nav></div></header>`;
}

function siteFooter(version) {
  return `<footer class="site-foot"><div class="wrap foot-inner">` +
    `<p>EnotDesk <span class="foot-ver">v${esc(version)}</span></p>` +
    `<p class="foot-love">${icon('heart')}<span>С заботой о ваших задачах</span></p>` +
    `</div></footer>`;
}

const STEPS = [
  { title: 'Получите ссылку', text: 'Специалист поддержки отправит вам ссылку на эту страницу в чате.', icon: 'link' },
  { title: 'Запустите программу', text: 'Скачайте файл и откройте его — установка не нужна.', icon: 'playCircle' },
  { title: 'Передайте ID и пароль', text: 'В окне программы появятся ID и одноразовый пароль — сообщите их специалисту.', icon: 'idCard' },
  { title: 'Подключение и завершение', text: 'Специалист подключится и поможет. Закрыли программу — доступ сразу прекратился.', icon: 'checkCircle' },
];

function platformCard(platform, files) {
  const head = `<div class="card-head"><span class="os-icon">${icon(platform.icon)}</span><h3>${esc(platform.label)}</h3></div>`;
  const f = files[0];
  if (!f) {
    return `<article class="card">${head}<p class="meta">Сборка ещё не готова</p><span class="soon">Скоро будет</span></article>`;
  }
  return `<article class="card active">${head}` +
    `<p class="file">${esc(f.name)}</p>` +
    `<p class="meta">${esc(formatSize(f.size))} · ${esc(f.arch)}</p>` +
    `<a class="btn" href="${esc(f.url)}">${icon('download')}<span>Скачать</span></a></article>`;
}

function downloadsHtml(items, version) {
  const byPlatform = new Map();
  for (const f of items) {
    if (!byPlatform.has(f.platform)) byPlatform.set(f.platform, []);
    byPlatform.get(f.platform).push(f);
  }
  const cards = PLATFORMS.map((p) => platformCard(p, byPlatform.get(p.key) || [])).join('');
  const steps = STEPS.map((s, i) =>
    `<li class="step"><div class="step-head"><span class="step-num">${i + 1}</span>${icon(s.icon)}</div>` +
    `<h3>${esc(s.title)}</h3><p>${esc(s.text)}</p></li>`).join('');
  return siteHeader() +
    `<main><section class="wrap hero"><div class="hero-copy">` +
    `<p class="eyebrow">Удалённая поддержка</p><h1>EnotDesk</h1>` +
    `<p class="lead">Быстрый и безопасный доступ к вашему устройству. Программа запускается без установки, а пароль действует только пока приложение открыто.</p>` +
    `<p class="cta"><a class="btn" href="#download">${icon('download')}<span>Скачать</span></a>` +
    `<a class="btn btn-ghost" href="#how">${icon('play')}<span>Как это работает</span></a></p>` +
    `<ul class="chips"><li>${icon('shield')}<span>Безопасное соединение</span></li>` +
    `<li>${icon('bolt')}<span>Быстрое подключение</span></li>` +
    `<li>${icon('lock')}<span>Без установки</span></li></ul>` +
    `</div><img class="mascot" src="/brand/mascot-site.png" alt="Енот EnotDesk в наушниках и очках за ноутбуком" width="736" height="372"></section>` +
    `<section id="download" class="wrap section"><h2>Скачать для вашей системы</h2><div class="cards">${cards}</div></section>` +
    `<section id="how" class="wrap section"><h2>Как это работает</h2><ol class="steps">${steps}</ol></section></main>` +
    siteFooter(version);
}

function inviteHtml(version) {
  return siteHeader() +
    `<main class="wrap invite-page"><section class="invite-card">` +
    `<p class="eyebrow">Приглашение</p>` +
    `<h1>Приглашение в команду EnotDesk</h1>` +
    `<p class="lead">Вас пригласили в команду поддержки. Откройте приложение EnotDesk и вставьте код приглашения из сообщения в форму принятия приглашения.</p>` +
    `<p class="cta"><a class="btn" href="/downloads">${icon('download')}<span>Открыть EnotDesk</span></a></p>` +
    `<p class="meta">Если приложение ещё не установлено, скачайте подходящую сборку на странице загрузки.</p>` +
    `</section></main>` + siteFooter(version);
}

function validSignalData(data) {
  if (!data || typeof data !== 'object') return false;
  const keys = Object.keys(data);
  if (data.description) {
    const d = data.description;
    if (typeof d !== 'object' || d === null) return false;
    if (!['offer', 'answer'].includes(d.type) || typeof d.sdp !== 'string') return false;
    return keys.every((k) => k === 'description');
  }
  if ('candidate' in data) {
    const c = data.candidate;
    if (c === null) return true;
    if (typeof c !== 'object' || typeof c.candidate !== 'string') return false;
    return keys.every((k) => k === 'candidate');
  }
  return false;
}

const CONTACT_LIMITS = { name: 120, notes: 2000, tags: 10, tag: 30 };

function validateContactInput(body) {
  if (typeof body !== 'object' || body === null) return 'Некорректный запрос';
  if ('name' in body && (typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.length > CONTACT_LIMITS.name)) {
    return 'Имя контакта: от 1 до 120 символов';
  }
  if ('notes' in body && (typeof body.notes !== 'string' || body.notes.length > CONTACT_LIMITS.notes)) {
    return 'Заметки: до 2000 символов';
  }
  if ('tags' in body) {
    if (!Array.isArray(body.tags) || body.tags.length > CONTACT_LIMITS.tags ||
        body.tags.some((t) => typeof t !== 'string' || t.length < 1 || t.length > CONTACT_LIMITS.tag)) {
      return 'Метки: до 10 строк по 30 символов';
    }
  }
  return null;
}

function bearer(req) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  return scheme === 'Bearer' ? token || null : null;
}

export function createServer(opts = {}) {
  const cfg = {
    dbPath: opts.dbPath ?? ':memory:',
    host: opts.host ?? '127.0.0.1',
    port: opts.port ?? 0,
    version: opts.version ?? '0.0.0',
    distDir: opts.distDir || process.env.ENOT_DIST_DIR || path.join(process.cwd(), 'dist'),
    publicUrl: opts.publicUrl ?? '',
    turnUrls: opts.turnUrls ?? '',
    turnUsername: opts.turnUsername ?? '',
    turnPassword: opts.turnPassword ?? '',
    leaseMs: opts.leaseMs ?? 20000,
    heartbeatMs: opts.heartbeatMs ?? 5000,
    authTimeoutMs: opts.authTimeoutMs ?? 5000,
    bodyLimit: opts.bodyLimit ?? 64 * 1024,
    limits: {
      login: opts.limits?.login ?? new RateLimiter(10, 60_000),
      sessions: opts.limits?.sessions ?? new RateLimiter(10, 60_000),
      claim: opts.limits?.claim ?? new RateLimiter(10, 60_000),
      claimId: opts.limits?.claimId ?? new RateLimiter(20, 60_000),
      accept: opts.limits?.accept ?? new RateLimiter(10, 60_000),
    },
  };
  const db = openDb(cfg.dbPath);
  endLiveSessions(db, 'server-restart'); // рестарт инвалидирует живые регистрации

  const live = new Map(); // sessionId -> {hostWs, opWs, sigCount, sigReset}
  let closed = false;

  function send(ws, obj) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  function endSession(sessionId, reason) {
    const now = new Date().toISOString();
    const r = db.prepare(
      "UPDATE sessions SET state='ended', ended_at=?, end_reason=? WHERE id=? AND state!='ended'"
    ).run(now, reason, sessionId);
    if (r.changes === 0) return false;
    const rt = live.get(sessionId);
    if (rt) {
      send(rt.hostWs, { type: 'ended', reason });
      send(rt.opWs, { type: 'ended', reason });
      for (const ws of [rt.hostWs, rt.opWs]) if (ws) ws.close(1000, 'ended');
      live.delete(sessionId);
    }
    return true;
  }

  const sweeper = setInterval(() => {
    const cutoff = new Date(Date.now() - cfg.heartbeatMs).toISOString();
    const rows = db.prepare(
      "SELECT id FROM sessions WHERE state!='ended' AND lease_expires_at < ?"
    ).all(cutoff);
    for (const row of rows) endSession(row.id, 'lease-expired');
  }, 1000);
  sweeper.unref();

  function authUser(req) {
    const token = bearer(req);
    if (!token) return null;
    const now = new Date().toISOString();
    const row = db.prepare(`
      SELECT u.id, u.login, u.name, u.role, u.active
      FROM auth_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.expires_at > ? AND u.active = 1
    `).get(sha256(token), now);
    return row || null;
  }

  function hostTokenSession(req) {
    const token = bearer(req);
    if (!token) return null;
    return db.prepare(
      "SELECT * FROM sessions WHERE host_token_hash = ? AND state != 'ended'"
    ).get(sha256(token)) || null;
  }

  function ip(req) {
    return req.socket.remoteAddress || 'unknown';
  }

  function listParams(url) {
    const q = url.searchParams;
    let limit = parseInt(q.get('limit') ?? '50', 10);
    let offset = parseInt(q.get('offset') ?? '0', 10);
    if (!Number.isInteger(limit) || limit < 1) limit = 50;
    if (limit > 100) limit = 100;
    if (!Number.isInteger(offset) || offset < 0) offset = 0;
    return { limit, offset };
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) err(res, 500, 'internal', 'Внутренняя ошибка сервера');
      else res.end();
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname.replace(/^\/api\/v1/, '');
    // CORS deny unknown origins: заголовки не выставляются вообще
    const origin = req.headers.origin;
    if (origin) {
      try {
        const o = new URL(origin);
        if (o.host !== req.headers.host) return err(res, 403, 'forbidden', 'Недопустимый источник запроса');
      } catch { return err(res, 403, 'forbidden', 'Недопустимый источник запроса'); }
    }
    if (req.method !== 'GET') {
      var body = await readJson(req, cfg.bodyLimit);
      if (body === null) return err(res, 413, 'too_large', 'Слишком большой запрос');
    }

    // ---- health ----
    if (p === '/health' && req.method === 'GET') return ok(res, 200, { ok: true, version: cfg.version });

    // ---- auth ----
    if (p === '/auth/login' && req.method === 'POST') {
      if (!cfg.limits.login.take(ip(req))) return err(res, 429, 'rate_limited', 'Слишком много попыток входа');
      const { login, password } = body || {};
      if (typeof login !== 'string' || typeof password !== 'string') {
        return err(res, 400, 'bad_request', 'Некорректный запрос');
      }
      const user = db.prepare('SELECT * FROM users WHERE login = ?').get(login.trim().toLowerCase());
      if (!user || !user.active || !verifyPassword(password, user.password)) {
        auditLog(db, null, 'login.failure', null, { login: String(login).slice(0, 120) });
        return err(res, 401, 'invalid_credentials', 'Неверный логин или пароль');
      }
      const token = newToken();
      const expiresAt = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
      db.prepare('INSERT INTO auth_tokens (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)')
        .run(sha256(token), user.id, expiresAt, new Date().toISOString());
      auditLog(db, user.id, 'login.success', user.id, {});
      return ok(res, 200, {
        token,
        user: { id: user.id, login: user.login, name: user.name, role: user.role, active: !!user.active },
        expiresAt,
      });
    }

    const user = authUser(req);

    if (p === '/auth/me' && req.method === 'GET') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      return ok(res, 200, { user });
    }
    if (p === '/auth/logout' && req.method === 'POST') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      const token = bearer(req);
      if (token) db.prepare('DELETE FROM auth_tokens WHERE token_hash = ?').run(sha256(token));
      auditLog(db, user.id, 'logout', user.id, {});
      return ok(res, 200, { ok: true });
    }

    // ---- members ----
    if (p === '/members' && req.method === 'GET') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (user.role !== 'admin') return err(res, 403, 'forbidden', 'Недостаточно прав');
      const { limit, offset } = listParams(url);
      const items = db.prepare(
        'SELECT id, login, name, role, active, created_at AS createdAt FROM users ORDER BY created_at LIMIT ? OFFSET ?'
      ).all(limit, offset).map((u) => ({ ...u, active: !!u.active }));
      const total = db.prepare('SELECT count(*) c FROM users').get().c;
      return ok(res, 200, { items, total });
    }
    let m = p.match(/^\/members\/([^/]+)$/);
    if (m && req.method === 'PATCH') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (user.role !== 'admin') return err(res, 403, 'forbidden', 'Недостаточно прав');
      const target = db.prepare('SELECT * FROM users WHERE id = ?').get(m[1]);
      if (!target) return err(res, 404, 'not_found', 'Участник не найден');
      const { role, active } = body || {};
      if (role !== undefined && !ROLES.includes(role)) return err(res, 400, 'bad_request', 'Некорректная роль');
      if (active !== undefined && typeof active !== 'boolean') return err(res, 400, 'bad_request', 'Некорректный признак активности');
      const losesAdmin = (role !== undefined && role !== 'admin' && target.role === 'admin') ||
                         (active === false && !!target.active && target.role === 'admin');
      if (losesAdmin) {
        const admins = db.prepare(
          "SELECT count(*) c FROM users WHERE role='admin' AND active=1 AND id != ?"
        ).get(target.id).c;
        if (admins === 0) return err(res, 409, 'last_admin', 'Нельзя отключить или понизить последнего активного администратора');
      }
      const now = new Date().toISOString();
      if (role !== undefined && role !== target.role) {
        db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, target.id);
        auditLog(db, user.id, 'member.role', target.id, { role });
      }
      if (active !== undefined && !!active !== !!target.active) {
        db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, target.id);
        auditLog(db, user.id, active ? 'member.enable' : 'member.disable', target.id, {});
        if (!active) {
          db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(target.id);
          for (const [sid, rt] of live) {
            if (rt.operatorUserId === target.id) endSession(sid, 'operator-revoked');
          }
        }
      }
      const u = db.prepare('SELECT id, login, name, role, active FROM users WHERE id = ?').get(target.id);
      return ok(res, 200, { user: { ...u, active: !!u.active } });
    }
    if (m && req.method === 'DELETE') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (user.role !== 'admin') return err(res, 403, 'forbidden', 'Недостаточно прав');
      const target = db.prepare('SELECT * FROM users WHERE id = ?').get(m[1]);
      if (!target) return err(res, 404, 'not_found', 'Участник не найден');
      if (target.id === user.id) return err(res, 409, 'self_delete', 'Нельзя удалить собственную учётную запись');
      if (target.role === 'admin' && !!target.active) {
        const admins = db.prepare(
          "SELECT count(*) c FROM users WHERE role='admin' AND active=1 AND id != ?"
        ).get(target.id).c;
        if (admins === 0) return err(res, 409, 'last_admin', 'Нельзя удалить последнего активного администратора');
      }
      for (const [sid, rt] of live) {
        if (rt.operatorUserId === target.id) endSession(sid, 'operator-revoked');
      }
      db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(target.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
      auditLog(db, user.id, 'member.delete', target.id, { login: target.login, role: target.role });
      return ok(res, 200, { ok: true });
    }

    // ---- invites ----
    if (p === '/invites' && req.method === 'GET') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (user.role !== 'admin') return err(res, 403, 'forbidden', 'Недостаточно прав');
      const { limit, offset } = listParams(url);
      const items = db.prepare(`
        SELECT id, role, expires_at AS expiresAt, used_at AS usedAt, revoked_at AS revokedAt, created_at AS createdAt
        FROM invites ORDER BY created_at LIMIT ? OFFSET ?`).all(limit, offset);
      const total = db.prepare('SELECT count(*) c FROM invites').get().c;
      return ok(res, 200, { items, total });
    }
    if (p === '/invites' && req.method === 'POST') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (user.role !== 'admin') return err(res, 403, 'forbidden', 'Недостаточно прав');
      const role = body?.role;
      if (!ROLES.includes(role)) return err(res, 400, 'bad_request', 'Некорректная роль');
      const id = crypto.randomUUID();
      const token = newToken();
      const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      db.prepare(`INSERT INTO invites (id, role, token_hash, expires_at, created_by, created_at)
                  VALUES (?,?,?,?,?,?)`)
        .run(id, role, sha256(token), expiresAt, user.id, new Date().toISOString());
      auditLog(db, user.id, 'invite.create', id, { role });
      const base = cfg.publicUrl || `http://${req.headers.host}`;
      return ok(res, 201, {
        invite: { id, role, expiresAt },
        token,
        url: `${base}/invite#token=${token}`,
      });
    }
    m = p.match(/^\/invites\/([^/]+)$/);
    if (m && req.method === 'DELETE') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (user.role !== 'admin') return err(res, 403, 'forbidden', 'Недостаточно прав');
      const r = db.prepare(
        "UPDATE invites SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL"
      ).run(new Date().toISOString(), m[1]);
      if (r.changes === 0) return err(res, 404, 'not_found', 'Приглашение не найдено или уже использовано');
      auditLog(db, user.id, 'invite.revoke', m[1], {});
      return ok(res, 200, { ok: true });
    }
    if (p === '/invites/accept' && req.method === 'POST') {
      if (!cfg.limits.accept.take(ip(req))) return err(res, 429, 'rate_limited', 'Слишком много попыток');
      const { token, login, name, password } = body || {};
      if (typeof token !== 'string' || typeof login !== 'string' || typeof name !== 'string' || typeof password !== 'string' ||
          login.trim().length < 3 || name.trim().length < 1 || password.length < 8) {
        return err(res, 400, 'bad_request', 'Проверьте данные: логин от 3 символов, пароль от 8 символов');
      }
      const inv = db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(sha256(token));
      if (!inv || inv.used_at || inv.revoked_at || inv.expires_at <= new Date().toISOString()) {
        return err(res, 400, 'bad_invite', 'Приглашение недействительно');
      }
      const normLogin = login.trim().toLowerCase();
      const now = new Date().toISOString();
      // атомарный приём: одно использование приглашения + уникальный логин
      const used = db.prepare(
        'UPDATE invites SET used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL'
      ).run(now, inv.id);
      if (used.changes !== 1) return err(res, 400, 'bad_invite', 'Приглашение недействительно');
      try {
        db.prepare(`INSERT INTO users (id, login, name, role, active, password, created_at)
                    VALUES (?,?,?,?,1,?,?)`)
          .run(crypto.randomUUID(), normLogin, name.trim(), inv.role, hashPassword(password), now);
      } catch {
        db.prepare('UPDATE invites SET used_at = NULL WHERE id = ?').run(inv.id); // откат приёма
        return err(res, 409, 'login_taken', 'Такой логин уже занят');
      }
      auditLog(db, null, 'invite.accept', inv.id, { role: inv.role });
      return ok(res, 200, { ok: true });
    }

    // ---- contacts ----
    function contactOut(row) {
      return { id: row.id, name: row.name, notes: row.notes, tags: JSON.parse(row.tags),
               revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at };
    }
    if (p === '/contacts' && req.method === 'GET') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      const { limit, offset } = listParams(url);
      const q = (url.searchParams.get('q') || '').trim();
      const where = q ? "WHERE ulower(name) LIKE ? OR ulower(notes) LIKE ?" : '';
      const like = `%${q.toLowerCase()}%`;
      const items = db.prepare(
        `SELECT * FROM contacts ${where} ORDER BY name LIMIT ? OFFSET ?`).all(...(q ? [like, like] : []), limit, offset);
      const total = db.prepare(`SELECT count(*) c FROM contacts ${where}`).get(...(q ? [like, like] : [])).c;
      return ok(res, 200, { items: items.map(contactOut), total });
    }
    if (p === '/contacts' && req.method === 'POST') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (!['admin', 'operator'].includes(user.role)) return err(res, 403, 'forbidden', 'Недостаточно прав');
      if (typeof body?.name !== 'string') return err(res, 400, 'bad_request', 'Укажите имя контакта');
      const e = validateContactInput(body);
      if (e) return err(res, 400, 'bad_request', e);
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      db.prepare(`INSERT INTO contacts (id, name, notes, tags, revision, created_at, updated_at)
                  VALUES (?,?,?,?,1,?,?)`)
        .run(id, body.name.trim(), body.notes ?? '', JSON.stringify(body.tags ?? []), now, now);
      auditLog(db, user.id, 'contact.create', id, {});
      return ok(res, 201, { contact: contactOut(db.prepare('SELECT * FROM contacts WHERE id = ?').get(id)) });
    }
    m = p.match(/^\/contacts\/([^/]+)$/);
    if (m && req.method === 'PATCH') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (!['admin', 'operator'].includes(user.role)) return err(res, 403, 'forbidden', 'Недостаточно прав');
      const row = db.prepare('SELECT * FROM contacts WHERE id = ?').get(m[1]);
      if (!row) return err(res, 404, 'not_found', 'Контакт не найден');
      const e = validateContactInput(body);
      if (e) return err(res, 400, 'bad_request', e);
      if (!Number.isInteger(body?.revision) || body.revision !== row.revision) {
        return err(res, 409, 'revision_conflict', 'Контакт изменён другим участником, обновите данные');
      }
      const now = new Date().toISOString();
      db.prepare(`UPDATE contacts SET name=?, notes=?, tags=?, revision=revision+1, updated_at=? WHERE id=?`)
        .run(
          body.name !== undefined ? body.name.trim() : row.name,
          body.notes !== undefined ? body.notes : row.notes,
          body.tags !== undefined ? JSON.stringify(body.tags) : row.tags,
          now, row.id,
        );
      auditLog(db, user.id, 'contact.update', row.id, {});
      return ok(res, 200, { contact: contactOut(db.prepare('SELECT * FROM contacts WHERE id = ?').get(row.id)) });
    }
    if (m && req.method === 'DELETE') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (!['admin', 'operator'].includes(user.role)) return err(res, 403, 'forbidden', 'Недостаточно прав');
      const row = db.prepare('SELECT * FROM contacts WHERE id = ?').get(m[1]);
      if (!row) return err(res, 404, 'not_found', 'Контакт не найден');
      if (!Number.isInteger(body?.revision) || body.revision !== row.revision) {
        return err(res, 409, 'revision_conflict', 'Контакт изменён другим участником, обновите данные');
      }
      db.prepare('DELETE FROM contacts WHERE id = ?').run(row.id);
      auditLog(db, user.id, 'contact.delete', row.id, {});
      return ok(res, 200, { ok: true });
    }

    // ---- history / audit ----
    if (p === '/history' && req.method === 'GET') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      const { limit, offset } = listParams(url);
      const items = db.prepare(`
        SELECT s.id, s.contact_id AS contactId, s.operator_id AS operatorId,
               u.name AS operatorName, s.state, s.created_at AS createdAt,
               s.started_at AS startedAt, s.ended_at AS endedAt, s.end_reason AS endReason
        FROM sessions s LEFT JOIN users u ON u.id = s.operator_id
        ORDER BY s.created_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
      const total = db.prepare('SELECT count(*) c FROM sessions').get().c;
      return ok(res, 200, { items, total });
    }
    if (p === '/audit' && req.method === 'GET') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      const { limit, offset } = listParams(url);
      const items = db.prepare(`
        SELECT id, actor_id AS actorId, action, target_id AS targetId, detail, created_at AS createdAt
        FROM audit ORDER BY id DESC LIMIT ? OFFSET ?`).all(limit, offset)
        .map((a) => ({ ...a, detail: JSON.parse(a.detail) }));
      const total = db.prepare('SELECT count(*) c FROM audit').get().c;
      return ok(res, 200, { items, total });
    }

    // ---- sessions ----
    if (p === '/sessions' && req.method === 'POST') {
      if (!cfg.limits.sessions.take(ip(req))) return err(res, 429, 'rate_limited', 'Слишком много запросов, попробуйте позже');
      const id = newSessionId(db);
      const password = sessionPassword(8);
      const hostToken = newToken();
      const now = new Date().toISOString();
      const lease = new Date(Date.now() + cfg.leaseMs).toISOString();
      db.prepare(`INSERT INTO sessions (id, password_hash, host_token_hash, state, created_at, lease_expires_at)
                  VALUES (?,?,?,'waiting',?,?)`)
        .run(id, hashPassword(password), sha256(hostToken), now, lease);
      auditLog(db, null, 'session.create', id, {});
      return ok(res, 201, { sessionId: id, password, hostToken, expiresAt: lease });
    }
    m = p.match(/^\/sessions\/([^/]+)\/claim$/);
    if (m && req.method === 'POST') {
      if (!cfg.limits.claim.take(`ip:${ip(req)}`) || !cfg.limits.claimId.take(`id:${m[1]}`)) {
        return err(res, 429, 'rate_limited', 'Слишком много попыток подключения');
      }
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (!['admin', 'operator'].includes(user.role)) return err(res, 403, 'forbidden', 'Недостаточно прав');
      const generic = () => err(res, 400, 'bad_request', 'Не удалось подключиться: проверьте идентификатор и пароль');
      const s = db.prepare("SELECT * FROM sessions WHERE id = ?").get(m[1]);
      if (!s || s.state !== 'waiting' || !verifyPassword(String(body?.password ?? ''), s.password_hash)) return generic();
      const claimId = newClaimId();
      const now = new Date().toISOString();
      const lease = new Date(Date.now() + cfg.leaseMs).toISOString();
      const contactId = typeof body?.contactId === 'string' && body.contactId ? body.contactId : null;
      const r = db.prepare(`
        UPDATE sessions SET claim_id=?, operator_id=?, contact_id=?, state='pending-consent', started_at=?, lease_expires_at=?
        WHERE id=? AND state='waiting'`).run(claimId, user.id, contactId, now, lease, s.id);
      if (r.changes !== 1) return generic();
      auditLog(db, user.id, 'session.claim', s.id, {});
      const rt = live.get(s.id);
      if (rt?.hostWs) send(rt.hostWs, { type: 'claim', claimId, operator: { id: user.id, name: user.name } });
      return ok(res, 201, {
        sessionId: s.id, claimId,
        operator: { id: user.id, name: user.name },
        state: 'pending-consent',
      });
    }
    m = p.match(/^\/sessions\/([^/]+)\/decision$/);
    if (m && req.method === 'POST') {
      const s = hostTokenSession(req);
      if (!s || s.id !== m[1]) return err(res, 403, 'forbidden', 'Недостаточно прав для этого сеанса');
      const { claimId, allow } = body || {};
      if (claimId !== s.claim_id || typeof allow !== 'boolean') {
        return err(res, 400, 'bad_request', 'Некорректный запрос решения');
      }
      if (allow) {
        db.prepare("UPDATE sessions SET state='approved' WHERE id = ?").run(s.id);
        auditLog(db, 'host', 'session.approve', s.id, { claimId });
        const rt = live.get(s.id);
        send(rt?.hostWs, { type: 'approved', claimId });
        send(rt?.opWs, { type: 'approved', claimId });
        return ok(res, 200, { ok: true });
      }
      auditLog(db, 'host', 'session.reject', s.id, { claimId });
      endSession(s.id, 'denied');
      return ok(res, 200, { ok: true });
    }
    m = p.match(/^\/sessions\/([^/]+)\/end$/);
    if (m && req.method === 'POST') {
      const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(m[1]);
      if (!s) return err(res, 404, 'not_found', 'Сеанс не найден');
      const token = bearer(req);
      const isHost = token && s.host_token_hash === sha256(token);
      const operator = authUser(req);
      const isOperator = operator && s.operator_id === operator.id;
      if (!isHost && !isOperator) return err(res, 403, 'forbidden', 'Недостаточно прав для этого сеанса');
      const changed = endSession(s.id, 'ended');
      if (changed) auditLog(db, isHost ? 'host' : operator.id, 'session.end', s.id, {});
      return ok(res, 200, { ok: true });
    }
    if (p === '/rtc-config' && req.method === 'GET') {
      const s = hostTokenSession(req);
      const authorized = s || authUser(req);
      if (!authorized) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      const iceServers = [];
      if (cfg.turnUrls) {
        iceServers.push({
          urls: cfg.turnUrls.split(',').map((u) => u.trim()).filter(Boolean),
          username: cfg.turnUsername,
          credential: cfg.turnPassword,
        });
      }
      return ok(res, 200, { iceServers });
    }

    // ---- pages / brand / downloads ----
    if (p === '/' && req.method === 'GET' && !req.url.startsWith('/api')) {
      res.writeHead(302, { Location: '/downloads' });
      res.end();
      return;
    }
    if (p === '/downloads' && req.method === 'GET' && !req.url.startsWith('/api')) {
      return page(res, 'EnotDesk — загрузка', downloadsHtml(distFiles(), cfg.version));
    }
    if (p === '/downloads' && req.method === 'GET') {
      return ok(res, 200, { items: distFiles() });
    }
    m = p.match(/^\/brand\/([^/]+)$/);
    if (m && req.method === 'GET') {
      let name;
      try { name = decodeURIComponent(m[1]); } catch { name = ''; }
      if (!Object.hasOwn(BRAND_FILES, name)) return err(res, 404, 'not_found', 'Файл не найден');
      let data;
      try { data = fs.readFileSync(new URL(`../assets/${name}`, import.meta.url)); }
      catch { return err(res, 404, 'not_found', 'Файл не найден'); }
      res.writeHead(200, { 'Content-Type': BRAND_FILES[name], 'Cache-Control': 'public, max-age=3600' });
      res.end(data);
      return;
    }
    m = p.match(/^\/downloads-files\/([^/]+)$/);
    if (m && req.method === 'GET') {
      let name;
      try { name = decodeURIComponent(m[1]); } catch { name = ''; }
      if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
        return err(res, 400, 'bad_request', 'Некорректное имя файла');
      }
      const file = distFiles().find((f) => f.name === name);
      if (!file) return err(res, 404, 'not_found', 'Файл недоступен');
      const fullPath = path.join(cfg.distDir, name);
      const range = parseRange(req.headers.range, file.size);
      const base = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes' };
      if (range?.unsatisfiable) {
        res.writeHead(416, { ...base, 'Content-Range': `bytes */${file.size}` });
        return res.end();
      }
      if (range) {
        res.writeHead(206, {
          ...base,
          'Content-Length': range.end - range.start + 1,
          'Content-Range': `bytes ${range.start}-${range.end}/${file.size}`,
        });
        return streamOut(fs.createReadStream(fullPath, { start: range.start, end: range.end }), res);
      }
      res.writeHead(200, { ...base, 'Content-Length': file.size });
      return streamOut(fs.createReadStream(fullPath), res);
    }
    if (p === '/invite' && req.method === 'GET' && !req.url.startsWith('/api')) {
      return page(res, 'EnotDesk — приглашение', inviteHtml(cfg.version));
    }

    return err(res, 404, 'not_found', 'Маршрут не найден');
  }

  function distFiles() {
    // Только разрешённые имена файлов из каталога сборок — никакие другие файлы проекта не отдаются
    const allow = [/^EnotDesk.*\.exe$/, /^EnotDesk.*\.zip$/, /^EnotDesk.*\.AppImage$/];
    const dir = cfg.distDir;
    let names = [];
    try { names = fs.readdirSync(dir); } catch { names = []; }
    return names
      .filter((n) => allow.some((re) => re.test(n)))
      .map((n) => {
        const platform = n.endsWith('.exe') ? 'win32' : n.endsWith('.AppImage') ? 'linux' : 'darwin';
        const arch = /arm64/i.test(n) ? 'arm64' : 'x64';
        let size = 0;
        try { size = fs.statSync(path.join(dir, n)).size; } catch { /* исчез файл между readdir и stat */ }
        return { platform, arch, name: n, url: `/api/v1/downloads-files/${encodeURIComponent(n)}`, size };
      });
  }

  // ---- WS /signal ----
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/signal') { socket.destroy(); return; }
    const origin = req.headers.origin;
    if (origin) {
      let same = false;
      try { same = new URL(origin).host === req.headers.host; } catch { same = false; }
      if (!same) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws));
  });

  function onSocket(ws) {
    let session = null;
    let role = null;
    let authed = false;
    // превышение maxPayload и сетевые сбои приходят ошибкой; ws сам закрывает 1009
    ws.on('error', () => {});
    const authTimer = setTimeout(() => { if (!authed) ws.close(4001, 'auth-timeout'); }, cfg.authTimeoutMs);

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (!authed || !session) return;
      const rt = live.get(session.id);
      if (!rt) return;
      if (role === 'host' && rt.hostWs === ws) {
        rt.hostWs = null;
        endSession(session.id, 'host-lost');
      } else if (role === 'operator' && rt.opWs === ws) {
        rt.opWs = null;
        endSession(session.id, 'operator-lost');
      }
    });

    ws.on('message', (raw) => {
      if (authed) return handleMessage(ws, raw);
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return ws.close(4002, 'bad-message'); }
      if (!msg || msg.type !== 'auth') return ws.close(4002, 'auth-first');
      const now = new Date().toISOString();
      const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(String(msg.sessionId ?? ''));
      if (!s || s.state === 'ended') return ws.close(4003, 'invalid-session');
      if (msg.role === 'host') {
        if (typeof msg.token !== 'string' || sha256(msg.token) !== s.host_token_hash) return ws.close(4003, 'invalid-session');
        if (s.lease_expires_at <= now) return ws.close(4003, 'invalid-session');
        role = 'host';
      } else if (msg.role === 'operator') {
        const u = authUser({ headers: { authorization: `Bearer ${msg.token}` }, socket: { remoteAddress: '' } });
        if (!u || !['admin', 'operator'].includes(u.role)) return ws.close(4003, 'invalid-session');
        if (msg.claimId !== s.claim_id || s.operator_id !== u.id) return ws.close(4003, 'invalid-session');
        if (!['pending-consent', 'approved'].includes(s.state)) return ws.close(4003, 'invalid-session');
        role = 'operator';
        ws._userId = u.id;
      } else {
        return ws.close(4002, 'auth-first');
      }
      // один сокет на участника
      let rt = live.get(s.id);
      if (rt && (msg.role === 'host' ? rt.hostWs : rt.opWs)) {
        return ws.close(4004, 'duplicate-socket');
      }
      if (!rt) { rt = { hostWs: null, opWs: null, operatorUserId: null, sigCount: 0, sigReset: 0 }; live.set(s.id, rt); }
      if (msg.role === 'host') {
        rt.hostWs = ws;
        db.prepare('UPDATE sessions SET lease_expires_at = ? WHERE id = ?')
          .run(new Date(Date.now() + cfg.leaseMs).toISOString(), s.id);
      } else {
        rt.opWs = ws;
        rt.operatorUserId = ws._userId;
      }
      session = s;
      authed = true;
      clearTimeout(authTimer);
      const fresh = db.prepare('SELECT state FROM sessions WHERE id = ?').get(s.id);
      send(ws, { type: 'ready', sessionId: s.id, role, state: fresh.state });
      if (role === 'host' && fresh.state === 'pending-consent' && s.claim_id) {
        const op = db.prepare('SELECT id, name FROM users WHERE id = ?').get(s.operator_id);
        send(ws, { type: 'claim', claimId: s.claim_id, operator: op });
      }
      if (role === 'operator' && fresh.state === 'approved') {
        send(ws, { type: 'approved', claimId: s.claim_id });
      }
    });

    function handleMessage(ws, raw) {
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return send(ws, { type: 'error', code: 'bad_message', message: 'Некорректное сообщение' }); }
      const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id);
      if (!s || s.state === 'ended') return;
      if (msg.type === 'heartbeat') {
        if (role !== 'host') return send(ws, { type: 'error', code: 'forbidden', message: 'Недопустимое сообщение' });
        db.prepare('UPDATE sessions SET lease_expires_at = ? WHERE id = ?')
          .run(new Date(Date.now() + cfg.leaseMs).toISOString(), s.id);
        return send(ws, { type: 'heartbeat' });
      }
      if (msg.type === 'signal') {
        if (role !== 'host' && role !== 'operator') return send(ws, { type: 'error', code: 'forbidden', message: 'Недопустимое сообщение' });
        const rt = live.get(s.id);
        const isHost = role === 'host' && rt?.hostWs === ws;
        const isOp = role === 'operator' && rt?.opWs === ws;
        if (!isHost && !isOp) return send(ws, { type: 'error', code: 'forbidden', message: 'Недопустимое сообщение' });
        if (s.state !== 'approved') {
          return send(ws, { type: 'error', code: 'not_approved', message: 'Сигналы доступны только после подтверждения' });
        }
        const now = Date.now();
        if (now > rt.sigReset) { rt.sigReset = now + SIGNAL_WINDOW_MS; rt.sigCount = 0; }
        rt.sigCount += 1;
        if (rt.sigCount > SIGNAL_MAX) {
          return send(ws, { type: 'error', code: 'rate_limited', message: 'Слишком частая передача сигналов' });
        }
        if (!validSignalData(msg.data)) {
          return send(ws, { type: 'error', code: 'bad_signal', message: 'Некорректный сигнал' });
        }
        const target = isHost ? rt.opWs : rt.hostWs;
        const clean = msg.data.description
          ? { type: 'signal', data: { description: { type: msg.data.description.type, sdp: msg.data.description.sdp } } }
          : { type: 'signal', data: { candidate: msg.data.candidate } };
        return send(target, clean);
      }
      return send(ws, { type: 'error', code: 'bad_message', message: 'Некорректное сообщение' });
    }
  }

  return {
    server,
    db,
    start: () => new Promise((resolve) => {
      server.listen(cfg.port, cfg.host, () => resolve(server.address().port));
    }),
    close: () => new Promise((resolve) => {
      if (closed) return resolve();
      closed = true;
      clearInterval(sweeper);
      for (const [id, rt] of live) {
        for (const ws of [rt.hostWs, rt.opWs]) if (ws) ws.terminate();
      }
      live.clear();
      for (const client of wss.clients) client.terminate();
      server.close(() => { db.close(); resolve(); });
    }),
  };
}
