// Презентация серверных страниц (/downloads, /invite, /operator): стили, иконки, разметка.
// Чистый модуль без сети — app.mjs только маршрутизирует. Тексты — из общего
// словаря i18n (spec §i18n), язык выбирает app.mjs по Accept-Language.

import { readFileSync } from 'node:fs';
import { t } from '../client/lib/i18n.mjs';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatSize(bytes, locale) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['server.units.b', 'server.units.kb', 'server.units.mb', 'server.units.gb'].map((k) => t(k, {}, locale));
  let n = bytes; let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

const BASE_STYLE = `
:root{color-scheme:dark;--bg:#070D17;--panel:#0F1A2C;--line:#1C2C44;--text:#EAF2FF;--muted:#8FA3BF;--accent:#35E0C4}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
.insecure-warn{display:flex;align-items:flex-start;gap:10px;background:#2A1F0E;border-bottom:1px solid #57431F;color:#F2D49B;padding:12px 24px;font-size:14.5px;line-height:1.5}
.insecure-warn svg{width:18px;height:18px;flex:none;margin-top:2px;color:#F2C063}
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

const ICONS = {
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
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

// R16i.2: честный режим без TLS. Схема — из ENOT_PUBLIC_URL, иначе из
// x-forwarded-proto (обратный прокси), иначе прямой http сокета. На loopback
// (127.0.0.1/localhost/::1) плашки нет: локальное использование безопасно.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isInsecurePage(req, publicUrl) {
  const hostname = String(req?.headers?.host ?? '').replace(/:\d+$/, '').toLowerCase();
  if (LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost')) return false;
  const url = String(publicUrl ?? '').trim().toLowerCase();
  if (url) return !url.startsWith('https');
  const proto = String(req?.headers?.['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
  return proto !== 'https';
}

function insecureBanner(locale) {
  return `<div class="insecure-warn" role="alert">${icon('alert')}<span>${esc(t('server.insecureBanner', {}, locale))}</span></div>`;
}

function page(res, title, bodyHtml, locale) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  res.end(`<!doctype html><html lang="${esc(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(title)}</title><link rel="icon" href="/brand/enot-icon.svg" type="image/svg+xml">` +
    `<style>${BASE_STYLE}</style></head><body>${bodyHtml}</body></html>`);
}

function siteHeader(locale) {
  return `<header class="site-head"><div class="wrap head-inner">` +
    `<a class="brand" href="/downloads"><img src="/brand/enot-icon.svg" alt="" width="40" height="40">` +
    `<span class="brand-name">EnotDesk</span><span class="brand-sep" aria-hidden="true"></span>` +
    `<span class="brand-sub">${esc(t('app.subtitle', {}, locale))}</span></a>` +
    `<nav class="head-nav" aria-label="${esc(t('server.nav.ariaMain', {}, locale))}">` +
    `<a class="nav-btn" href="/downloads#download" aria-label="${esc(t('server.nav.ariaHelp', {}, locale))}">${icon('help')}<span>${esc(t('server.nav.help', {}, locale))}</span></a>` +
    `<a class="nav-btn" href="/invite" aria-label="${esc(t('server.nav.ariaOperator', {}, locale))}">${icon('chat')}<span>${esc(t('server.nav.operator', {}, locale))}</span></a>` +
    `</nav></div></header>`;
}

function siteFooter(version, locale) {
  return `<footer class="site-foot"><div class="wrap foot-inner">` +
    `<p>EnotDesk <span class="foot-ver">v${esc(version)}</span></p>` +
    `<p class="foot-love">${icon('heart')}<span>${esc(t('app.care', {}, locale))}</span></p>` +
    `</div></footer>`;
}

function steps(locale) {
  return [1, 2, 3, 4].map((n) => ({
    title: t(`server.step${n}.title`, {}, locale),
    text: t(`server.step${n}.text`, {}, locale),
    icon: ['link', 'playCircle', 'idCard', 'checkCircle'][n - 1],
  }));
}

function platformCard(platform, files, locale) {
  const head = `<div class="card-head"><span class="os-icon">${icon(platform.icon)}</span><h3>${esc(platform.label)}</h3></div>`;
  const f = files[0];
  if (!f) {
    return `<article class="card">${head}<p class="meta">${esc(t('server.notReady', {}, locale))}</p><span class="soon">${esc(t('server.soon', {}, locale))}</span></article>`;
  }
  return `<article class="card active">${head}` +
    `<p class="file">${esc(f.name)}</p>` +
    `<p class="meta">${esc(formatSize(f.size, locale))} · ${esc(f.arch)}</p>` +
    `<a class="btn" href="${esc(f.url)}">${icon('download')}<span>${esc(t('server.download', {}, locale))}</span></a></article>`;
}

