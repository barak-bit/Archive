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
