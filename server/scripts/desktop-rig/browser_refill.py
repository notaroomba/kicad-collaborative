from common import *
import os, subprocess, json
for f in ('web-ready','web-go','web-result.json'):
    try: os.remove(f'{R}/{f}')
    except FileNotFoundError: pass
A=board('a')
p=subprocess.Popen(['node',f'{R}/drv/web.mjs'],stdout=open(f'{R}/web.log','w'),stderr=subprocess.STDOUT)
check('the browser editor opens the board', bool(wait(lambda: os.path.exists(f'{R}/web-ready'), 90)))
zid=[k for k in zones(A) if k.startswith('00000000')][0]
before=fill_sig(zones(A)[zid])
victim=[t for t in A.get_tracks() if t.layer==bt.BoardLayer.BL_B_Cu and t.net.name!='GND' and t.length()>5e6][0]
print('removing a', victim.length()/1e6, 'mm track on', victim.net.name)
A.remove_items([victim])
time.sleep(2)
check('the desktop has not refilled on its own', fill_sig(zones(A)[zid])==before)
open(f'{R}/web-go','w').write('1')
ok=wait(lambda: fill_sig(zones(A)[zid])!=before, 60)
check('Fill All Zones in the browser makes the desktop refill', bool(ok), f'{before} -> {fill_sig(zones(A)[zid])}')
p.wait(timeout=120)
r=json.load(open(f'{R}/web-result.json')) if os.path.exists(f'{R}/web-result.json') else None
check('the browser receives the new fill', bool(r) and r['before']!=r['after'], json.dumps(r))
print(open(f'{R}/web.log').read()[-600:])
