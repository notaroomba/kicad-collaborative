"""Editor A loses its connection, keeps working, and merges when it is back.

Editor A reaches the server through cut_proxy.py (start that first); editor B talks to the
server directly and stays online throughout.  Run after setup.py:

    python3 cut_proxy.py &
    python3 offline.py                 # every scenario, in order
    python3 offline.py drop stall      # or only some

Scenarios:
    drop      the connection drops mid-session; both sides edit; A's queue goes out on return
    stall     the link goes quiet without closing; A notices by itself and reconnects
    snapshot  as drop, but the server no longer has the ops A missed: three-way merge
    start     A is opened with no connection at all and joins by itself when there is one
    discard   A edits offline and quits without saving: nothing of it reaches anyone
    saved     A edits offline, saves and quits; the next launch carries the edits online
"""
from common import *
import json, os, subprocess, sys, urllib.request

# kicad-python from PyPI does not know every item type this build puts inside a footprint;
# the ones it cannot unwrap are of no interest here and travel untouched in the message.
import kipy.board_types as _types
_unwrap = _types.unwrap
def _lenient(message):
    try:
        return _unwrap(message)
    except NotImplementedError:
        return None
_types.unwrap = _lenient

HERE = os.path.dirname(os.path.abspath(__file__))
NAME = os.environ.get('RIG_NAME', 'pic_programmer')
PROXY = 'http://127.0.0.1:8097'
CTL = 'http://127.0.0.1:8096'
SHOTS = f'{R}/shots'
os.makedirs(SHOTS, exist_ok=True)
rig = json.load(open(f'{R}/rig.json'))
DOC = [d['docId'] for d in rig['project']['docs'] if d['docType'] == 'kicad_pcb'][0]
PG = 'postgres://postgres:test@127.0.0.1:5432/collabtest'


def ctl(what):
    return urllib.request.urlopen(f'{CTL}/{what}').read().decode().strip()

def psql(q):
    return subprocess.check_output(['psql', PG, '-Atc', q]).decode().strip()

def log(w):
    return open(f'{R}/{w}-pcbnew.log', errors='replace').read()

def launch(w):
    env = dict(os.environ)
    if w == 'a':
        env['RIG_SERVER'] = PROXY
    subprocess.run([f'{HERE}/launch.sh', w, 'pcbnew', f'{R}/{w}/{NAME}/{NAME}.kicad_pcb'], env=env)
    time.sleep(1)

def kill(w):
    subprocess.run(['pkill', '-f', f'pcbnew {R}/{w}/'])
    wait(lambda: subprocess.run(['pgrep', '-f', f'pcbnew {R}/{w}/'], capture_output=True).returncode != 0, 20)
    time.sleep(1)

def api_up(w):
    return wait(lambda: len(board(w, 5000).get_tracks()) > 0, 120)

def joined(w, merges=1):
    return wait(lambda: log(w).count('COLLAB merge') >= merges, 120)

def shot(w, name):
    disp = ':91' if w == 'a' else ':92'
    subprocess.run(['import', '-window', 'root', f'{SHOTS}/{name}.png'], env=dict(os.environ, DISPLAY=disp))

def do(fn, secs=40):
    """Run an API call, retrying while the editor answers that it is busy."""
    t = time.time(); last = None
    while time.time() - t < secs:
        try:
            return fn()
        except Exception as e:
            last = e; time.sleep(0.4)
    raise last

def mm(v): return round(v / 1e6, 4)
def tid(t): return str(t.id.value)
def tracks(b): return {tid(t): t for t in do(b.get_tracks)}
def fps(b): return {str(f.id.value): f for f in do(b.get_footprints)}
def fp_sig(b): return sorted((k, f.position.x, f.position.y) for k, f in fps(b).items())

def add_track(b, x1, y1, x2, y2):
    net = [n for n in do(b.get_nets) if n.name == 'GND'][0]
    t = bt.Track(); t.start = Vector2.from_xy_mm(x1, y1); t.end = Vector2.from_xy_mm(x2, y2)
    t.width = 300000; t.layer = bt.BoardLayer.BL_F_Cu; t.net = net
    return do(lambda: b.create_items(t))[0]

