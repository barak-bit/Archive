import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import * as btc from '@scure/btc-signer';
import { hex, utf8 } from '@scure/base';
import * as E from './engine.js';

const net = E.NETWORKS.testnet4.btc;
const A = E.archiveAddress(net);
const addrOf = (script) => btc.Address(net).encode(btc.OutScript.decode(script));
const parse = (h) => btc.Transaction.fromRaw(hex.decode(h), { allowUnknownOutputs: true });
const witnessHex = (tx) => tx.getInput(0).finalScriptWitness.map((w) => hex.encode(w));
const sumOut = (tx) => Array.from({ length: tx.outputsLength }, (_, i) => tx.getOutput(i).amount).reduce((a, b) => a + b, 0n);
function docFrom(bytes, contentType, title, file, compress, extra = {}) {
  const z = compress ? new Uint8Array(gzipSync(bytes, { level: 9 })) : null;
  const useZ = z && z.length < bytes.length * 0.9;
  return E.makeDoc({ stored: useZ ? z : bytes, contentEncoding: useZ ? 'gzip' : '', contentType, title, file, sha256: E.sha256Hex(bytes), size: bytes.length, ...extra });
}

// 1. archive address
assert.ok(A.startsWith('tb1p'));
assert.equal(btc.Script.decode(E.archivePayment(net).leaves[0].script)[0], 'RETURN');

// 2. single document, gzip text, refund
{
  const text = 'חוזה לדוגמה – סעיף 1: הצדדים מסכימים.\n'.repeat(400);
  const raw = utf8.decode(text);
  const doc = docFrom(raw, 'text/plain;charset=utf-8', 'חוזה', 'c.txt', true, { abstract: 'תקציר לבדיקה', keywords: 'חוזה, בדיקה' });
  assert.equal(doc.contentEncoding, 'gzip');
  const secret = E.newSecret();
  const plan = E.createPlan(doc, net, secret, 2);
  assert.equal(plan.mode, 'single');
  const utxo = { txid: 'ab'.repeat(32), vout: 1, value: Number(plan.total) };
  const out = E.buildTransactions(plan, utxo);
  const tx = parse(out.txs[0].hex);
  assert.equal(addrOf(tx.getOutput(0).script), A);
  const p = E.parseWitnessHex(witnessHex(tx));
  assert.equal(p.contentEncoding, 'gzip');
  assert.equal(utf8.encode(gunzipSync(p.body)), text);
  assert.equal(p.metadata.sha256, E.sha256Hex(raw));
  assert.equal(p.metadata.abstract, 'תקציר לבדיקה');
  assert.equal(p.metadata.keywords, 'חוזה, בדיקה');
  assert.ok(Number(utxo.value - 546) / tx.vsize >= 2);
  console.log('single: raw', raw.length, 'stored', doc.stored.length, 'vsize', tx.vsize, 'total', plan.total);
  // overpay + refund
  const refund = btc.p2tr(btc.utils.pubSchnorr(E.newSecret()), undefined, net).address;
  const o2 = E.buildTransactions(plan, { ...utxo, value: Number(plan.total) + 40_000 }, { refundAddress: refund });
  const t2 = parse(o2.txs[0].hex);
  assert.equal(addrOf(t2.getOutput(1).script), refund);
  const rate2 = Number(BigInt(Number(plan.total) + 40_000) - sumOut(t2)) / t2.vsize;
  assert.ok(rate2 >= 1.95 && rate2 < 2.2, 'single refund rate ' + rate2);
  assert.throws(() => E.buildTransactions(plan, { ...utxo, value: Number(plan.total) - 1 }));
  assert.throws(() => E.buildTransactions(plan, utxo, { refundAddress: 'nope' }));
}

