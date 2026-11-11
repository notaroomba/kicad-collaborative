from common import *
A=board('a'); B=board('b')
za=zones(A); zb=zones(B)
print('zones A', {k[:8]:fill_sig(z) for k,z in za.items()}); print('zones B', {k[:8]:fill_sig(z) for k,z in zb.items()})
# 1. a track added on A appears on B
n0=len(B.get_tracks())
net=[n for n in A.get_nets() if n.name=='GND'][0]
t=bt.Track(); t.start=Vector2.from_xy_mm(150,160); t.end=Vector2.from_xy_mm(160,160); t.width=300000; t.layer=bt.BoardLayer.BL_F_Cu; t.net=net
made=A.create_items(t)[0]
got=wait(lambda: [x for x in B.get_tracks() if str(x.id.value)==str(made.id.value)])
check('a track drawn on A appears on B', bool(got), got and f'net {got[0].net.name}')
# 2. refill on A; B gets the same copper
zid=list(za)[0]
A.refill_zones()
sigA=wait(lambda: fill_sig(zones(A)[zid]) if fill_sig(zones(A)[zid])[0] else None, 60)
same=wait(lambda: fill_sig(zones(B)[zid])==fill_sig(zones(A)[zid]), 30)
check('after a refill on A, B holds identical copper', bool(same), f'A {fill_sig(zones(A)[zid])} B {fill_sig(zones(B)[zid])}')
import sys; sys.exit(0 if all(results) else 1)
