// ארכיב inscription engine. Pure and synchronous: builds and signs every transaction locally.
// Used by the web app (bundled) and by the Node tests.
import * as btc from '@scure/btc-signer';
import * as ordinals from 'micro-ordinals';
import { hex, utf8 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';

export const NETWORKS = {
  mainnet: { btc: btc.NETWORK, api: 'https://mempool.space/api', explorer: 'https://mempool.space', ordinals: 'https://ordinals.com' },
  testnet4: { btc: btc.TEST_NETWORK, api: 'https://mempool.space/testnet4/api', explorer: 'https://mempool.space/testnet4', ordinals: '' },
  signet: { btc: btc.TEST_NETWORK, api: 'https://mempool.space/signet/api', explorer: 'https://mempool.space/signet', ordinals: 'https://signet.ordinals.com' },
};

export const ARCHIVE_TAG = 'archiv-v1';      // fixes the archive address; never change after the first registration
export const POSTAGE = 546n;                 // value of each inscription output, locked forever with it
export const MAX_PART = 360_000;             // bytes per transaction; keeps each reveal under the 400k weight-unit limit
export const MAX_PARTS = 20;
export const MAX_DOC = MAX_PART * MAX_PARTS; // largest stored (possibly compressed) document
const CHAIN_LIMIT_VB = 95_000;               // unconfirmed-chain size policy (101 kvB) with a margin
const ZERO_AUX = new Uint8Array(32);         // deterministic Schnorr signatures, so recovery rebuilds identical txs
const customScripts = [ordinals.OutOrdinalReveal];

export const toHex = (b) => hex.encode(b);
export const fromHex = (s) => hex.decode(s);
export const sha256Hex = (bytes) => hex.encode(sha256(bytes));
const concat = (...arrs) => { const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };

// ---------- archive address ----------
// Taproot output whose internal key is the BIP-341 NUMS point (no known private key) and whose
// only script leaf begins with OP_RETURN (always fails). Nothing sent here can ever move.
export function archivePayment(net) {
  const leaf = btc.Script.encode(['RETURN', utf8.decode(ARCHIVE_TAG)]);
  return btc.p2tr(btc.TAPROOT_UNSPENDABLE_KEY, { script: leaf }, net, true);
}
export const archiveAddress = (net) => archivePayment(net).address;
export function isAddress(addr, net) { try { btc.Address(net).decode(addr); return true; } catch { return false; } }

// ---------- keys ----------
export const newSecret = () => btc.utils.randomPrivateKeyBytes();
export const derive = (secret, label) => sha256(concat(secret, utf8.decode('archiv/' + label)));

// ---------- documents ----------
// doc = { stored, contentEncoding ('' | 'gzip'), contentType, title, file, sha256, size }
// `stored` is what goes on chain (maybe gzip); sha256 and size describe the original file.
export const MAX_ABSTRACT = 1500, MAX_KEYWORDS = 300;
export function makeDoc({ stored, contentEncoding = '', contentType, title = '', file = '', sha256: docHash, size, abstract = '', keywords = '' }) {
  if (!(stored instanceof Uint8Array) || !stored.length) throw new Error('empty document');
  if (stored.length > MAX_DOC) throw new Error('document too large');
  if (contentEncoding && contentEncoding !== 'gzip') throw new Error('unsupported encoding');
  if (!/^[0-9a-f]{64}$/.test(docHash || '')) throw new Error('missing document hash');
  return { stored, contentEncoding, contentType: contentType || 'application/octet-stream', title, file, sha256: docHash, size: size ?? stored.length,
    abstract: String(abstract).slice(0, MAX_ABSTRACT), keywords: String(keywords).slice(0, MAX_KEYWORDS) };
}
export const partCount = (doc) => Math.ceil(doc.stored.length / MAX_PART);
const baseMeta = (doc) => {
  const m = { app: ARCHIVE_TAG, title: doc.title, file: doc.file, sha256: doc.sha256, size: doc.size };
  if (doc.abstract) m.abstract = doc.abstract;
  if (doc.keywords) m.keywords = doc.keywords;
  return m;
};

function singleInscription(doc) {
  const tags = { contentType: doc.contentType, metadata: baseMeta(doc) };
  if (doc.contentEncoding) tags.contentEncoding = doc.contentEncoding;
  return { tags, body: doc.stored };
}
function partInscriptions(doc) {
  const n = partCount(doc), size = Math.ceil(doc.stored.length / n);
  return Array.from({ length: n }, (_, i) => ({
    tags: { contentType: 'application/octet-stream', metadata: { app: ARCHIVE_TAG, kind: 'part', doc: doc.sha256, i, n } },
    body: doc.stored.subarray(i * size, Math.min((i + 1) * size, doc.stored.length)),
  }));
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// The index is a small HTML page: it lists the parts and, opened on any ord explorer, fetches them
// through /content/<id>, joins them, decompresses and shows the document.
export function indexHtml(manifest) {
  const json = JSON.stringify(manifest).replace(/</g, '\\u003c');
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>' + esc(manifest.title || 'archiv') + '</title>'
    + '<body style="margin:0;font-family:sans-serif"><p id="s" style="padding:16px">Loading ' + manifest.parts.length + ' parts…</p>'
    + '<script type="application/json" id="archiv">' + json + '</script><script>'
    + '(async()=>{const m=JSON.parse(document.getElementById("archiv").textContent),s=document.getElementById("s"),b=[];'
    + 'for(const id of m.parts){const r=await fetch("/content/"+id);if(!r.ok)throw new Error("part "+id);b.push(new Uint8Array(await r.arrayBuffer()))}'
    + 'let d=new Blob(b);if(m.contentEncoding==="gzip")d=await new Response(d.stream().pipeThrough(new DecompressionStream("gzip"))).blob();'
    + 'd=new Blob([d],{type:m.contentType});if(m.contentType.startsWith("text/")){const p=document.createElement("pre");p.dir="auto";'
    + 'p.style.cssText="white-space:pre-wrap;padding:16px;margin:0";p.textContent=await d.text();s.replaceWith(p)}else{const f=document.createElement("iframe");'
    + 'f.src=URL.createObjectURL(d);f.style.cssText="border:0;width:100vw;height:100vh;display:block";s.replaceWith(f)}})()'
    + '.catch(e=>{document.getElementById("s").textContent="Could not load: "+e.message})</script>';
}
function indexInscription(doc, partIds) {
  const manifest = { ...baseMeta(doc), kind: 'multipart', contentType: doc.contentType, contentEncoding: doc.contentEncoding, parts: partIds };
  return { tags: { contentType: 'text/html;charset=utf-8', metadata: manifest }, body: utf8.decode(indexHtml(manifest)) };
}

// ---------- transactions ----------
function revealPayment(inscription, priv, net) {
  return btc.p2tr(undefined, ordinals.p2tr_ord_reveal(btc.utils.pubSchnorr(priv), [inscription]), net, false, customScripts);
}
const keyPayment = (priv, net) => btc.p2tr(btc.utils.pubSchnorr(priv), undefined, net);

function revealTx(payment, priv, utxo, net, change) {
  const tx = new btc.Transaction({ customScripts });
  tx.addInput({ ...payment, txid: utxo.txid, index: utxo.vout, witnessUtxo: { script: payment.script, amount: BigInt(utxo.value) } });
  tx.addOutputAddress(archiveAddress(net), POSTAGE, net);
  if (change) tx.addOutputAddress(change.address, change.amount, net);
  tx.sign(priv, undefined, ZERO_AUX); tx.finalize();
  return tx;
}
function keySpendTx(payment, priv, utxo, outputs, net) {
  const tx = new btc.Transaction();
  tx.addInput({ txid: utxo.txid, index: utxo.vout, witnessUtxo: { script: payment.script, amount: BigInt(utxo.value) }, tapInternalKey: payment.tapInternalKey });
  for (const o of outputs) tx.addOutputAddress(o.address, o.amount, net);
  tx.sign(priv, undefined, ZERO_AUX); tx.finalize();
  return tx;
}
const DUMMY = (value = 10_000_000) => ({ txid: '00'.repeat(32), vout: 0, value });
const fee = (vsize, rate) => BigInt(Math.ceil(vsize * rate));
const pack = (name, tx) => ({ name, txid: tx.id, hex: hex.encode(tx.extract()), vsize: tx.vsize });

// Transaction sizes do not depend on keys or fee rate, so they are measured once per document.
export function measure(doc, net) {
  const k = new Uint8Array(32).fill(7);
  if (partCount(doc) === 1) {
    const ins = singleInscription(doc), pay = revealPayment(ins, k, net);
    return { mode: 'single', reveal: revealTx(pay, k, DUMMY(), net).vsize,
      revealWithChange: revealTx(pay, k, DUMMY(), net, { address: archiveAddress(net), amount: 1000n }).vsize };
  }
  const parts = partInscriptions(doc).map((ins) => revealTx(revealPayment(ins, k, net), k, DUMMY(), net).vsize);
  const fakeIds = parts.map(() => 'ab'.repeat(32) + 'i0');
  const idx = indexInscription(doc, fakeIds);
  const indexReveal = revealTx(revealPayment(idx, k, net), k, DUMMY(), net).vsize;
  const kp = keyPayment(k, net), a = archiveAddress(net);
  const indexCommit = keySpendTx(kp, k, DUMMY(), [{ address: a, amount: 1000n }], net).vsize;
  const outs = Array.from({ length: parts.length + 1 }, () => ({ address: a, amount: 1000n }));
  const split = keySpendTx(kp, k, DUMMY(), outs, net).vsize;
  const splitWithChange = keySpendTx(kp, k, DUMMY(), [...outs, { address: a, amount: 1000n }], net).vsize;
  return { mode: 'multi', parts, indexReveal, indexCommit, split, splitWithChange };
}

// Everything needed before payment: where the user pays and how much.
export function createPlan(doc, net, secret, feeRate, sizes = measure(doc, net)) {
  if (!(feeRate > 0)) throw new Error('fee rate must be positive');
  if (sizes.mode === 'single') {
    const ins = singleInscription(doc), priv = derive(secret, 'reveal'), pay = revealPayment(ins, priv, net);
    const f = fee(sizes.reveal, feeRate);
    return { mode: 'single', doc, net, secret, feeRate, sizes, ins, priv, pay, payAddress: pay.address,
      total: POSTAGE + f, fees: f, txCount: 1, vsize: sizes.reveal };
  }
  const partAmts = sizes.parts.map((v) => POSTAGE + fee(v, feeRate));
  const idxCommitFee = fee(sizes.indexCommit, feeRate), idxRevealFee = fee(sizes.indexReveal, feeRate);
  const idxFund = POSTAGE + idxCommitFee + idxRevealFee;
  const splitFee = fee(sizes.split, feeRate);
  const total = partAmts.reduce((a, b) => a + b, 0n) + idxFund + splitFee;
  const fundPriv = derive(secret, 'fund'), fundPay = keyPayment(fundPriv, net);
  const vsize = sizes.split + sizes.parts.reduce((a, b) => a + b, 0) + sizes.indexCommit + sizes.indexReveal;
  return { mode: 'multi', doc, net, secret, feeRate, sizes, partAmts, idxFund, idxCommitFee, splitFee, fundPriv, fundPay,
    payAddress: fundPay.address, total, fees: total - POSTAGE * BigInt(sizes.parts.length + 1),
    txCount: sizes.parts.length + 3, vsize, needsConfirmation: vsize > CHAIN_LIMIT_VB };
}

// After payment: every transaction, signed, in broadcast order.
// waitAfter: index of a transaction that must confirm before the rest are sent (-1 = send all at once).
export function buildTransactions(plan, utxo, { refundAddress } = {}) {
  const { net, feeRate } = plan, value = BigInt(utxo.value);
  if (refundAddress && !isAddress(refundAddress, net)) throw new Error('invalid refund address');
  if (value < plan.total) throw new Error('payment too small');
  const excess = value - plan.total;

  if (plan.mode === 'single') {
    let tx = revealTx(plan.pay, plan.priv, utxo, net);
    const changeAmt = excess - fee(plan.sizes.revealWithChange - plan.sizes.reveal, feeRate);
    if (refundAddress && changeAmt >= 1000n) tx = revealTx(plan.pay, plan.priv, utxo, net, { address: refundAddress, amount: changeAmt });
    const t = pack('reveal', tx);
    return { txs: [t], waitAfter: -1, documentId: t.txid + 'i0', refunded: tx.outputsLength > 1 ? changeAmt : 0n, fees: value - POSTAGE - (tx.outputsLength > 1 ? changeAmt : 0n) };
  }

  const a = archiveAddress(net), parts = partInscriptions(plan.doc);
  const partPrivs = parts.map((_, i) => derive(plan.secret, 'part/' + i));
  const partPays = parts.map((ins, i) => revealPayment(ins, partPrivs[i], net));
  const idxFundPriv = derive(plan.secret, 'index-fund'), idxFundPay = keyPayment(idxFundPriv, net);
  const outs = [...partPays.map((p, i) => ({ address: p.address, amount: plan.partAmts[i] })), { address: idxFundPay.address, amount: plan.idxFund }];
  const changeAmt = excess - fee(plan.sizes.splitWithChange - plan.sizes.split, feeRate);
  const refunded = refundAddress && changeAmt >= 1000n ? changeAmt : 0n;
  if (refunded) outs.push({ address: refundAddress, amount: refunded });
  const split = keySpendTx(plan.fundPay, plan.fundPriv, utxo, outs, net);
  const reveals = partPays.map((p, i) => revealTx(p, partPrivs[i], { txid: split.id, vout: i, value: plan.partAmts[i] }, net));
  const partIds = reveals.map((t) => t.id + 'i0');
  const idxIns = indexInscription(plan.doc, partIds), idxPriv = derive(plan.secret, 'index'), idxPay = revealPayment(idxIns, idxPriv, net);
  const idxCommit = keySpendTx(idxFundPay, idxFundPriv, { txid: split.id, vout: parts.length, value: plan.idxFund }, [{ address: idxPay.address, amount: plan.idxFund - plan.idxCommitFee }], net);
  const idxReveal = revealTx(idxPay, idxPriv, { txid: idxCommit.id, vout: 0, value: plan.idxFund - plan.idxCommitFee }, net);
  const txs = [pack('split', split), ...reveals.map((t, i) => pack('part ' + (i + 1), t)), pack('index-commit', idxCommit), pack('index', idxReveal)];
  const minRate = Math.min(...txs.map((t, i) => {
    const tx = [split, ...reveals, idxCommit, idxReveal][i];
    const inV = i === 0 ? value : i <= reveals.length ? plan.partAmts[i - 1] : i === reveals.length + 1 ? plan.idxFund : plan.idxFund - plan.idxCommitFee;
    const outV = Array.from({ length: tx.outputsLength }, (_, j) => tx.getOutput(j).amount).reduce((x, y) => x + y, 0n);
    return Number(inV - outV) / tx.vsize;
  }));
  if (minRate < feeRate * 0.95) throw new Error('internal fee error');
  return { txs, waitAfter: plan.needsConfirmation ? 0 : -1, documentId: idxReveal.id + 'i0', partIds, refunded, fees: value - refunded - POSTAGE * BigInt(parts.length + 1) };
}

// ---------- reading back ----------
export function parseWitnessHex(witnessHex) {
  const found = ordinals.parseWitness(witnessHex.map((w) => hex.decode(w)));
  if (!found || !found.length) return null;
  const ins = found[0];
  return { contentType: ins.tags.contentType || 'application/octet-stream', contentEncoding: ins.tags.contentEncoding || '', metadata: ins.tags.metadata || {}, body: ins.body };
}

// ---------- recovery ----------
export function exportRecovery(plan, networkName, refundAddress = '') {
  const d = plan.doc;
  return JSON.stringify({ v: 2, network: networkName, secret: hex.encode(plan.secret), feeRate: plan.feeRate, refund: refundAddress, payAddress: plan.payAddress,
    doc: { stored: hex.encode(d.stored), contentEncoding: d.contentEncoding, contentType: d.contentType, title: d.title, file: d.file, sha256: d.sha256, size: d.size, abstract: d.abstract, keywords: d.keywords } });
}
export function importRecovery(json) {
  const r = typeof json === 'string' ? JSON.parse(json) : json;
  if (r.v !== 2) throw new Error('unsupported recovery file');
  const net = NETWORKS[r.network].btc;
  const doc = makeDoc({ ...r.doc, stored: hex.decode(r.doc.stored) });
  const plan = createPlan(doc, net, hex.decode(r.secret), r.feeRate);
  if (plan.payAddress !== r.payAddress) throw new Error('recovery file does not match');
  return { plan, networkName: r.network, refund: r.refund || '' };
}
