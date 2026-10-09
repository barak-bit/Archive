// A fake Bitcoin API (the subset of the mempool.space/Esplora API that ארכיב uses), filled with
// real, signed registrations built by the engine. Used by the tests; also runnable for a local demo:
//   node mock-chain.mjs 8787
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import * as btc from '@scure/btc-signer';
import * as ordinals from 'micro-ordinals';
import { hex, utf8 } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
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
// Every transaction outside the archive listing that the API must still answer for: the payment
// (with the payer's address) and, for multipart documents, the split and index-commit transactions.
const side = new Map();
const PAYER_KEY = new Uint8Array(32).fill(5);
export const PAYER = btc.p2wpkh(secp256k1.getPublicKey(PAYER_KEY, true), net).address;
const vinOf = (tx) => [{ txid: hex.encode(tx.getInput(0).txid), witness: witnessHex(tx) }];
// Registers a document paid from `payer`. Returns the archive-bound transactions (reveals), oldest first; .plan holds the plan.
function register(doc, payer = PAYER) {
  const plan = E.createPlan(doc, net, E.newSecret(), 1);
  const payTxid = randomBytes(32).toString('hex');
  side.set(payTxid, { txid: payTxid, vin: [{ txid: 'ee'.repeat(32), prevout: { scriptpubkey_address: payer } }], vout: [{ scriptpubkey_address: plan.payAddress, value: Number(plan.total) }], status: { confirmed: true } });
  const out = E.buildTransactions(plan, { txid: payTxid, vout: 0, value: Number(plan.total) });
  for (const t of out.txs) if (t.name === 'split' || t.name === 'index-commit') { const tx = parse(t.hex); side.set(tx.id, { txid: tx.id, vin: vinOf(tx), vout: [], status: { confirmed: true } }); }
  const list = out.txs.filter((t) => t.name === 'reveal' || t.name === 'index' || t.name.startsWith('part')).map((t) => parse(t.hex));
  list.plan = plan;
  return list;
}
const lastId = (list) => list[list.length - 1].id;
const withdraw = (target, proof) => register(E.makeWithdrawDoc({ networkName: 'testnet4', targetTxid: lastId(target), proof }));
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
  const named = {}, issues = [];
  const regs = [];
  const add = (name, txs) => { named[name] = txs[txs.length - 1].id; regs.push(txs); };
  for (let i = 1; i <= 22; i++) add('filler' + i, register(makeDoc(utf8.decode(`פרסום מספר ${i}: תיאור קצר של המצאה לדוגמה.`), 'text/plain;charset=utf-8', `פרסום לדוגמה ${i}`)));
  const textBody = 'שיטה לחיבור לוחות סולאריים בלי כלים.\n\n1. מניחים את הלוח על המסילה.\n2. מסובבים את התפס עד הנקישה.\n';
  const textReg = register(makeDoc(utf8.decode(textBody), 'text/plain;charset=utf-8', 'תפס מהיר ללוחות סולאריים', { abstract: 'תפס שמחבר לוח סולארי למסילה בסיבוב אחד, בלי ברגים ובלי כלים.', keywords: 'סולארי, תפס, התקנה', publisher: 'סולאר-טק בע"מ', category: 'פרסום מונע / המצאה' }));
  add('text', textReg);
  add('gzip', register(makeDoc(utf8.decode('Claim: a method for archiving documents permanently.\n'.repeat(4000)), 'text/plain;charset=utf-8', 'Long gzip text')));
  const pdf = new Uint8Array(randomBytes(800_000)); pdf.set(utf8.decode('%PDF-1.7\n'));
  add('multipart', register(makeDoc(pdf, 'application/pdf', 'מפרט טכני מלא', { abstract: 'מפרט של 120 עמודים.', file: 'spec.pdf' })));
  add('html', register(makeDoc(utf8.decode('<script>alert(1)</script>'), 'text/html;charset=utf-8', 'דף HTML')));
  add('external', external('not from archiv'));
  add('hidden', register(makeDoc(utf8.decode('should be hidden'), 'text/plain;charset=utf-8', 'מוסתר')));
  // Removal by the publisher: with the recovery-file key, and with the wallet that paid (single and multipart).
  const byKey = register(makeDoc(utf8.decode('uploaded by mistake (key)'), 'text/plain;charset=utf-8', 'הועלה בטעות 1'));
  add('withdrawnKey', byKey);
  const byWallet = register(makeDoc(utf8.decode('uploaded by mistake (wallet)'), 'text/plain;charset=utf-8', 'הועלה בטעות 2'));
  add('withdrawnWallet', byWallet);
  const big = new Uint8Array(randomBytes(400_000));
  const multiW = register(makeDoc(big, 'application/octet-stream', 'הועלה בטעות 3 (שני חלקים)'));
  add('withdrawnMulti', multiW);
  const sigFor = (target) => E.signMessageForTest(E.withdrawMessage('testnet4', lastId(target)), PAYER_KEY);
  add('wdKey', withdraw(byKey, { type: 'key', sig: E.signWithdrawWithKey(byKey.plan, 'testnet4', lastId(byKey)) }));
  add('wdWallet', withdraw(byWallet, { type: 'wallet', address: PAYER, sig: sigFor(byWallet) }));
  add('wdMulti', withdraw(multiW, { type: 'wallet', address: PAYER, sig: sigFor(multiW) }));
  // GitHub requests: hidden by the operator's label, removed by the publisher's free signed request, and noise.
  const ghHidden = register(makeDoc(utf8.decode('defamatory text'), 'text/plain;charset=utf-8', 'פוגעני'));
  add('ghHidden', ghHidden);
  const ghWithdrawn = register(makeDoc(utf8.decode('uploaded by mistake (free request)'), 'text/plain;charset=utf-8', 'הועלה בטעות 4'));
  add('ghWithdrawn', ghWithdrawn);
  const otherForGh = register(makeDoc(utf8.decode('y'), 'text/plain;charset=utf-8', 'y'));
  const at = (d) => `2026-10-0${d}T10:00:00Z`;
  issues.push(
    { number: 1, title: 'לשון הרע (צו שיפוטי)', body: `המסמך ${lastId(ghHidden)}i0`, labels: [{ name: 'הסתרה' }], created_at: at(1), html_url: 'https://github.com/test/repo/issues/1' },
    { number: 2, title: 'תלונה שעדיין לא טופלה', body: `המסמך ${lastId(textReg)}i0`, labels: [], created_at: at(2), html_url: 'https://github.com/test/repo/issues/2' },
    { number: 3, title: 'בקשת הסרה', body: E.removalRequestText('testnet4', lastId(ghWithdrawn), { type: 'key', sig: E.signWithdrawWithKey(ghWithdrawn.plan, 'testnet4', lastId(ghWithdrawn)) }), labels: [], created_at: at(3), html_url: 'https://github.com/test/repo/issues/3' },
    { number: 4, title: 'בקשת הסרה מזויפת', body: E.removalRequestText('testnet4', lastId(textReg), { type: 'key', sig: E.signWithdrawWithKey(otherForGh.plan, 'testnet4', lastId(textReg)) }), labels: [], created_at: at(4), html_url: 'https://github.com/test/repo/issues/4' },
    { number: 5, title: 'הסתרה של משהו שאינו מסמך', body: 'ab'.repeat(32), labels: [{ name: 'הסתרה' }], created_at: at(5), html_url: 'https://github.com/test/repo/issues/5' },
  );
  // Forged requests against the solar-clamp text: someone else's key, and a wallet that did not pay.
  const other = register(makeDoc(utf8.decode('x'), 'text/plain;charset=utf-8', 'x'));
  const textTarget = textReg;
  add('forgedKey', withdraw(textTarget, { type: 'key', sig: E.signWithdrawWithKey(other.plan, 'testnet4', named.text) }));
  const strangerKey = new Uint8Array(32).fill(9), stranger = btc.p2wpkh(secp256k1.getPublicKey(strangerKey, true), net).address;
  add('forgedWallet', withdraw(textTarget, { type: 'wallet', address: stranger, sig: E.signMessageForTest(E.withdrawMessage('testnet4', named.text), strangerKey) }));
  const good = utf8.decode('real content');
  add('tampered', register(E.makeDoc({ stored: good, contentType: 'text/plain;charset=utf-8', title: 'מזויף', sha256: 'ab'.repeat(32), size: good.length })));
  // Newest first, as the API returns them. Each registration gets its own block.
  const txs = [];
  regs.forEach((list, r) => list.forEach((tx) => txs.push({
    txid: tx.id, vin: vinOf(tx),
    vout: [{ scriptpubkey_address: ARCHIVE, value: 546 }],
    status: { confirmed: true, block_height: 120000 + r, block_time: 1790000000 + r * 600 },
  })));
  txs.reverse();
  return { txs, named, pdf, textBody, side, issues, ghWrites: [] };
}

export function serve(chain, port = 0) {
  const byId = new Map([...(chain.side || new Map()), ...chain.txs.map((t) => [t.txid, t])]);
  const server = http.createServer((req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    const u = new URL(req.url, 'http://x').pathname;
    let m;
    // A minimal GitHub API under /gh: issues (paged), labels, comments, closing.
    if (u.startsWith('/gh/')) {
      if (req.method !== 'GET') { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { chain.ghWrites.push([req.method, decodeURIComponent(u), b]); send(201, {}); }); return; }
      if (u === '/gh/repos/test/repo/issues') { const page = Number(new URL(req.url, 'http://x').searchParams.get('page') || 1); return send(200, page === 1 ? chain.issues : []); }
      if (u.startsWith('/gh/repos/test/repo/labels/')) return send(404, { message: 'Not Found' });
      return send(404, { message: 'Not Found' });
    }
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
