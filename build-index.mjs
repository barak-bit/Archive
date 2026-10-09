// Builds the public publication pages from the blockchain itself.
// Reads every confirmed registration sent to the archive address, keeps only official ones
// (made through ארכיב, intact, not hidden), and writes static pages that search engines can index:
//   dist/p/<txid>.html   one permanent page per publication
//   dist/p/<txid>.pdf|.txt|...  the document itself (only types that cannot run code)
//   dist/p/index.html    list of all publications, newest first
//   dist/p/index.json    the same list as data, for other services
//   dist/sitemap.xml, dist/robots.txt  (when SITE_URL or config.siteUrl is set)
// Nothing here is a source of truth: every page can be rebuilt from the chain at any time.
//
// Env: OUT_DIR (default dist), SITE_URL (absolute site URL, set by the GitHub workflow), ARCHIV_API (override API base, for tests)
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import * as E from './engine.js';

const root = new URL('.', import.meta.url);
const config = JSON.parse(readFileSync(process.env.CONFIG_PATH || new URL('config.json', root), 'utf8'));
const NET = E.NETWORKS[config.network];
if (!NET) throw new Error('unknown network in config.json: ' + config.network);
const API = (process.env.ARCHIV_API || NET.api).replace(/\/$/, '');
const OUT = new URL(process.env.OUT_DIR ? `${process.env.OUT_DIR.replace(/\/$/, '')}/` : 'dist/', root);
const RAW_SITE = process.env.SITE_URL || config.siteUrl || '';
const SITE = RAW_SITE ? RAW_SITE.replace(/\/?$/, '/') : '';
const SITE_NAME = config.siteName || 'ארכיב';
const ARCHIVE = E.archiveAddress(NET.btc);
const HIDDEN = new Set(config.hiddenTxids || []);
const MAX_DECOMPRESSED = 64 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(API + path, { headers: { accept: 'application/json' } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${path}`);
      return await r.json();
    } catch (e) {
      if (attempt >= 4) throw e;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

// ---------- read the archive ----------
async function listConfirmed() {
  const all = []; let last = null;
  for (;;) {
    const page = await get(`/address/${ARCHIVE}/txs/chain${last ? '/' + last : ''}`);
    if (!page || !page.length) break;
    all.push(...page);
    last = page[page.length - 1].txid;
    if (page.length < 25) break;
    await sleep(150);
  }
  return all.filter((t) => t.status && t.status.confirmed);
}
function parseTx(tx) {
  const w = tx.vin && tx.vin[0] && tx.vin[0].witness;
  if (!w) return null;
  try { return E.parseWitnessHex(w); } catch { return null; }
}
const decode = (body, enc) => enc === 'gzip' ? new Uint8Array(gunzipSync(body, { maxOutputLength: MAX_DECOMPRESSED })) : body;

async function collect() {
  const txs = await listConfirmed();
  const byTxid = new Map(txs.map((t) => [t.txid, t]));
  const items = [], skipped = [];
  for (const tx of txs) {
    const p = parseTx(tx); if (!p) continue;
    const m = p.metadata || {};
    if (m.app !== E.ARCHIVE_TAG || m.kind === 'part') continue;
    if (HIDDEN.has(tx.txid)) { skipped.push([tx.txid, 'hidden']); continue; }
    try {
      let content, type = p.contentType;
      if (m.kind === 'multipart') {
        type = m.contentType || 'application/octet-stream';
        const chunks = [];
        for (const [i, id] of (m.parts || []).entries()) {
          const ptxid = String(id).replace(/i\d+$/, '');
          const ptx = byTxid.get(ptxid) || await get('/tx/' + ptxid);
          const pp = ptx && parseTx(ptx);
          if (!pp || pp.metadata.kind !== 'part' || pp.metadata.i !== i || pp.metadata.doc !== m.sha256) throw new Error(`part ${i + 1} missing or mismatched`);
          chunks.push(pp.body);
        }
        content = decode(new Uint8Array(Buffer.concat(chunks.map((c) => Buffer.from(c)))), m.contentEncoding);
      } else content = decode(p.body, p.contentEncoding);
      if (E.sha256Hex(content) !== m.sha256) throw new Error('fingerprint mismatch');
      items.push({ txid: tx.txid, time: tx.status.block_time, height: tx.status.block_height, type, content, meta: m, parts: m.kind === 'multipart' ? m.parts.length : 0 });
    } catch (e) { skipped.push([tx.txid, e.message]); }
  }
  items.sort((a, b) => b.time - a.time || (a.txid < b.txid ? -1 : 1));
  return { items, skipped, total: txs.length };
}

// ---------- pages ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const iso = (t) => new Date(t * 1000).toISOString();
const ymd = (t) => iso(t).slice(0, 10);
const heDate = (t) => new Date(t * 1000).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'long', timeStyle: 'short' });
const fmtBytes = (n) => '\u2066' + (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`) + '\u2069';
// Only formats that cannot execute code are published as files on this site.
function fileExt(type) {
  const t = String(type).split(';')[0].trim().toLowerCase();
  if (t === 'application/pdf') return 'pdf';
  if (/^text\/(plain|markdown|csv)$/.test(t) || t === 'application/json') return 'txt';
  return { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[t] || '';
}
const isText = (type) => fileExt(type) === 'txt';

const CSS = `:root{--paper:#f2f4f3;--sheet:#fbfcfb;--ink:#15212b;--muted:#5b6872;--rule:#d5dcdc;--accent:#23439e;--ok:#1d7a4f;--ok-soft:#e1f2e9}
@media (prefers-color-scheme:dark){:root{--paper:#10161b;--sheet:#172028;--ink:#e6ecef;--muted:#98a6b0;--rule:#2b3842;--accent:#8fa8ff;--ok:#6fd3a0;--ok-soft:#133426;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 "IBM Plex Sans Hebrew","Arial Hebrew","Segoe UI",Arial,sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:28px 16px 64px}a{color:var(--accent)}
header{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;border-bottom:2px solid var(--ink);padding-bottom:12px;margin-bottom:22px}
header .brand{font-family:"Frank Ruhl Libre","David",serif;font-weight:800;font-size:1.8rem;text-decoration:none;color:var(--ink)}
h1{font-family:"Frank Ruhl Libre","David",serif;font-size:1.9rem;line-height:1.2;margin:0 0 8px;text-wrap:balance}
.lead{color:var(--muted);margin:0 0 18px}.abstract{font-size:1.05rem;margin:0 0 18px;white-space:pre-wrap}
dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 16px;margin:0 0 18px;font-size:.93rem}dt{color:var(--muted)}dd{margin:0;min-width:0}
.mono{font-family:"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace;font-size:.84em;direction:ltr;unicode-bidi:isolate;word-break:break-all}
.seal{display:inline-block;background:var(--ok-soft);color:var(--ok);font-weight:600;font-size:.88rem;border-radius:999px;padding:3px 12px;margin-bottom:16px}
.links{display:flex;flex-wrap:wrap;gap:8px 18px;margin-bottom:22px}
pre{white-space:pre-wrap;word-break:break-word;background:var(--sheet);border:1px solid var(--rule);border-radius:6px;padding:14px;font:15px/1.6 inherit;font-family:inherit}
section{border-top:1px solid var(--rule);padding-top:14px;margin-top:22px}h2{font-size:1.1rem;margin:0 0 8px}
ol{padding-inline-start:20px;margin:0}li{margin-bottom:6px}
.list{list-style:none;padding:0;margin:0;border-top:1px solid var(--rule)}.list li{padding:12px 2px;border-bottom:1px solid var(--rule);margin:0}
.list a{font-weight:600;text-decoration:none}.list .meta{color:var(--muted);font-size:.85rem}.list p{margin:4px 0 0;font-size:.93rem}
footer{margin-top:36px;color:var(--muted);font-size:.85rem;border-top:1px solid var(--rule);padding-top:12px}`;
const FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Frank+Ruhl+Libre:wght@800&family=IBM+Plex+Sans+Hebrew:wght@400;600&family=IBM+Plex+Mono&display=swap">';
const shell = ({ title, head = '', body, depth = 1 }) => `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>${head}${FONTS}<style>${CSS}</style></head>
<body><div class="wrap"><header><a class="brand" href="${'../'.repeat(depth)}">${esc(SITE_NAME)}</a><a href="${depth ? './' : 'p/'}">כל הפרסומים</a></header>
${body}
<footer>הדפים באתר נבנים מחדש מהבלוקצ'יין של ביטקוין, ואפשר לשחזר אותם בכל רגע בלי האתר הזה. המפרסם אחראי לתוכן. דיווח על תוכן פוגעני: <span class="mono">${esc(config.reportEmail || '')}</span></footer>
</div></body></html>\n`;

function publicationPage(it) {
  const m = it.meta, ext = fileExt(it.type), id = it.txid + 'i0';
  const title = m.title || 'פרסום ללא כותרת';
  const desc = (m.abstract || (isText(it.type) ? new TextDecoder().decode(it.content.subarray(0, 2000)) : '')).replace(/\s+/g, ' ').trim().slice(0, 300);
  const url = SITE ? `${SITE}p/${it.txid}.html` : '';
  const fileUrl = ext ? (SITE ? `${SITE}p/${it.txid}.${ext}` : `${it.txid}.${ext}`) : '';
  const keywords = (m.keywords || '').split(/[,،]/).map((k) => k.trim()).filter(Boolean);
  const head = [
    `<meta name="description" content="${esc(desc)}">`,
    url && `<link rel="canonical" href="${esc(url)}">`,
    `<meta name="citation_title" content="${esc(title)}">`,
    `<meta name="citation_publication_date" content="${ymd(it.time).replace(/-/g, '/')}">`,
    `<meta name="citation_online_date" content="${ymd(it.time).replace(/-/g, '/')}">`,
    `<meta name="citation_publisher" content="${esc(SITE_NAME)}">`,
    ext === 'pdf' && `<meta name="citation_pdf_url" content="${esc(fileUrl)}">`,
    keywords.length && `<meta name="citation_keywords" content="${esc(keywords.join('; '))}">`,
    `<meta name="DC.date" content="${ymd(it.time)}"><meta name="DC.identifier" content="${esc(id)}">`,
    `<meta property="og:title" content="${esc(title)}"><meta property="og:type" content="article">`,
    `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'CreativeWork', name: title, abstract: m.abstract || undefined, keywords: keywords.length ? keywords.join(', ') : undefined, datePublished: iso(it.time), identifier: id, url: url || undefined, sha256: m.sha256, publisher: { '@type': 'Organization', name: SITE_NAME } }).replace(/</g, '\\u003c')}</script>`,
  ].filter(Boolean).join('\n');
  const ordLink = NET.ordinals ? `<a href="${NET.ordinals}/inscription/${id}" rel="noopener">ב-ordinals.com</a>` : '';
  let preview = '';
  if (isText(it.type)) {
    const text = new TextDecoder().decode(it.content);
    preview = `<section><h2>הטקסט המלא</h2><pre dir="auto">${esc(text.length > 300000 ? text.slice(0, 300000) + '\n…' : text)}</pre></section>`;
  } else if (/^image\//.test(it.type) && ext) preview = `<section><img src="${it.txid}.${ext}" alt="${esc(title)}" style="max-width:100%;border:1px solid var(--rule);border-radius:6px"></section>`;
  const body = `<article>
<h1 dir="auto">${esc(title)}</h1>
<p class="lead">פורסם ב-${esc(heDate(it.time))} (שעון ישראל) · בלוק ${it.height}</p>
${m.abstract ? `<p class="abstract" dir="auto">${esc(m.abstract)}</p>` : ''}
<div class="seal">✓ התוכן נקרא מהבלוקצ'יין ותואם לטביעת האצבע שנרשמה</div>
<dl>
<dt>מזהה הפרסום</dt><dd class="mono">${esc(id)}</dd>
<dt>תאריך פרסום (UTC)</dt><dd class="mono">${esc(iso(it.time))}</dd>
<dt>בלוק</dt><dd class="mono">${it.height}</dd>
<dt>טביעת אצבע (SHA-256)</dt><dd class="mono">${esc(m.sha256)}</dd>
<dt>קובץ</dt><dd>${m.file ? esc(m.file) + ' · ' : ''}<span class="mono">${esc(String(it.type).split(';')[0])}</span> · ${fmtBytes(it.content.length)}${it.parts ? ` · ${it.parts} חלקים` : ''}</dd>
${keywords.length ? `<dt>מילות מפתח</dt><dd>${esc(keywords.join(', '))}</dd>` : ''}
</dl>
<div class="links">
${ext ? `<a href="${it.txid}.${ext}">${ext === 'pdf' ? 'המסמך (PDF)' : 'הקובץ המקורי'}</a>` : '<span>הקובץ זמין בבלוקצ\'יין בלבד (סוג שלא מוצג באתר מטעמי אבטחה)</span>'}
<a href="${NET.explorer}/tx/${it.txid}" rel="noopener">העסקה ב-mempool.space</a>
${ordLink}
</div>
${preview}
<section><h2>איך לאמת את הפרסום בלי לסמוך על האתר הזה</h2><ol>
<li>פתחו את העסקה <span class="mono">${esc(it.txid)}</span> בכל explorer של ביטקוין ובדקו שהיא נכללה בבלוק ${it.height}, שזמנו ${esc(iso(it.time))}.</li>
<li>התוכן כתוב בנתוני העסקה עצמה${it.parts ? `, מפוצל ל-${it.parts} חלקים שרשומים בעסקאות נפרדות. רשימת החלקים לפי הסדר נמצאת ברישום האינדקס הזה` : ''}.</li>
<li>חשבו SHA-256 לקובץ שבידיכם. אם התוצאה היא <span class="mono">${esc(m.sha256)}</span>, הקובץ זהה בדיוק למה שפורסם.</li>
</ol></section>
</article>`;
  return shell({ title: `${title} · ${SITE_NAME}`, head, body });
}

function listPage(items) {
  const rows = items.map((it) => `<li><a href="${it.txid}.html" dir="auto">${esc(it.meta.title || 'פרסום ללא כותרת')}</a>
<div class="meta">${esc(heDate(it.time))} · בלוק ${it.height} · ${fmtBytes(it.content.length)}</div>${it.meta.abstract ? `<p dir="auto">${esc(it.meta.abstract.slice(0, 280))}${it.meta.abstract.length > 280 ? '…' : ''}</p>` : ''}</li>`).join('\n');
  const body = `<h1>כל הפרסומים</h1><p class="lead">${items.length} פרסומים, מהחדש לישן. עודכן ב-${esc(heDate(Date.now() / 1000))}.</p>
<ul class="list">${rows || '<li>עדיין אין פרסומים.</li>'}</ul>`;
  return shell({ title: `כל הפרסומים · ${SITE_NAME}`, head: `<meta name="description" content="רשימת כל הפרסומים בארכיון ${esc(SITE_NAME)}">${SITE ? `<link rel="canonical" href="${SITE}p/">` : ''}`, body });
}

// ---------- main ----------
const { items, skipped, total } = await collect();
const P = new URL('p/', OUT);
rmSync(P, { recursive: true, force: true });
mkdirSync(P, { recursive: true });
for (const it of items) {
  writeFileSync(new URL(`${it.txid}.html`, P), publicationPage(it));
  const ext = fileExt(it.type);
  if (ext) writeFileSync(new URL(`${it.txid}.${ext}`, P), it.content);
}
writeFileSync(new URL('index.html', P), listPage(items));
writeFileSync(new URL('index.json', P), JSON.stringify({
  archive: ARCHIVE, network: config.network, generated: new Date().toISOString(),
  publications: items.map((it) => ({ id: it.txid + 'i0', txid: it.txid, title: it.meta.title || '', abstract: it.meta.abstract || '', keywords: it.meta.keywords || '',
    published: iso(it.time), block: it.height, sha256: it.meta.sha256, size: it.content.length, contentType: it.type, parts: it.parts, page: `p/${it.txid}.html` })),
}, null, 1));
if (SITE) {
  const urls = [`${SITE}`, `${SITE}p/`, ...items.map((it) => `${SITE}p/${it.txid}.html`), ...items.filter((it) => fileExt(it.type) === 'pdf').map((it) => `${SITE}p/${it.txid}.pdf`)];
  writeFileSync(new URL('sitemap.xml', OUT), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${esc(u)}</loc></url>`).join('\n')}\n</urlset>\n`);
  writeFileSync(new URL('robots.txt', OUT), `User-agent: *\nAllow: /\nSitemap: ${SITE}sitemap.xml\n`);
}
console.log(`archive ${ARCHIVE}: ${total} confirmed transactions, ${items.length} publications${skipped.length ? `, ${skipped.length} skipped` : ''}`);
for (const [t, why] of skipped) console.log(`  skipped ${t}: ${why}`);