function downloadsHtml(items, version, locale, insecure = false) {
  const byPlatform = new Map();
  for (const f of items) {
    if (!byPlatform.has(f.platform)) byPlatform.set(f.platform, []);
    byPlatform.get(f.platform).push(f);
  }
  const cards = PLATFORMS.map((p) => platformCard(p, byPlatform.get(p.key) || [], locale)).join('');
  const stepItems = steps(locale).map((s, i) =>
    `<li class="step"><div class="step-head"><span class="step-num">${i + 1}</span>${icon(s.icon)}</div>` +
    `<h3>${esc(s.title)}</h3><p>${esc(s.text)}</p></li>`).join('');
  return (insecure ? insecureBanner(locale) : '') + siteHeader(locale) +
    `<main><section class="wrap hero"><div class="hero-copy">` +
    `<p class="eyebrow">${esc(t('app.subtitle', {}, locale))}</p><h1>EnotDesk</h1>` +
    `<p class="lead">${esc(t('server.hero.lead', {}, locale))}</p>` +
    `<p class="cta"><a class="btn" href="#download">${icon('download')}<span>${esc(t('server.download', {}, locale))}</span></a>` +
    `<a class="btn btn-ghost" href="#how">${icon('play')}<span>${esc(t('server.how', {}, locale))}</span></a></p>` +
    `<ul class="chips"><li>${icon('shield')}<span>${esc(t('server.chip.secure', {}, locale))}</span></li>` +
    `<li>${icon('bolt')}<span>${esc(t('server.chip.fast', {}, locale))}</span></li>` +
    `<li>${icon('lock')}<span>${esc(t('server.chip.noInstall', {}, locale))}</span></li></ul>` +
    `</div><img class="mascot" src="/brand/mascot-site.png" alt="${esc(t('server.mascotAlt', {}, locale))}" width="736" height="372"></section>` +
    `<section id="download" class="wrap section"><h2>${esc(t('server.downloadFor', {}, locale))}</h2><div class="cards">${cards}</div></section>` +
    `<section id="how" class="wrap section"><h2>${esc(t('server.how', {}, locale))}</h2><ol class="steps">${stepItems}</ol></section></main>` +
    siteFooter(version, locale);
}

function inviteHtml(version, locale, insecure = false) {
  return (insecure ? insecureBanner(locale) : '') + siteHeader(locale) +
    `<main class="wrap invite-page"><section class="invite-card">` +
    `<p class="eyebrow">${esc(t('server.invite.eyebrow', {}, locale))}</p>` +
    `<h1>${esc(t('server.invite.title', {}, locale))}</h1>` +
    `<p class="lead">${esc(t('server.invite.lead', {}, locale))}</p>` +
    `<p class="cta"><a class="btn" href="/downloads">${icon('download')}<span>${esc(t('server.invite.open', {}, locale))}</span></a></p>` +
    `<p class="meta">${esc(t('server.invite.note', {}, locale))}</p>` +
    `</section></main>` + siteFooter(version, locale);
}

// Браузерный оператор: разметка живёт в web/operator.html (её проверяет контракт-тест),
// сервер подставляет только язык, заголовок и версию. JS-модули страницы отдаются
// статикой app.mjs (/web, /client/lib, /client/renderer, /client/locales — allowlist).
let operatorHtmlCache = null;

function operatorHtml(title, locale, version) {
  if (!operatorHtmlCache) {
    operatorHtmlCache = readFileSync(new URL('../web/operator.html', import.meta.url), 'utf8');
  }
  return operatorHtmlCache
    .replace('__TITLE__', esc(title))
    .replace('__VERSION__', esc(version))
    .replace('__LOCALE__', esc(locale));
}

// CSP повторяет desktop (никакого inline-кода), но странице нужны свои ES-модули,
// same-origin fetch/WS и blob: для сохранения принятых файлов.
function operatorPage(res, status, locale, title, version) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; media-src blob:",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
  });
  res.end(operatorHtml(title, locale, version));
}

export { esc, page, downloadsHtml, inviteHtml, operatorPage };
