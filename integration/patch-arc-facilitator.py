#!/usr/bin/env python3
# Contract payers (EIP-1271) on our Arc x402 rail: verify by simulating USDC's own check, settle with the bytes overload.
import sys
p = '/root/apex-faucet/arc-facilitator.js'
s = open(p).read()
n = 0
def rep(old, new):
    global s, n
    if old not in s:
        sys.exit('anchor not found: ' + old[:80])
    s = s.replace(old, new, 1); n += 1

rep("""  'function authorizationState(address authorizer,bytes32 nonce) view returns (bool)',
]);""", """  'function authorizationState(address authorizer,bytes32 nonce) view returns (bool)',
]);
// The bytes overload (FiatToken v2.2): Arc's USDC checks a CONTRACT payer's signature with EIP-1271 (verified on chain
// 2026-10-08: a contract answering 0x1626ba7e passes, one answering 0xffffffff reverts "FiatTokenV2: invalid signature").
const abiBytes = parseAbi(['function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature)']);
const PLAIN_SIG = /^0x[0-9a-fA-F]{130}$/;
const CONTRACT_SIG = /^0x(?:[0-9a-fA-F]{2}){66,2048}$/;""")

rep("""  const message = { from, to: getAddress(a.to), value, validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce };
  let ok; try { ok = await verifyTypedData({ address: from, domain: DOMAIN, types: TYPES, primaryType: 'TransferWithAuthorization', message, signature: sig }); }
  catch (e) { return { valid: false, reason: 'signature check failed: ' + String(e.shortMessage || e.message).slice(0, 60) }; }
  if (!ok) return { valid: false, reason: 'signature does not match from' };""", """  const message = { from, to: getAddress(a.to), value, validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce };
  if (PLAIN_SIG.test(String(sig))) {
    let ok; try { ok = await verifyTypedData({ address: from, domain: DOMAIN, types: TYPES, primaryType: 'TransferWithAuthorization', message, signature: sig }); }
    catch (e) { return { valid: false, reason: 'signature check failed: ' + String(e.shortMessage || e.message).slice(0, 60) }; }
    if (!ok) return { valid: false, reason: 'signature does not match from' };
  } else {
    // A CONTRACT PAYER (2026-10-08): an Arc Mandate box or another smart wallet signs with EIP-1271, which viem's
    // verifyTypedData (ECDSA recovery) cannot check. The only real proof is USDC's own check, so run the exact settlement
    // call as eth_call from the operator: it passes only if the payer contract approves this transfer, the nonce is fresh
    // and the balance is there. Nothing is served on this alone - settle() sends the same call and waits for the receipt.
    if (!CONTRACT_SIG.test(String(sig))) return { valid: false, reason: 'signature is neither 65 bytes nor a contract signature' };
    const acct = operator(); if (!acct) return { valid: false, reason: 'facilitator_unavailable' };
    try {
      await pub.simulateContract({ address: USDC, abi: abiBytes, functionName: 'transferWithAuthorization',
        args: [from, message.to, value, message.validAfter, message.validBefore, a.nonce, sig], account: acct.address });
    } catch (e) { return { valid: false, reason: 'the paying contract refused this payment: ' + String(e.shortMessage || e.message).slice(0, 90) }; }
  }""")

rep("""  const s = hexToSignature(payload.signature); const m = v.message;
  try {
    const hash = await wal.writeContract({ address: USDC, abi, functionName: 'transferWithAuthorization',
      args: [m.from, m.to, m.value, m.validAfter, m.validBefore, m.nonce, s.v ? Number(s.v) : (27 + s.yParity), s.r, s.s],
      gas: 150000n });""", """  const m = v.message;
  const plain = PLAIN_SIG.test(String(payload.signature));
  try {
    let hash;
    if (plain) {
      const s = hexToSignature(payload.signature);
      hash = await wal.writeContract({ address: USDC, abi, functionName: 'transferWithAuthorization',
        args: [m.from, m.to, m.value, m.validAfter, m.validBefore, m.nonce, s.v ? Number(s.v) : (27 + s.yParity), s.r, s.s],
        gas: 150000n });
    } else {
      // Contract payer: the bytes overload; the payer's isValidSignature runs inside, so allow more gas.
      hash = await wal.writeContract({ address: USDC, abi: abiBytes, functionName: 'transferWithAuthorization',
        args: [m.from, m.to, m.value, m.validAfter, m.validBefore, m.nonce, payload.signature], gas: 300000n });
    }""")
open(p, 'w').write(s)
print('patched', n, 'places')
