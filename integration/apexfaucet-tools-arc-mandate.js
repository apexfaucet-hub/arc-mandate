#!/usr/bin/env node
'use strict';
// ARC MANDATE, OUR OWN DEMO (2026-10-08). Puts the Mandate contracts (github: apexfaucet-hub/arc-mandate, local
// /home/claudeuser/hackathon/arc-mandate) on Arc mainnet and runs OUR OWN box with OUR OWN money: the operator wallet owns it,
// a dedicated agent key spends from it, and every payment goes to our own x402 receive wallet. Never a user's box or money.
//   node tools/arc-mandate.js keygen  [--live]   agent key keys/arc-mandate-agent.json + wallet registry entry, same run
//   node tools/arc-mandate.js deploy  [--live]   MandateFactory from the operator (no value moves; gas only)
//   node tools/arc-mandate.js create <usdc> [--live]   our demo box: owner operator, agent = mandate agent, 0.01 USDC per
//                                                payment, 20 a day, payee = our receive wallet, 30 days; funded in the same tx
//   node tools/arc-mandate.js agent-gas <usdc> [--live]  operator -> agent wallet, for the gas of the agent's pay() calls
// Rules kept: every address comes from a key file or data/arc-mandate.json written by this tool, and must equal the
// expected value below; each destination is read on chain before signing; value sends ask the send gate (sender
// "arc-hand-mandate", enforce) and are recorded by the EVM recorder; the operator keeps OPERATOR_KEEP USDC for its
// settlement gas. Without --live nothing is signed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const v = require('/root/apex-faucet/node_modules/viem');
const { privateKeyToAccount, generatePrivateKey } = require('/root/apex-faucet/node_modules/viem/accounts');
const H = require('/root/apex-faucet/lib/hand-gate.js');

const ROOT = '/root/apex-faucet';
const LIVE = process.argv.includes('--live');
const CMD = process.argv[2];
const ARG = Number(process.argv[3]);
const SENDER = 'arc-hand-mandate';
const USDC = '0x3600000000000000000000000000000000000000';
const OPERATOR_EXPECT = '0x024b82335c29fa5606a8ea5c1d24fc9ead50700c';
const RECEIVE_EXPECT = '0xd334ab5151c624cada654854e2879903dc4217ed';
const OPERATOR_KEEP = 0.5;
const STATE = path.join(ROOT, 'data', 'arc-mandate.json');
const ART = path.join(ROOT, 'data', 'arc-mandate', 'MandateFactory.json');
const AGENT_KEY = path.join(ROOT, 'keys', 'arc-mandate-agent.json');
const REG = path.join(ROOT, 'data', 'protected', 'account', 'wallet-registry.json');
const REG_EXTRA = path.join(ROOT, 'data', 'protected', 'account', 'registry-extra.json');
const arc = v.defineChain({ id: 5042, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } } });
const transport = v.fallback(['https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.mainnet.arc.io', 'https://rpc.beamrpc.com'].map((u) => v.http(u, { timeout: 20000 })), { rank: false });
const pub = v.createPublicClient({ chain: arc, transport });
const FACTORY_ABI = v.parseAbi([
  'function create(bytes32 salt, address agent, uint128 maxPerPayment, uint32 maxPaymentsPerDay, uint64 expiresAt, bool anyPayee, address[] payees) payable returns (address box)',
  'function predict(address owner, bytes32 salt) view returns (address)',
  'function implementation() view returns (address)',
  'function usdc() view returns (address)',
  'function isMandate(address) view returns (bool)',
]);
const BOX_ABI = v.parseAbi(['function owner() view returns (address)', 'function agent() view returns (address)', 'function balance() view returns (uint256)', 'function VERSION() view returns (string)']);

