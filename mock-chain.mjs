// A fake Bitcoin API (the subset of the mempool.space/Esplora API that ארכיב uses), filled with
// real, signed registrations built by the engine. Used by the tests; also runnable for a local demo:
//   node mock-chain.mjs 8787
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import * as btc from '@scure/btc-signer';
import * as ordinals from 'micro-ordinals';
import { hex, utf8 } from '@scure/base';
import * as E from './engine.js';

const net = E.NETWORKS.testnet4.btc;
const ARCHIVE = E.archiveAddress(net);
const witnessHex = (tx) => tx.getInput(0).finalScriptWitness.map((w) => hex.encode(w));
const parse = (h) => btc.Transaction.fromRaw(hex.decode(h), { allowUnknownOutputs: true });

function makeDoc(bytes, contentType, title, extra = {}) {
  const z = new Uint8Array(gzipSync(bytes, { level: 9 }));
  const useZ = !/pdf|image/.test(contentType) && z.length < bytes.length * 0.9;
  return E.makeDoc({ stored: useZ ? z : bytes, contentEncoding: useZ ? 'gzip' : '', contentType, title, sha256: E.sha256Hex(bytes), size: bytes.length, ...extra });
}
// Returns the archive-bound transactions of one registration (the reveals), oldest first.
function register(doc) {
  const plan = E.createPlan(doc, net, E.newSecret(), 1);
  const out = E.buildTransactions(plan, { txid: randomBytes(32).toString('hex'), vout: 0, value: Number(plan.total) });
  return out.txs.filter((t) => t.name === 'reveal' || t.name === 'index' || t.name.startsWith('part')).map((t) => parse(t.hex));
}
function external(text) {
  const ins = { tags: { contentType: 'text/plain;charset=utf-8', metadata: { title: 'external' } }, body: utf8.decode(text) };
  const k = E.newSecret();
  const pay = btc.p2tr(undefined, ordinals.p2tr_ord_reveal(btc.utils.pubSchnorr(k), [ins]), net, false, [ordinals.OutOrdinalReveal]);
  const tx = new btc.Transaction({ customScripts: [ordinals.OutOrdinalReveal] });
  tx.addInput({ ...pay, txid: randomBytes(32).toString('hex'), index: 0, witnessUtxo: { script: pay.script, amount: 20000n } });
  tx.addOutputAddress(ARCHIVE, 546n, net); tx.sign(k, undefined, new Uint8Array(32)); tx.finalize();
  return [tx];
}

export function buildChain() {
  const named = {};
  const regs = [];
  const add = (name, txs) => { named[name] = txs[txs.length - 1].id; regs.push(txs); };
  for (let i = 1; i <= 22; i++) add('filler' + i, register(makeDoc(utf8.decode(`פרסום מספר ${i}: תיאור קצר של המצאה לדוגמה.`), 'text/plain;charset=utf-8', `פרסום לדוגמה ${i}`)));
  const textBody = 'שיטה לחיבור לוחות סולאריים בלי כלים.\n\n1. מניחים את הלוח על המסילה.\n2. מסובבים את התפס עד הנקישה.\n';
  add('text', register(makeDoc(utf8.decode(textBody), 'text/plain;charset=utf-8', 'תפס מהיר ללוחות סולאריים', { abstract: 'תפס שמחבר לוח סולארי למסילה בסיבוב אחד, בלי ברגים ובלי כלים.', keywords: 'סולארי, תפס, התקנה', publisher: 'סולאר-טק בע"מ', category: 'פרסום מונע / המצאה' })));
  add('gzip', register(makeDoc(utf8.decode('Claim: a method for archiving documents permanently.\n'.repeat(4000)), 'text/plain;charset=utf-8', 'Long gzip text')));
  const pdf = new Uint8Array(randomBytes(800_000)); pdf.set(utf8.decode('%PDF-1.7\n'));
  add('multipart', register(makeDoc(pdf, 'application/pdf', 'מפרט טכני מלא', { abstract: 'מפרט של 120 עמודים.', file: 'spec.pdf' })));
  add('html', register(makeDoc(utf8.decode('<script>alert(1)</script>'), 'text/html;charset=utf-8', 'דף HTML')));
  add('external', external('not from archiv'));
  add('hidden', register(makeDoc(utf8.decode('should be hidden'), 'text/plain;charset=utf-8', 'מוסתר')));
  const good = utf8.decode('real content');
  add('tampered', register(E.makeDoc({ stored: good, contentType: 'text/plain;charset=utf-8', title: 'מזויף', sha256: 'ab'.repeat(32), size: good.length })));
  // Newest first, as the API returns them. Each registration gets its own block.
  const txs = [];
  regs.forEach((list, r) => list.forEach((tx) => txs.push({
    txid: tx.id, vin: [{ witness: witnessHex(tx) }],
    vout: [{ scriptpubkey_address: ARCHIVE, value: 546 }],
    status: { confirmed: true, block_height: 120000 + r, block_time: 1790000000 + r * 600 },
  })));
  txs.reverse();
  return { txs, named, pdf, textBody };
}

export function serve(chain, port = 0) {
  const byId = new Map(chain.txs.map((t) => [t.txid, t]));
  const server = http.createServer((req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    const u = new URL(req.url, 'http://x').pathname;
    let m;
    if ((m = u.match(/^\/address\/(\w+)\/txs\/chain(?:\/([0-9a-f]{64}))?$/))) {
      const list = m[1] === ARCHIVE ? chain.txs : [];
      const start = m[2] ? list.findIndex((t) => t.txid === m[2]) + 1 : 0;
      return send(200, list.slice(start, start + 25));
    }
    if ((m = u.match(/^\/address\/(\w+)\/txs$/))) return send(200, m[1] === ARCHIVE ? chain.txs.slice(0, 25) : []);
    if ((m = u.match(/^\/tx\/([0-9a-f]{64})$/))) return byId.has(m[1]) ? send(200, byId.get(m[1])) : send(404, 'Transaction not found');
    // Like mempool.space: /status answers 200 {"confirmed":false} even for unknown transactions.
    if ((m = u.match(/^\/tx\/([0-9a-f]{64})\/status$/))) return send(200, byId.get(m[1])?.status || { confirmed: false });
    if (u === '/v1/fees/recommended') return send(200, { fastestFee: 3, halfHourFee: 2, hourFee: 1, economyFee: 1, minimumFee: 1 });
    send(404, 'not found');
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await serve(buildChain(), Number(process.argv[2] || 8787));
  console.log('mock API on http://127.0.0.1:' + s.address().port);
}