def move_fp(b, key, dx, dy):
    f = fps(b)[key]
    f.position = Vector2.from_xy(f.position.x + int(dx * 1e6), f.position.y + int(dy * 1e6))
    do(lambda: b.update_items(f))
    return f.position.x, f.position.y

def same(A, B, secs=60):
    return wait(lambda: track_sig(A) == track_sig(B) and fp_sig(A) == fp_sig(B), secs)

def offline_marks(w): return log(w).count('COLLAB offline')


def prepare():
    """Point A's copy at the proxy and bring both editors up, joined."""
    link = f'{R}/a/{NAME}/{NAME}.collab/link.json'
    j = json.load(open(link)); j['server'] = PROXY; json.dump(j, open(link, 'w'))
    check('the proxy is up', ctl('up') == 'up')
    for w in 'ab':
        if subprocess.run(['pgrep', '-f', f'pcbnew {R}/{w}/'], capture_output=True).returncode != 0:
            launch(w)
    check('both editors are up and joined', bool(api_up('a')) and bool(api_up('b')) and bool(joined('a')) and bool(joined('b')))
    A = board('a'); B = board('b')
    check('they start out identical', bool(same(A, B, 30)), f'{track_sig(A)} / {track_sig(B)}')
    return A, B


def drop():
    print('\n== drop: the connection goes mid-session ==')
    A, B = prepare()
    fa = list(fps(A)); f_mine, f_shared, f_theirs = fa[0], fa[1], fa[2]
    ta = list(tracks(A)); t_gone, t_contested = ta[3], ta[7]
    marks = offline_marks('a')
    ctl('down')
    check('A notices the connection is gone', bool(wait(lambda: offline_marks('a') > marks, 20)))

    # A, offline
    t1 = add_track(A, 150, 165, 160, 165)
    for i in range(1, 13):          # twelve edits of one item: the last one must stand
        t1.end = Vector2.from_xy_mm(160 + i, 165)
        do(lambda: A.update_items(t1))
    many = [tid(add_track(A, 120 + i * 0.6, 170, 120 + i * 0.6, 172)) for i in range(80)]
    mine = move_fp(A, f_mine, 2, 0)
    do(lambda: A.remove_items([tracks(A)[t_gone]]))
    wide = tracks(A)[t_contested]; wide.width = 800000; do(lambda: A.update_items(wide))

    # B, online, meanwhile
    t2 = add_track(B, 150, 150, 160, 150)
    theirs = move_fp(B, f_theirs, 0, 3)
    move_fp(B, f_shared, 0, 5)                              # both move this one; A is later
    do(lambda: B.remove_items([tracks(B)[t_contested]]))    # B deletes what A widens
    time.sleep(2)
    shared = move_fp(A, f_shared, 3, 0)

    check('nothing of A has reached B while A is offline', tid(t1) not in tracks(B) and len(tracks(B)) < len(tracks(A)))
    check('nothing of B has reached A either', tid(t2) not in tracks(A))
    shot('a', 'drop-1-a-offline'); shot('b', 'drop-1-b-meanwhile')

    sent = log('a').count('COLLAB online')
    ctl('up')
    check('A reconnects and sends its queue', bool(wait(lambda: log('a').count('COLLAB online') > sent, 90)),
          log('a').strip().split('\n')[-1])
    check('both boards are identical again', bool(same(A, B)), f'A {track_sig(A)} B {track_sig(B)}')
    tb = tracks(B)
    check('B has the track A drew offline, as last edited', tid(t1) in tb and mm(tb[tid(t1)].end.x) == 172.0,
          tid(t1) in tb and f'end x {mm(tb[tid(t1)].end.x)}')
    check('B has all 80 tracks A added offline', all(k in tb for k in many))
    check('B has the footprint A moved', (fps(B)[f_mine].position.x, fps(B)[f_mine].position.y) == mine)
    check('the track A deleted is gone on B', t_gone not in tb)
    check('A has what B did meanwhile', tid(t2) in tracks(A) and (fps(A)[f_theirs].position.x, fps(A)[f_theirs].position.y) == theirs)
    check('the footprint both moved is where A, the later writer, put it',
          (fps(B)[f_shared].position.x, fps(B)[f_shared].position.y) == shared
          and (fps(A)[f_shared].position.x, fps(A)[f_shared].position.y) == shared)
    check('the track B deleted and A widened offline stays deleted on both', t_contested not in tracks(A) and t_contested not in tb)
    time.sleep(1); shot('a', 'drop-2-a-merged'); shot('b', 'drop-2-b-merged')