// 3. multipart: ~900KB incompressible PDF-like file -> 3 parts
{
  const raw = new Uint8Array(randomBytes(900_000)); raw.set(utf8.decode('%PDF-1.7\n'));
  const doc = docFrom(raw, 'application/pdf', 'תקנון ארוך', 'long.pdf', true);
  assert.equal(doc.contentEncoding, '', 'random data should not be compressed');
  assert.equal(E.partCount(doc), 3);
  const secret = E.newSecret();
  const sizes = E.measure(doc, net);
  const plan = E.createPlan(doc, net, secret, 1.5, sizes);
  assert.equal(plan.mode, 'multi');
  assert.ok(plan.needsConfirmation);
  const refund = btc.p2tr(btc.utils.pubSchnorr(E.newSecret()), undefined, net).address;
  const utxo = { txid: 'cd'.repeat(32), vout: 0, value: Number(plan.total) + 25_000 };
  const out = E.buildTransactions(plan, utxo, { refundAddress: refund });
  assert.equal(out.txs.length, 6);
  assert.equal(out.waitAfter, 0);
  const txs = out.txs.map((t) => parse(t.hex));
  const [split, p1, p2, p3, icommit, ireveal] = txs;
  // chain: split spends the payment; parts spend split outputs 0..2; index-commit spends output 3
  assert.equal(hex.encode(split.getInput(0).txid), utxo.txid);
  [p1, p2, p3].forEach((t, i) => { assert.equal(hex.encode(t.getInput(0).txid), split.id); assert.equal(t.getInput(0).index, i); assert.equal(addrOf(t.getOutput(0).script), A); });
  assert.equal(hex.encode(icommit.getInput(0).txid), split.id); assert.equal(icommit.getInput(0).index, 3);
  assert.equal(hex.encode(ireveal.getInput(0).txid), icommit.id);
  assert.equal(addrOf(ireveal.getOutput(0).script), A);
  assert.equal(addrOf(split.getOutput(4).script), refund);
  // every tx under the standard weight limit and at least the chosen fee rate
  const inputs = [utxo.value, ...plan.partAmts.map(Number), Number(plan.idxFund), Number(plan.idxFund - plan.idxCommitFee)];
  txs.forEach((t, i) => {
    assert.ok(t.weight <= 400_000, 'weight ' + t.weight);
    const rate = Number(BigInt(inputs[i]) - sumOut(t)) / t.vsize;
    assert.ok(rate >= 1.5 * 0.99, `tx ${i} rate ${rate}`);
  });
  // reassemble from parts using the index manifest
  const idx = E.parseWitnessHex(witnessHex(ireveal));
  assert.equal(idx.metadata.kind, 'multipart');
  assert.deepEqual(idx.metadata.parts, [p1, p2, p3].map((t) => t.id + 'i0'));
  const bodies = [p1, p2, p3].map((t) => E.parseWitnessHex(witnessHex(t)));
  bodies.forEach((b, i) => { assert.equal(b.metadata.kind, 'part'); assert.equal(b.metadata.i, i); assert.equal(b.metadata.doc, doc.sha256); });
  const joined = new Uint8Array(Buffer.concat(bodies.map((b) => Buffer.from(b.body))));
  assert.equal(E.sha256Hex(joined), idx.metadata.sha256);
  assert.ok(utf8.encode(idx.body).includes('/content/'));
  console.log('multi: parts', out.txs.length - 3, 'vsizes', out.txs.map((t) => t.vsize).join('/'), 'total', plan.total, 'refunded', out.refunded);
  // recovery rebuilds byte-identical transactions
  const rec = E.exportRecovery(plan, 'testnet4', refund);
  const back = E.importRecovery(rec);
  const out2 = E.buildTransactions(back.plan, utxo, { refundAddress: back.refund });
  assert.deepEqual(out2.txs.map((t) => t.txid), out.txs.map((t) => t.txid));
}

// 4. multipart gzip text (~1.4MB text compresses to ~2 parts or 1)
{
  const words = 'ארכיון ציבורי קבוע לכל אחד archive record verification '.split(' ');
  let s = ''; let seed = 7; while (s.length < 1_400_000) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; s += words[seed % words.length] + (seed % 13 ? ' ' : '\n'); }
  const raw = utf8.decode(s);
  const doc = docFrom(raw, 'text/plain;charset=utf-8', 'טקסט ארוך', 'long.txt', true);
  console.log('text raw', raw.length, '-> stored', doc.stored.length, doc.contentEncoding, 'parts', E.partCount(doc));
}

// 5. limits
assert.throws(() => E.makeDoc({ stored: new Uint8Array(E.MAX_DOC + 1), contentType: 'x', sha256: 'aa'.repeat(32) }));
assert.equal(E.partCount({ stored: new Uint8Array(E.MAX_PART) }), 1);
assert.equal(E.partCount({ stored: new Uint8Array(E.MAX_PART + 1) }), 2);

console.log('ALL ENGINE TESTS PASSED');
