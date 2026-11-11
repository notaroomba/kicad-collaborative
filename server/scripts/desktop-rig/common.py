import time, hashlib
from kipy import KiCad
import kipy.board_types as bt
from kipy.geometry import Vector2
R='/tmp/claude-0/rig'
def board(who, timeout=60000):
    k=KiCad(socket_path=f'ipc://{R}/api-{who}-pcbnew.sock', timeout_ms=timeout); return k.get_board()
def fill_sig(z):
    h=hashlib.sha1(); n=0
    for layer,polys in sorted(z.filled_polygons.items()):
        for p in polys:
            for node in p.outline.nodes:
                if node.has_point: h.update(f'{layer}:{node.point.x},{node.point.y};'.encode()); n+=1
    return n, h.hexdigest()[:10]
def zones(b): return {str(z.id.value): z for z in b.get_zones()}
def wait(pred, secs=20, what=''):
    t=time.time()
    while time.time()-t<secs:
        try:
            v=pred()
            if v: return v
        except Exception as e: last=e
        time.sleep(0.5)
    return None
results=[]
def check(name, ok, detail=''):
    results.append(ok); print(('PASS  ' if ok else 'FAIL  ')+name+(f' — {detail}' if detail else ''), flush=True)
from kipy.proto.common.types import KiCadObjectType
def groups(b): return list(b.get_items(types=[KiCadObjectType.KOT_PCB_GROUP]))
def track_sig(b):
    h=hashlib.sha1(); ts=b.get_tracks()
    for s in sorted(f'{t.start.x},{t.start.y},{getattr(t,"end",t.start).x},{getattr(t,"end",t.start).y},{t.layer}' for t in ts): h.update(s.encode())
    return len(ts), h.hexdigest()[:10]