const die = (m, code) => { console.error(m); process.exit(code || 3); };
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };
const state = () => readJson(STATE, {});
const saveState = (s) => { fs.writeFileSync(STATE, JSON.stringify(s, null, 1) + '\n'); };
function operator() {
  const a = privateKeyToAccount(JSON.parse(fs.readFileSync(path.join(ROOT, 'keys', 'arc-operator.json'), 'utf8')).privateKey);
  if (a.address.toLowerCase() !== OPERATOR_EXPECT) die('operator key does not derive to the expected operator: refusing');
  return a;
}
function receiveAddr() {
  const f = JSON.parse(fs.readFileSync(path.join(ROOT, 'keys', 'arc-receive.json'), 'utf8'));
  const a = String(f.address || privateKeyToAccount(f.privateKey).address).toLowerCase();
  if (a !== RECEIVE_EXPECT) die('receive key does not derive to the expected receive wallet: refusing');
  return a;
}
function agentAddr() {
  const f = readJson(AGENT_KEY, null);
  if (!f) die('no agent key yet: run keygen first');
  const a = privateKeyToAccount(f.privateKey).address.toLowerCase();
  if (f.address && String(f.address).toLowerCase() !== a) die('agent key file address does not match its key: refusing');
  return a;
}
// Wallet registry: the account layer refuses its whole cycle over a key file it cannot explain (CLAUDE.md 5, 6 Oct).
function register(entry) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  for (const p of [REG, REG_EXTRA]) fs.copyFileSync(p, p + '.bak-' + stamp + '-mandate');
  const reg = JSON.parse(fs.readFileSync(REG, 'utf8'));
  const id = 'arc:' + entry.address.slice(0, 10);
  if (!reg.entries.some((e) => e.chain === 'arc' && String(e.address).toLowerCase() === entry.address.toLowerCase())) {
    reg.entries.push(Object.assign({ kind: 'wallet', spendable: false, strategy: null, key_file_name: null, active: true, notes: '' }, entry,
      { chain: 'arc', owner_class: 'project', declared_in: 'data/protected/account/registry-extra.json', id, added_at: new Date().toISOString() }));
    fs.writeFileSync(REG, JSON.stringify(reg, null, 1) + '\n');
  }
  const extra = JSON.parse(fs.readFileSync(REG_EXTRA, 'utf8'));
  if (!extra.entries.some((e) => String(e.address).toLowerCase() === entry.address.toLowerCase())) {
    extra.entries.push(Object.assign({ chain: 'arc', owner_class: 'project' }, entry));
    fs.writeFileSync(REG_EXTRA, JSON.stringify(extra, null, 1) + '\n');
  }
  console.log('registered ' + entry.address + ' (' + entry.label + ') in the wallet registry; backups *.bak-' + stamp + '-mandate');
}
async function balanceUsdc(a) { return Number(await pub.getBalance({ address: a })) / 1e18; }
async function wait(hash) {
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 180000 });
  if (rc.status !== 'success') die('transaction failed on chain: ' + hash, 5);
  return rc;
}

