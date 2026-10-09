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
  const doc = docFrom(raw, 'text/plain;charset=utf-8', 'חוזה', 'c.txt', true, { abstract: 'תקציר לבדיקה', keywords: 'חוזה, בדיקה', publisher: 'ישראלה ישראלי בע"מ', category: 'חוזה / הסכם' });
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
  assert.equal(p.metadata.publisher, 'ישראלה ישראלי בע"מ');
  assert.equal(p.metadata.category, 'חוזה / הסכם');
  { const back = E.importRecovery(E.exportRecovery(plan, 'testnet4')); assert.equal(back.plan.doc.publisher, 'ישראלה ישראלי בע"מ'); assert.equal(E.buildTransactions(back.plan, utxo).txs[0].txid, out.txs[0].txid); }
  // old recovery files (no publisher/category) still load
  { const d0 = E.makeDoc({ ...doc, publisher: '', category: '' }); const p0 = E.createPlan(d0, net, secret, 2);
    const r = JSON.parse(E.exportRecovery(p0, 'testnet4')); delete r.doc.publisher; delete r.doc.category; E.importRecovery(r);
    assert.ok(!('publisher' in E.parseWitnessHex(witnessHex(parse(E.buildTransactions(p0, utxo).txs[0].hex))).metadata)); }
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

// 9. removal by the publisher
{
  const doc = docFrom(utf8.decode('uploaded by mistake'), 'text/plain;charset=utf-8', 'oops', '', false);
  const plan = E.createPlan(doc, net, E.newSecret(), 1);
  const out = E.buildTransactions(plan, { txid: 'cd'.repeat(32), vout: 0, value: Number(plan.total) });
  const target = { txid: out.txs[0].txid, witness: witnessHex(parse(out.txs[0].hex)) };
  assert.ok(E.ownsTarget(E.importRecovery(E.exportRecovery(plan, 'testnet4')).plan, target.witness), 'recovery file owns its document');
  const otherPlan = E.createPlan(doc, net, E.newSecret(), 1);
  assert.ok(!E.ownsTarget(otherPlan, target.witness), 'another secret does not');
  const keyMeta = (sig) => ({ app: E.ARCHIVE_TAG, kind: 'withdraw', network: 'testnet4', target: target.txid, proof: { type: 'key', sig } });
  assert.ok(E.verifyWithdrawal(keyMeta(E.signWithdrawWithKey(plan, 'testnet4', target.txid)), target, 'testnet4', net));
  assert.ok(!E.verifyWithdrawal(keyMeta(E.signWithdrawWithKey(otherPlan, 'testnet4', target.txid)), target, 'testnet4', net), 'wrong key');
  assert.ok(!E.verifyWithdrawal({ ...keyMeta(E.signWithdrawWithKey(plan, 'testnet4', target.txid)), network: 'mainnet' }, target, 'testnet4', net), 'wrong network');
  const sigOther = E.signWithdrawWithKey(plan, 'testnet4', 'ab'.repeat(32));
  assert.ok(!E.verifyWithdrawal(keyMeta(sigOther), target, 'testnet4', net), 'signature for another document');
  // wallet proof
  const wk = new Uint8Array(32).fill(3), { secp256k1 } = await import('@noble/curves/secp256k1.js');
  const payer = btc.p2wpkh(secp256k1.getPublicKey(wk, true), net).address;
  const wsig = E.signMessageForTest(E.withdrawMessage('testnet4', target.txid), wk);
  const walletMeta = { app: E.ARCHIVE_TAG, kind: 'withdraw', network: 'testnet4', target: target.txid, proof: { type: 'wallet', address: payer, sig: wsig } };
  assert.ok(E.verifyWithdrawal(walletMeta, target, 'testnet4', net, [payer]));
  assert.ok(!E.verifyWithdrawal(walletMeta, target, 'testnet4', net, ['tb1qother']), 'signer did not pay');
  assert.ok(!E.verifyWithdrawal({ ...walletMeta, proof: { ...walletMeta.proof, address: 'tb1qother' } }, target, 'testnet4', net, ['tb1qother']), 'claimed address is not the signer');
  // multipart: the index reveal's key is the owner key
  const big = new Uint8Array(randomBytes(400_000));
  const mdoc = E.makeDoc({ stored: big, contentType: 'application/octet-stream', sha256: E.sha256Hex(big), size: big.length });
  const mplan = E.createPlan(mdoc, net, E.newSecret(), 1);
  const mout = E.buildTransactions(mplan, { txid: 'ef'.repeat(32), vout: 0, value: Number(mplan.total) });
  assert.ok(E.ownsTarget(mplan, witnessHex(parse(mout.txs.at(-1).hex))), 'multipart owner key');
  // the withdraw record itself round-trips through a recovery file
  const wd = E.makeWithdrawDoc({ networkName: 'testnet4', targetTxid: target.txid, proof: walletMeta.proof });
  const wplan = E.createPlan(wd, net, E.newSecret(), 1);
  const back = E.importRecovery(E.exportRecovery(wplan, 'testnet4')).plan;
  assert.equal(back.payAddress, wplan.payAddress);
  const wtx = E.buildTransactions(wplan, { txid: '12'.repeat(32), vout: 0, value: Number(wplan.total) });
  const wm = E.parseWitnessHex(witnessHex(parse(wtx.txs[0].hex))).metadata;
  assert.equal(wm.kind, 'withdraw'); assert.equal(wm.target, target.txid); assert.ok(E.verifyWithdrawal(wm, target, 'testnet4', net, [payer]));
  console.log('withdraw: key + wallet proofs ok, cost', wplan.total, 'sats at 1 sat/vB');
  // operator list
  const oh = E.operatorHidden({ hiddenTxids: ['aa'.repeat(32), 'bad'], hidden: [{ txid: 'bb'.repeat(32), reason: 'r', date: 'd' }, { txid: 'nope' }] });
  assert.deepEqual([...oh.keys()], ['aa'.repeat(32), 'bb'.repeat(32)]);
}

// 10. underpaid: publish at a lower fee rate with the same payment address, or not at all
{
  const t = utf8.decode('underpaid example '.repeat(30));
  const d = E.makeDoc({ stored: t, contentType: 'text/plain', sha256: E.sha256Hex(t), size: t.length });
  const p = E.createPlan(d, net, E.newSecret(), 10);
  const got = p.total * 6n / 10n; // paid 60%
  const low = E.planWithin(p, got);
  assert.ok(low && low.feeRate < 10 && low.feeRate >= 1, 'lower rate found: ' + (low && low.feeRate));
  assert.equal(low.payAddress, p.payAddress, 'same payment address');
  const o = E.buildTransactions(low, { txid: '44'.repeat(32), vout: 0, value: Number(got) });
  assert.ok(o.txs.length === 1);
  assert.equal(E.planWithin(p, 600n), null, 'too little even at the minimum rate');
  console.log('underpaid: publishes at', low.feeRate.toFixed(2), 'sat/vB instead of 10');
}

console.log('ALL ENGINE TESTS PASSED');