def stall():
    print('\n== stall: the link goes quiet without closing ==')
    A, B = prepare()
    marks = offline_marks('a')
    ctl('stall')
    t1 = add_track(A, 150, 175, 160, 175)       # A still believes it is live
    t2 = add_track(B, 150, 140, 160, 140)
    time.sleep(3)
    check('the edit went nowhere', tid(t1) not in tracks(B))
    check('A notices the silence by itself (within a minute)', bool(wait(lambda: offline_marks('a') > marks, 75)))
    t3 = add_track(A, 150, 176, 160, 176)       # and now knows it is offline
    ctl('up')
    check('both boards are identical again', bool(same(A, B, 90)), f'A {track_sig(A)} B {track_sig(B)}')
    tb = tracks(B)
    check('B has the edit made before A noticed and the one after', tid(t1) in tb and tid(t3) in tb)
    check('A has what B did meanwhile', tid(t2) in tracks(A))


def snapshot():
    print('\n== snapshot: the server no longer has the ops A missed ==')
    A, B = prepare()
    fa = list(fps(A)); f_online, f_offline = fa[3], fa[4]
    # An edit A makes while still online, and does not save.  B moves the same footprint
    # again while A is away: that is the newer change and must stand.
    move_fp(A, f_online, 1, 0)
    wait(lambda: fp_sig(A) == fp_sig(B), 20)
    marks = offline_marks('a')
    ctl('down')
    check('A notices the connection is gone', bool(wait(lambda: offline_marks('a') > marks, 20)))
    t1 = add_track(A, 150, 180, 160, 180)
    mine = move_fp(A, f_offline, 0, -2)
    t2 = add_track(B, 150, 135, 160, 135)
    theirs = move_fp(B, f_online, 0, 4)
    time.sleep(2)

    # The server keeps ops for a week; make that week pass: a snapshot of B's board at the
    # head, and no ops behind it.
    do(B.save)
    head = int(psql(f"SELECT COALESCE(MAX(seq),0) FROM ops WHERE doc_id='{DOC}'"))
    body = open(f'{R}/b/{NAME}/{NAME}.kicad_pcb', 'rb').read()
    r = urllib.request.Request(f'http://127.0.0.1:8099/api/docs/{DOC}/snapshots?seq={head}', data=body, method='POST',
                               headers={'Authorization': 'Bearer ' + rig['bob'], 'Content-Type': 'application/octet-stream'})
    urllib.request.urlopen(r).read()
    psql(f"DELETE FROM ops WHERE doc_id='{DOC}'")

    merges = log('a').count('COLLAB merge')
    ctl('up')
    check('A reconnects and merges against a snapshot', bool(wait(lambda: log('a').count('COLLAB merge') > merges, 90)))
    line = [l for l in log('a').split('\n') if 'COLLAB merge' in l][-1]
    print('   ', line)
    check('the merge kept exactly what A did offline (a track and a footprint)', ', 2 kept, 0 conflicts' in line, line)
    check('both boards are identical again', bool(same(A, B)), f'A {track_sig(A)} B {track_sig(B)}')
    check('B has what A did offline', tid(t1) in tracks(B) and (fps(B)[f_offline].position.x, fps(B)[f_offline].position.y) == mine)
    check('A has what B did meanwhile', tid(t2) in tracks(A))
    check("B's newer move of the footprint A had moved online stands on both",
          (fps(A)[f_online].position.x, fps(A)[f_online].position.y) == theirs
          and (fps(B)[f_online].position.x, fps(B)[f_online].position.y) == theirs)