(async () => {
  if ((await pub.getChainId()) !== 5042) die('not Arc mainnet');
  if (CMD === 'keygen') {
    if (fs.existsSync(AGENT_KEY)) die('agent key already exists: ' + agentAddr(), 0);
    if (!LIVE) { console.log('dry: would create ' + AGENT_KEY + ' and register its address'); return; }
    const pk = generatePrivateKey();
    const a = privateKeyToAccount(pk).address;
    fs.writeFileSync(AGENT_KEY, JSON.stringify({ address: a, created: new Date().toISOString(), privateKey: pk,
      purpose: 'Arc Mandate demo agent: spends ONLY from our own MandateBox (owner = operator), inside its on-chain rules' }, null, 1) + '\n', { mode: 0o600 });
    const code = await pub.getBytecode({ address: a });
    register({ address: a, label: 'Arc Mandate demo agent (spends only from our own MandateBox)', role: 'other', spendable: true,
      key_file_name: 'keys/arc-mandate-agent.json', source: 'created ' + new Date().toISOString() + ' by tools/arc-mandate.js keygen; address copied from the key file',
      checked_on_chain: new Date().toISOString().slice(0, 10) + ': ' + (code && code !== '0x' ? 'HAS CODE' : 'no code (plain wallet)') + ', ' + (await balanceUsdc(a)) + ' USDC' });
    console.log('agent ' + a);
    return;
  }
  const op = operator();
  const wal = v.createWalletClient({ chain: arc, transport, account: op });
  const opBal = await balanceUsdc(op.address);
  console.log('operator ' + op.address + ' ' + opBal.toFixed(6) + ' USDC');
  if (CMD === 'deploy') {
    const s = state();
    if (s.factory) die('already deployed: ' + s.factory, 0);
    const art = readJson(ART, null);
    if (!art || !art.bytecode) die('missing ' + ART);
    const gas = await pub.estimateGas({ account: op.address, data: v.encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args: [USDC] }) });
    const price = await pub.getGasPrice();
    const cost = Number(gas * price) / 1e18;
    console.log('deploy gas ' + gas + ' at ' + price + ' wei = ~' + cost.toFixed(5) + ' USDC');
    if (opBal - cost * 1.5 < OPERATOR_KEEP) die('the operator would fall under its ' + OPERATOR_KEEP + ' USDC keep: refusing');
    if (!LIVE) return;
    const hash = await wal.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [USDC], gas: gas * 12n / 10n });
    console.log('deploy tx ' + hash);
    const rc = await wait(hash);
    const factory = rc.contractAddress.toLowerCase();
    const impl = (await pub.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'implementation' })).toLowerCase();
    const u = await pub.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'usdc' });
    if (u.toLowerCase() !== USDC) die('factory usdc() is not Arc USDC', 5);
    saveState({ factory, implementation: impl, deployBlock: Number(rc.blockNumber), deployTx: hash, deployer: op.address.toLowerCase(), sourceSha256: art.sourceSha256 || null });
    await H.record(hash, { source: SENDER, chain: 'arc', wallets: [op.address], expect: { usdc: 0 }, category: 'internal' });
    register({ address: factory, kind: 'contract', label: 'Arc Mandate factory (MandateFactory, no admin, no fee)', role: 'other', source: 'deployed by tools/arc-mandate.js, tx ' + hash });
    console.log('factory ' + factory + ' implementation ' + impl + ' block ' + rc.blockNumber);
    return;
  }
  if (CMD === 'create') {
    const s = state();
    if (!s.factory) die('deploy first');
    if (s.box) die('our demo box already exists: ' + s.box, 0);
    if (!(ARG > 0 && ARG <= 0.3)) die('fund amount must be above 0 and at most 0.3 USDC');
    const agent = agentAddr();
    const payee = receiveAddr();
    const factoryCode = await pub.getBytecode({ address: s.factory });
    if (!factoryCode || factoryCode === '0x') die('no code at the factory address: refusing');
    const salt = '0x' + crypto.createHash('sha256').update('apexfaucet demo mandate 1').digest('hex');
    const box = (await pub.readContract({ address: s.factory, abi: FACTORY_ABI, functionName: 'predict', args: [op.address, salt] })).toLowerCase();
    if (opBal - ARG - 0.02 < OPERATOR_KEEP) die('the operator would fall under its ' + OPERATOR_KEEP + ' USDC keep: refusing');
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 30 * 86400);
    const args = [salt, agent, 10000n, 20, expiresAt, false, [payee]];
    const value = v.parseEther(String(ARG));
    await pub.simulateContract({ address: s.factory, abi: FACTORY_ABI, functionName: 'create', args, value, account: op.address });
    console.log('box will be ' + box + ': agent ' + agent + ', 0.01 USDC per payment, 20 a day, payee ' + payee + ', funded ' + ARG);
    const req = { source: SENDER, chain: 'arc', chainId: 5042, from: op.address, to: s.factory, usdc: ARG, purpose: 'create + fund our own demo MandateBox ' + box };
    if (!LIVE) return;
    H.mustAllow(req);
    let hash;
    try { hash = await wal.writeContract({ address: s.factory, abi: FACTORY_ABI, functionName: 'create', args, value }); }
    catch (e) { H.release(req, 'create not sent: ' + (e.shortMessage || e.message)); throw e; }
    console.log('create tx ' + hash);
    await wait(hash);
    const [owner, ag, bal] = await Promise.all([
      pub.readContract({ address: box, abi: BOX_ABI, functionName: 'owner' }), pub.readContract({ address: box, abi: BOX_ABI, functionName: 'agent' }),
      pub.readContract({ address: box, abi: BOX_ABI, functionName: 'balance' })]);
    if (owner.toLowerCase() !== op.address.toLowerCase() || ag.toLowerCase() !== agent) die('box read back wrong owner/agent', 5);
    s.box = box; s.boxTx = hash; s.boxSalt = salt; s.agent = agent; s.payee = payee; saveState(s);
    await H.record(hash, { source: SENDER, chain: 'arc', wallets: [op.address], expect: { usdc: ARG }, category: 'internal' });
    register({ address: box, kind: 'contract', label: 'Our demo MandateBox (owner operator, agent arc-mandate-agent)', role: 'other', source: 'created by tools/arc-mandate.js, tx ' + hash });
    console.log('box ' + box + ' holds ' + Number(bal) / 1e6 + ' USDC');
    return;
  }
  if (CMD === 'agent-gas') {
    if (!(ARG > 0 && ARG <= 0.05)) die('agent gas must be above 0 and at most 0.05 USDC');
    const agent = agentAddr();
    const code = await pub.getBytecode({ address: agent });
    if (code && code !== '0x') die('agent address has contract code: refusing');
    if (opBal - ARG - 0.01 < OPERATOR_KEEP) die('the operator would fall under its ' + OPERATOR_KEEP + ' USDC keep: refusing');
    const req = { source: SENDER, chain: 'arc', chainId: 5042, from: op.address, to: agent, usdc: ARG, purpose: 'gas for the Mandate demo agent pay() calls' };
    console.log('send ' + ARG + ' USDC operator -> agent ' + agent);
    if (!LIVE) return;
    H.mustAllow(req);
    let hash;
    try { hash = await wal.sendTransaction({ to: agent, value: v.parseEther(String(ARG)) }); }
    catch (e) { H.release(req, 'not sent: ' + (e.shortMessage || e.message)); throw e; }
    console.log('agent gas tx ' + hash);
    await wait(hash);
    await H.record(hash, { source: SENDER, chain: 'arc', wallets: [op.address], expect: { usdc: ARG }, category: 'internal' });
    return;
  }
  die('usage: keygen | deploy | create <usdc> | agent-gas <usdc>   [--live]', 2);
})().catch((e) => { console.error('FAILED: ' + (e.shortMessage || e.message)); process.exit(1); });
