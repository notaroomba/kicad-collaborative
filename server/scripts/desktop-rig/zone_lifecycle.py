from common import *
from kipy.geometry import PolygonWithHoles, PolyLine, PolyLineNode
A=board('a'); B=board('b')
net=[n for n in A.get_nets() if n.name=='GND'][0]
def mkzone(pts,name):
    z=bt.Zone(); z.type=bt.ZoneType.ZT_COPPER; z.layers=[bt.BoardLayer.BL_F_Cu]; z.net=net; z.name=name
    pl=PolyLine()
    for (x,y) in pts: pl.append(PolyLineNode.from_xy(int(x*1e6),int(y*1e6)))
    pl.closed=True; pw=PolygonWithHoles(); pw.outline=pl; z.outline=pw; return z
nz=B.create_items(mkzone([(150,95),(200,95),(200,125),(150,125)],'rig-zone-2'))[0]; zid=str(nz.id.value)
check('a zone drawn on B appears on A', bool(wait(lambda: zid in zones(A))))
B.refill_zones()
ok=wait(lambda: fill_sig(zones(B)[zid])[0]>0 and fill_sig(zones(A)[zid])==fill_sig(zones(B)[zid]), 60)
check('B fills it and A shows identical copper', bool(ok), f'A {fill_sig(zones(A)[zid])} B {fill_sig(zones(B)[zid])}')
before=fill_sig(zones(A)[zid])
# A changes the outline; B's copy takes the new outline
za=zones(A)[zid]; nodes=za.outline.outline.nodes
za.proto.outline.polygons[0].outline.nodes[1].point.x_nm = int(190e6)
A.update_items(za)
got=wait(lambda: any(n.point.x==int(190e6) for n in zones(B)[zid].outline.outline.nodes))
check('an outline edit on A reaches B', bool(got))
# A refills; both agree and the copper changed
A.refill_zones()
ok=wait(lambda: fill_sig(zones(A)[zid])!=before and fill_sig(zones(A)[zid])==fill_sig(zones(B)[zid]), 60)
check('A refills the edited zone and B shows the new copper', bool(ok), f'before {before} A {fill_sig(zones(A)[zid])} B {fill_sig(zones(B)[zid])}')
# B deletes the zone
B.remove_items([zones(B)[zid]])
check('deleting the zone on B removes it on A', bool(wait(lambda: zid not in zones(A))))
A.refill_zones()
ok=wait(lambda: {k:fill_sig(v) for k,v in zones(A).items()}=={k:fill_sig(v) for k,v in zones(B).items()}, 60)
check('all zones agree on both sides at the end', bool(ok), str({k[:8]:fill_sig(v) for k,v in zones(A).items()}))
import sys; sys.exit(0 if all(results) else 1)
