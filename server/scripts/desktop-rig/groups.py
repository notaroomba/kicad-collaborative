from common import *
from kipy.geometry import PolygonWithHoles, PolyLine, PolyLineNode
A=board('a'); B=board('b')
def mkgroup(name, members, base=None):
    g=base or bt.Group(); g.proto.name=name; del g.proto.items[:]
    for m in members: g.proto.items.add().value=m.value
    return g
mem=lambda g: sorted(str(i.value) for i in g.proto.items)
ids=lambda items: sorted(str(i.id.value) for i in items)
# --- groups: made on A from two existing tracks, seen on B with the same members
used={str(i.value) for g in groups(A) for i in g.proto.items}
tr=[t for t in A.get_tracks() if str(t.id.value) not in used][:3]
g=mkgroup('rig-group',[t.id for t in tr[:2]])
made=A.create_items(g)[0]; gid=str(made.id.value)
gb=wait(lambda: [x for x in groups(B) if str(x.id.value)==gid])
check('a group made on A appears on B', bool(gb))
check('…with the same members', bool(gb) and mem(gb[0])==sorted(str(t.id.value) for t in tr[:2]), gb and str(len(mem(gb[0]))))
# --- B regroups: adds a third member and renames
if gb:
    x=mkgroup('rig-group-2',[t.id for t in tr],gb[0])
    B.update_items(x)
    ga=wait(lambda: [y for y in groups(A) if str(y.id.value)==gid and len(mem(y))==3 and y.name=='rig-group-2'])
    check('a member added and a rename on B reach A', bool(ga))
# --- a group created together with a brand new member in one commit
net=[n for n in A.get_nets() if n.name=='GND'][0]
c=A.begin_commit()
t=bt.Track(); t.start=Vector2.from_xy_mm(150,165); t.end=Vector2.from_xy_mm(160,165); t.width=300000; t.layer=bt.BoardLayer.BL_F_Cu; t.net=net
nt=A.create_items(t)[0]
g2=mkgroup('rig-new-member',[nt.id, tr[2].id])
ng=A.create_items(g2)[0]
A.push_commit(c,'group with new member')
gb2=wait(lambda: [x for x in groups(B) if str(x.id.value)==str(ng.id.value)])
check('a group arriving with its new member keeps it', bool(gb2) and mem(gb2[0])==mem([x for x in groups(A) if str(x.id.value)==str(ng.id.value)][0]) and str(nt.id.value) in mem(gb2[0]), gb2 and str(mem(gb2[0])))
# --- nested group
g3=mkgroup('rig-outer',[ng.id])
og=A.create_items(g3)[0]
gb3=wait(lambda: [x for x in groups(B) if str(x.id.value)==str(og.id.value) and len(mem(x))==1])
check('a group of a group reaches B', bool(gb3))
# --- remove group on B (members stay)
B.remove_items(gb3) if gb3 else None
gone=wait(lambda: not [x for x in groups(A) if str(x.id.value)==str(og.id.value)])
still=[x for x in groups(A) if str(x.id.value)==str(ng.id.value)]
check('ungrouping on B removes the group on A and keeps what was in it', bool(gone) and bool(still))
# --- a new zone drawn on B, filled on B, arrives filled on A
z=bt.Zone(); z.type=bt.ZoneType.ZT_COPPER; z.layers=[bt.BoardLayer.BL_F_Cu]; z.net=net; z.name='rig-zone'
pl=PolyLine()
for (x,y) in [(120,150),(175,150),(175,172),(120,172)]: pl.append(PolyLineNode.from_xy(int(x*1e6),int(y*1e6)))
pl.closed=True
pw=PolygonWithHoles(); pw.outline=pl; z.outline=pw
nz=B.create_items(z)[0]; zid=str(nz.id.value)
za=wait(lambda: zid in zones(A))
check('a zone drawn on B appears on A', bool(za))
B.refill_zones()
ok=wait(lambda: fill_sig(zones(B)[zid])[0]>0 and fill_sig(zones(A)[zid])==fill_sig(zones(B)[zid]), 60)
check('B fills it and A shows identical copper', bool(ok), f'A {fill_sig(zones(A).get(zid)) if zid in zones(A) else None} B {fill_sig(zones(B)[zid])}')
# every zone agrees
ok=wait(lambda: {k:fill_sig(v) for k,v in zones(A).items()}=={k:fill_sig(v) for k,v in zones(B).items()}, 30)
check('all zones agree on both sides', bool(ok), str({k[:8]:fill_sig(v) for k,v in zones(A).items()}))
check('both boards hold the same number of items', wait(lambda: len(A.get_tracks())==len(B.get_tracks()) and len(groups(A))==len(groups(B))) is not None, f'{len(A.get_tracks())}/{len(B.get_tracks())} tracks, {len(groups(A))}/{len(groups(B))} groups')
import sys; sys.exit(0 if all(results) else 1)
