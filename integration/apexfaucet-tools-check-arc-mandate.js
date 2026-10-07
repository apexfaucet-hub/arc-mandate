#!/usr/bin/env node
'use strict';
// ARC MANDATE NIGHTLY CHECK (2026-10-08). /arc/mandate/ tells people their agent's payments are checked by a contract on
// Arc and that standard x402 works through it. That stays true only while:
//   1. the factory and box code at the published addresses is the code we tested (code hash recorded at deployment);
//   2. Arc's USDC still asks a contract payer through EIP-1271 and our box still refuses what it should: the whole story
//      is re-run against the REAL token by eth_call (tools/arc-mandate-harness, nothing broadcast), and its planted fault
//      (a stranger's signature) must still be refused - a Circle upgrade of USDC that dropped 1271 would show up here;
//   3. our own Arc checkout still accepts box payments: arc-facilitator verify() on a garbage contract signature must say
//      "the paying contract refused this payment" (if the 1271 path were removed it would say "signature check failed").
// Exit 1 on any failure. `--plant` swaps the recorded factory hash and must make this exit 1.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const v = require('/root/apex-faucet/node_modules/viem');

const ROOT = '/root/apex-faucet';
const PLANT = process.argv.includes('--plant');
const S = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'arc-mandate.json'), 'utf8'));
const pub = v.createPublicClient({ transport: v.fallback(['https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.mainnet.arc.io'].map((u) => v.http(u, { timeout: 20000 })), { rank: false }) });
let fails = 0;
const say = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fails++; };

(async () => {
  // 1. code at the published addresses
  for (const [name, addr, want] of [['factory', S.factory, S.factoryCodeHash], ['implementation', S.implementation, S.implCodeHash]]) {
    let code = null;
    try { code = await pub.getBytecode({ address: addr }); } catch (e) { say(false, name + ': could not read code (' + (e.shortMessage || e.message) + ')'); continue; }
    const h = code ? v.keccak256(code) : null;
    const expect = PLANT && name === 'factory' ? '0x' + 'ab'.repeat(32) : want;
    say(!!h && h === expect, name + ' ' + addr + ' code hash ' + (h || 'none') + (h === expect ? '' : ' expected ' + expect));
  }
  // 2. the real-USDC story and its planted fault
  const H = path.join(ROOT, 'tools', 'arc-mandate-harness', 'run.mjs');
  try { const out = execFileSync('node', [H], { cwd: ROOT, timeout: 120000 }).toString(); say(/ALL OK/.test(out), 'real-USDC story: ' + out.trim().split('\n').pop().slice(0, 140)); }
  catch (e) { say(false, 'real-USDC story failed: ' + String(e.stdout || e.message).trim().split('\n').pop().slice(0, 200)); }
  try { const out = execFileSync('node', [H, '--plant'], { cwd: ROOT, timeout: 120000 }).toString(); say(/refused by USDC \+ box/.test(out), 'planted stranger signature: ' + out.trim().split('\n').pop().slice(0, 140)); }
  catch (e) { say(false, 'planted stranger signature was NOT refused the right way: ' + String(e.stdout || e.message).trim().split('\n').pop().slice(0, 200)); }
  // 3. our Arc checkout's contract-payer path
  try {
    const fac = require(path.join(ROOT, 'arc-facilitator.js'));
    const to = fac.receiveAddress();
    const r = await fac.verify({ signature: '0x' + 'ab'.repeat(300), authorization: { from: S.box, to, value: '3000', validAfter: '0',
      validBefore: String(Math.floor(Date.now() / 1000) + 600), nonce: v.keccak256(v.toHex('nightly ' + Date.now())) } }, 0.003);
    say(r && r.valid === false && /the paying contract refused this payment/.test(r.reason || ''), 'checkout contract-payer path: ' + (r && r.reason || JSON.stringify(r)).slice(0, 120));
  } catch (e) { say(false, 'checkout verify threw: ' + (e.message || e)); }
  // the demo box itself (informational: a box that ran dry is not a failure)
  try {
    const bal = await pub.readContract({ address: S.box, abi: v.parseAbi(['function balance() view returns (uint256)']), functionName: 'balance' });
    console.log('note demo box ' + S.box + ' holds ' + Number(bal) / 1e6 + ' USDC');
  } catch (e) { console.log('note demo box balance unreadable: ' + (e.shortMessage || e.message)); }
  console.log(fails ? fails + ' FAILED' : 'arc-mandate: all ok');
  process.exit(fails ? 1 : 0);
})();
