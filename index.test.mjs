// Runs build-index.mjs against the fake API and checks the generated public pages.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildChain, serve } from './mock-chain.mjs';

const chain = buildChain();
const server = await serve(chain);
const out = mkdtempSync(join(tmpdir(), 'archiv-index-'));
const cfgPath = join(out, 'config.json');
const cfg = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
writeFileSync(cfgPath, JSON.stringify({ ...cfg, network: 'testnet4', hiddenTxids: [], hidden: [{ txid: chain.named.hidden, reason: 'צו שיפוטי לדוגמה', date: '2026-10-09' }] }));
try {
  const { stdout: log } = await promisify(execFile)('node', [new URL('./build-index.mjs', import.meta.url).pathname], {
    env: { ...process.env, ARCHIV_API: `http://127.0.0.1:${server.address().port}`, OUT_DIR: out, SITE_URL: 'https://example.github.io/archiv', CONFIG_PATH: cfgPath },
  });
  console.log(log.trim());
  const P = (f) => join(out, 'p', f);
  const json = JSON.parse(readFileSync(P('index.json'), 'utf8'));
  const ids = json.publications.map((p) => p.txid);
  // 22 fillers + text + gzip + multipart + html = 26; external, tampered, hidden and withdrawn are left out
  assert.equal(json.publications.length, 26, 'publication count');
  for (const k of ['text', 'gzip', 'multipart', 'html']) assert.ok(ids.includes(chain.named[k]), k + ' listed');
  for (const k of ['external', 'hidden', 'tampered', 'withdrawnKey', 'withdrawnWallet', 'withdrawnMulti', 'wdKey', 'wdWallet']) assert.ok(!ids.includes(chain.named[k]), k + ' excluded');
  // removals: three by the publisher (key, wallet, wallet on a multipart document), one by the operator with its reason
  const rem = new Map(json.removed.map((r) => [r.txid, r]));
  assert.equal(json.removed.length, 4, 'removed count');
  assert.equal(rem.get(chain.named.withdrawnKey).by, 'publisher');
  assert.equal(rem.get(chain.named.withdrawnWallet).by, 'publisher');
  assert.equal(rem.get(chain.named.withdrawnMulti).by, 'publisher');
  assert.equal(rem.get(chain.named.wdKey) , undefined);
  assert.equal(rem.get(chain.named.hidden).by, 'operator');
  assert.equal(rem.get(chain.named.hidden).reason, 'צו שיפוטי לדוגמה');
  // forged requests change nothing: the solar-clamp text stays published
  assert.equal((log.match(/proof does not match the publisher/g) || []).length, 2, 'two forged requests rejected');
  // stub page keeps date and fingerprint, never the title or content
  const stub = readFileSync(P(chain.named.withdrawnKey + '.html'), 'utf8');
  assert.ok(stub.includes('הוסר מהתצוגה לבקשת המפרסם') && stub.includes('נחתמה במפתח הרישום') && !stub.includes('הועלה בטעות') && !stub.includes('uploaded by mistake'));
  assert.ok(readFileSync(P(chain.named.withdrawnWallet + '.html'), 'utf8').includes('נחתמה בארנק ששילם'));
  assert.ok(readFileSync(P(chain.named.hidden + '.html'), 'utf8').includes('הסיבה: צו שיפוטי לדוגמה'));
  assert.ok(!existsSync(P(chain.named.withdrawnKey + '.txt')), 'no content file for a removed document');
  const log2 = readFileSync(P('removed.html'), 'utf8');
  assert.equal((log2.match(/<li>/g) || []).length, 4);
  assert.match(log, /fingerprint mismatch/);
  // multipart PDF reassembled byte for byte, and published
  const pdf = readFileSync(P(chain.named.multipart + '.pdf'));
  assert.equal(createHash('sha256').update(pdf).digest('hex'), createHash('sha256').update(chain.pdf).digest('hex'));
  const mp = readFileSync(P(chain.named.multipart + '.html'), 'utf8');
  assert.match(mp, /citation_pdf_url" content="https:\/\/example\.github\.io\/archiv\/p\/[0-9a-f]{64}\.pdf"/);
  assert.match(mp, /3 חלקים/);
  // text page: full text, abstract, keywords, citation metadata, canonical url
  const tp = readFileSync(P(chain.named.text + '.html'), 'utf8');
  assert.ok(tp.includes('מסובבים את התפס עד הנקישה'));
  assert.ok(tp.includes('בלי ברגים ובלי כלים'));
  assert.ok(tp.includes('<meta name="citation_author" content="סולאר-טק בע&quot;מ">'));
  assert.ok(tp.includes('מאת <b dir="auto">סולאר-טק בע&quot;מ</b>'));
  assert.match(tp, /citation_publication_date" content="\d{4}\/\d{2}\/\d{2}"/);
  assert.match(tp, /<link rel="canonical" href="https:\/\/example\.github\.io\/archiv\/p\/[0-9a-f]{64}\.html">/);
  assert.equal(readFileSync(P(chain.named.text + '.txt'), 'utf8'), chain.textBody);
  // gzip text decompressed
  assert.ok(readFileSync(P(chain.named.gzip + '.txt'), 'utf8').startsWith('Claim: a method'));
  // HTML registration: page exists, but no HTML/script file is ever written to the site
  const hp = readFileSync(P(chain.named.html + '.html'), 'utf8');
  assert.ok(!hp.includes('<script>alert(1)</script>'));
  assert.ok(!readdirSync(join(out, 'p')).some((f) => /\.(svg|htm)$/.test(f) || (f.endsWith('.html') && f.startsWith(chain.named.html) && f !== chain.named.html + '.html')));
  // list, sitemap, robots
  const list = readFileSync(P('index.html'), 'utf8');
  assert.ok(list.indexOf('מפרט טכני מלא') < list.indexOf('פרסום לדוגמה 1<'), 'newest first');
  assert.ok(list.includes('id="q"') && list.includes('<option>פרסום מונע / המצאה</option>'), 'search box and type filter');
  assert.ok(list.includes('מאת סולאר-טק'));
  const ij = JSON.parse(readFileSync(P('index.json'), 'utf8'));
  assert.equal(ij.publications.find((x) => x.txid === chain.named.text).publisher, 'סולאר-טק בע"מ');
  const sm = readFileSync(join(out, 'sitemap.xml'), 'utf8');
  assert.equal((sm.match(/<loc>/g) || []).length, 2 + 26 + 1);
  assert.ok(readFileSync(join(out, 'robots.txt'), 'utf8').includes('Sitemap: https://example.github.io/archiv/sitemap.xml'));
  console.log('INDEX TESTS PASSED (' + out + ')');
} finally { server.close(); }
