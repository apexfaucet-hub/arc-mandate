#!/usr/bin/env python3
# Adds sender "arc-hand-mandate" to /etc/apex/send-gate.json (backup first). Usage: sudo python3 add-send-gate-sender.py <factory> <agent>
import json, sys, shutil, time, re
P = '/etc/apex/send-gate.json'
factory, agent = (a.lower() for a in sys.argv[1:3])
for a in (factory, agent):
    if not re.fullmatch(r'0x[0-9a-f]{40}', a): sys.exit('bad address ' + a)
shutil.copy2(P, P + '.bak-' + time.strftime('%Y%m%d-%H%M%S') + '-mandate')
p = json.load(open(P))
if 'arc-hand-mandate' in p['senders']: sys.exit('sender exists already')
p['senders']['arc-hand-mandate'] = {
  'mode': 'enforce',
  'wallets': ['0x024b82335c29fa5606a8ea5c1d24fc9ead50700c'],
  'destinations': {
    factory: 'Arc Mandate factory (data/arc-mandate.json; MandateFactory, no admin, no fee): create + fund OUR OWN demo box',
    agent: 'Arc Mandate demo agent (keys/arc-mandate-agent.json): gas for its pay() calls',
  },
  'per_tx_usdc': 0.3,
  'per_day_usdc': 0.5,
  'note': 'tools/arc-mandate.js (2026-10-08): our own Mandate demo, our own money; owner = operator, payee = our receive wallet. The tool itself caps create at 0.3 and agent gas at 0.05 and keeps 0.5 USDC in the operator.',
}
p['version'] = time.strftime('%Y-%m-%d') + '.mandate'
open(P, 'w').write(json.dumps(p, indent=1, ensure_ascii=False) + '\n')
print('added arc-hand-mandate; backup written')
