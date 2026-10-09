import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as btc from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hex, utf8 } from '@scure/base';
import * as E from './engine.js';
const net = E.NETWORKS.testnet4.btc;
const raw = new Uint8Array(randomBytes(800_000));
const doc = E.makeDoc({ stored: raw, contentType: 'application/pdf', title: 't', sha256: E.sha256Hex(raw) });
const plan = E.createPlan(doc, net, E.newSecret(), 1);
// the user's payment output, as it would appear on chain
const payScript = btc.OutScript.encode(btc.Address(net).decode(plan.payAddress));
const utxo = { txid: '11'.repeat(32), vout: 0, value: Number(plan.total) };
const out = E.buildTransactions(plan, utxo);
const txs = out.txs.map((t) => btc.Transaction.fromRaw(hex.decode(t.hex), { allowUnknownOutputs: true }));
const prevOut = new Map([[`${utxo.txid}:0`, { script: payScript, amount: BigInt(utxo.value) }]]);
for (const tx of txs) for (let j = 0; j < tx.outputsLength; j++) prevOut.set(`${tx.id}:${j}`, tx.getOutput(j));
let n = 0;
for (const tx of txs) {
  const inp = tx.getInput(0), prev = prevOut.get(`${hex.encode(inp.txid)}:${inp.index}`);
  assert.ok(prev, 'missing prevout');
  const w = inp.finalScriptWitness;
  const outKey = btc.OutScript.decode(prev.script).pubkey; // taproot output key
  if (w.length === 1) { // key path
    const msg = tx.preimageWitnessV1(0, [prev.script], btc.SigHash.DEFAULT, [prev.amount]);
    assert.ok(schnorr.verify(w[0].subarray(0, 64), msg, outKey), 'key-path sig');
  } else { // script path: [sig, leafScript, controlBlock]
    const leaf = w[1], cb = w[2];
    const leafKey = btc.Script.decode(leaf)[0];
    const msg = tx.preimageWitnessV1(0, [prev.script], btc.SigHash.DEFAULT, [prev.amount], undefined, leaf, cb[0] & 0xfe);
    assert.ok(schnorr.verify(w[0].subarray(0, 64), msg, leafKey), 'script-path sig');
  }
  n++;
}
console.log('verified signatures on', n, 'transactions');

// Every input of a transaction, as the network checks it: the signature, and for script paths that the
// control block really commits the leaf to the output key being spent (BIP-341).
import { sha256 } from '@noble/hashes/sha2.js';
const tagged = (tag, ...m) => { const t = sha256(utf8.decode(tag)); return sha256(new Uint8Array([...t, ...t, ...m.flatMap((x) => [...x])])); };
const compact = (n) => n < 253 ? [n] : [253, n & 255, n >> 8];
function verifyAll(tx, prevs) {
  const scripts = prevs.map((p) => p.script), amounts = prevs.map((p) => p.amount);
  for (let i = 0; i < tx.inputsLength; i++) {
    const w = tx.getInput(i).finalScriptWitness, outKey = btc.OutScript.decode(prevs[i].script).pubkey;
    if (w.length === 1) { assert.ok(schnorr.verify(w[0].subarray(0, 64), tx.preimageWitnessV1(i, scripts, btc.SigHash.DEFAULT, amounts), outKey), `input ${i}: key-path sig`); continue; }
    const leaf = w[w.length - 2], cb = w[w.length - 1], ver = cb[0] & 0xfe;
    assert.ok(schnorr.verify(w[0].subarray(0, 64), tx.preimageWitnessV1(i, scripts, btc.SigHash.DEFAULT, amounts, undefined, leaf, ver), btc.Script.decode(leaf)[0]), `input ${i}: script-path sig`);
    let h = tagged('TapLeaf', [ver], compact(leaf.length), leaf);
    for (let k = 33; k < cb.length; k += 32) { const e = cb.subarray(k, k + 32); h = hex.encode(h) < hex.encode(e) ? tagged('TapBranch', h, e) : tagged('TapBranch', e, h); }
    const [tweaked] = btc.utils.taprootTweakPubkey(cb.subarray(1, 33), h);
    assert.equal(hex.encode(tweaked), hex.encode(outKey), `input ${i}: control block commits to the output key`);
  }
}
{
  const small = utf8.decode('short text'), sdoc = E.makeDoc({ stored: small, contentType: 'text/plain', title: 's', sha256: E.sha256Hex(small) });
  for (const [label, p] of [['single', E.createPlan(sdoc, net, E.newSecret(), 2)], ['multipart', plan]]) {
    const script = btc.OutScript.encode(btc.Address(net).decode(p.payAddress));
    // the payment arrived in three pieces: too little at first, then two top-ups
    const pays = [{ txid: 'aa'.repeat(32), vout: 1, value: 300 }, { txid: '22'.repeat(32), vout: 0, value: 200 }, { txid: '33'.repeat(32), vout: 2, value: Number(E.amountDue(p, 3)) }];
    assert.throws(() => E.buildTransactions(p, pays.slice(0, 2)), (e) => e.missing > 0n);
    const o = E.buildTransactions(p, pays);
    const first = btc.Transaction.fromRaw(hex.decode(o.txs[0].hex), { allowUnknownOutputs: true });
    assert.equal(first.inputsLength, 3);
    const sorted = [...pays].sort((a, b) => a.txid < b.txid ? -1 : 1).map((u) => ({ script, amount: BigInt(u.value) }));
    verifyAll(first, sorted);
    if (label === 'single') {
      const w0 = first.getInput(0).finalScriptWitness;
      assert.ok(E.parseWitnessHex(w0.map((x) => hex.encode(x))), 'input 0 still carries the inscription');
      assert.ok(first.getInput(1).finalScriptWitness[1].length === 34, 'extra payments use the small key leaf');
      const rate = Number(sum(pays) - POSTAGE()) / first.vsize; assert.ok(rate >= 2 * 0.95, 'fee rate kept with extra inputs: ' + rate);
    }
    // refund instead of publishing
    const r = E.buildRefund(p, pays, btc.p2tr(btc.utils.pubSchnorr(E.newSecret()), undefined, net).address, 2);
    const rtx = btc.Transaction.fromRaw(hex.decode(r.hex), { allowUnknownOutputs: true });
    verifyAll(rtx, sorted);
    if (label === 'single') assert.ok(!E.parseWitnessHex(rtx.getInput(0).finalScriptWitness.map((x) => hex.encode(x))), 'a refund does not reveal the document');
    assert.equal(r.amount + r.fee, sum(pays));
    console.log(label + ': 3 payments and refund verified; refund', r.amount, 'fee', r.fee);
  }
}
function sum(us) { return us.reduce((n, u) => n + BigInt(u.value), 0n); }
function POSTAGE() { return E.POSTAGE; }