def start():
    print('\n== start: A is opened with no connection ==')
    A, B = prepare()
    do(A.save); time.sleep(1)
    kill('a')
    ctl('down')
    launch('a')
    check('A opens without the server', bool(api_up('a')))
    A = board('a')
    time.sleep(3)
    check('A has not joined (there is nothing to join)', 'COLLAB merge' not in log('a'))
    shot('a', 'start-1-a-offline-banner')
    t1 = add_track(A, 150, 185, 160, 185)
    fa = list(fps(A)); mine = move_fp(A, fa[5], 1.5, 0)
    t2 = add_track(B, 150, 130, 160, 130)
    time.sleep(1); shot('a', 'start-2-a-edits-waiting')
    ctl('up')
    check('A joins by itself once the server is reachable', bool(joined('a')), log('a').strip().split('\n')[-1])
    check('both boards are identical', bool(same(A, B)), f'A {track_sig(A)} B {track_sig(B)}')
    check('B has what A did before it ever connected', tid(t1) in tracks(B)
          and (fps(B)[fa[5]].position.x, fps(B)[fa[5]].position.y) == mine)
    check('A has what B did meanwhile', tid(t2) in tracks(A))
    time.sleep(1); shot('a', 'start-3-a-joined')


def discard():
    print('\n== discard: offline edits, then quit without saving ==')
    A, B = prepare()
    do(A.save); time.sleep(1)
    n0 = track_sig(B)
    marks = offline_marks('a')
    ctl('down')
    wait(lambda: offline_marks('a') > marks, 20)
    t1 = add_track(A, 150, 190, 160, 190)
    kill('a')                                   # no save
    ctl('up')
    launch('a')
    check('A reopens and rejoins', bool(api_up('a')) and bool(joined('a')))
    A = board('a'); time.sleep(3)
    line = [l for l in log('a').split('\n') if 'COLLAB merge' in l][-1]
    check('the rejoin pushed nothing', ', 0 kept' in line, line)
    check('the discarded track exists nowhere', tid(t1) not in tracks(A) and tid(t1) not in tracks(B))
    check('B is exactly as it was', track_sig(B) == n0 and bool(same(A, B, 20)))


def saved():
    print('\n== saved: offline edits, saved, editor closed, reopened online ==')
    A, B = prepare()
    marks = offline_marks('a')
    ctl('down')
    wait(lambda: offline_marks('a') > marks, 20)
    t1 = add_track(A, 150, 195, 160, 195)
    do(A.save); time.sleep(1)
    kill('a')
    t2 = add_track(B, 150, 125, 160, 125)
    ctl('up')
    launch('a')
    check('A reopens and rejoins', bool(api_up('a')) and bool(joined('a')))
    A = board('a')
    line = [l for l in log('a').split('\n') if 'COLLAB merge' in l][-1]
    check('the merge kept the saved offline edit', ', 1 kept' in line, line)
    check('B has the track A drew and saved offline', bool(wait(lambda: tid(t1) in tracks(B), 30)))
    check('A has what B did meanwhile', bool(wait(lambda: tid(t2) in tracks(A), 30)))
    check('both boards are identical', bool(same(A, B)), f'A {track_sig(A)} B {track_sig(B)}')


ALL = {'drop': drop, 'stall': stall, 'snapshot': snapshot, 'start': start, 'discard': discard, 'saved': saved}
for name in (sys.argv[1:] or list(ALL)):
    try:
        ALL[name]()
    except Exception as e:
        import traceback; traceback.print_exc()
        check(f'{name} ran to the end', False, repr(e))
    finally:
        try: ctl('up')
        except Exception: pass
print(f'\n{sum(results)} of {len(results)} checks passed')
sys.exit(0 if all(results) else 1)
