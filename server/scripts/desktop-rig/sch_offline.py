"""The schematic editor loses its connection, keeps working, and merges when it is back.

Like offline.py, for eeschema.  There is no scripting API for the schematic, so the edits
are wires drawn with the mouse (xdotool) and the result is read from the saved files.
Editor A reaches the server through cut_proxy.py; editor B stays online.

    python3 cut_proxy.py &
    python3 sch_offline.py             # drop, then snapshot
"""
import json, os, re, subprocess, sys, time, urllib.request

R = '/tmp/claude-0/rig'
HERE = os.path.dirname(os.path.abspath(__file__))
NAME = 'pic_programmer'
PROXY = 'http://127.0.0.1:8097'
DISP = {'a': ':91', 'b': ':92'}
rig = json.load(open(f'{R}/rig.json'))
results = []


def check(name, ok, detail=''):
    results.append(ok)
    print(('PASS  ' if ok else 'FAIL  ') + name + (f' — {detail}' if detail else ''), flush=True)

def wait(pred, secs=20):
    t = time.time()
    while time.time() - t < secs:
        v = pred()
        if v:
            return v
        time.sleep(0.5)
    return None

def ctl(what): return urllib.request.urlopen(f'http://127.0.0.1:8096/{what}').read().decode().strip()
def psql(q): return subprocess.run(['psql', 'postgres://postgres:test@127.0.0.1:5432/collabtest', '-Atc', q], capture_output=True, text=True).stdout.strip()
def log(w): return open(f'{R}/{w}-eeschema.log', errors='replace').read()
def xdo(w, *args): subprocess.run(['xdotool', *map(str, args)], env=dict(os.environ, DISPLAY=DISP[w]))
def shot(w, name): subprocess.run(['import', '-window', 'root', f'{R}/shots/{name}.png'], env=dict(os.environ, DISPLAY=DISP[w]))
def sch(w): return f'{R}/{w}/{NAME}/{NAME}.kicad_sch'

def launch(w):
    env = dict(os.environ)
    if w == 'a':
        env['RIG_SERVER'] = PROXY
    subprocess.run([f'{HERE}/launch.sh', w, 'eeschema', sch(w)], env=env)

def draw_wire(w, slot):
    """A short horizontal wire in the margin below the drawing frame, where nothing else is
    (the margin above it is under the "no connection" banner).

    Each wire gets a place of its own: one drawn over another would merge with it.  There
    are 30 places; after that, start again from fresh copies (setup.py).
    """
    slot %= 30
    x1, y = 430 + 70 * (slot % 15), 903 + 14 * (slot // 15)
    xdo(w, 'mousemove', x1, y, 'click', 1); time.sleep(0.4)
    xdo(w, 'key', 'Escape'); time.sleep(0.2)
    xdo(w, 'key', 'w'); time.sleep(0.4)
    for x in range(x1, x1 + 51, 10):
        xdo(w, 'mousemove', x, y); time.sleep(0.05)
    xdo(w, 'click', '--repeat', 2, '--delay', 120, 1); time.sleep(0.4)
    xdo(w, 'key', 'Escape'); time.sleep(0.3)

def save(w):
    xdo(w, 'mousemove', 1552, 500, 'click', 1); time.sleep(0.2)
    xdo(w, 'key', 'Escape', 'key', 'ctrl+s'); time.sleep(2.5)

def wires(w):
    text = open(sch(w), errors='replace').read()
    return set(re.findall(r'\(wire\b.*?\(uuid "?([0-9a-f-]{36})"?\)', text, re.S))

def saved_wires():
    save('a'); save('b')
    return wires('a'), wires('b')

def prepare():
    check('the proxy is up', ctl('up') == 'up')
    for w in 'ab':
        if subprocess.run(['pgrep', '-f', f'eeschema {R}/{w}/'], capture_output=True).returncode != 0:
            launch(w)
            time.sleep(25)
    a, b = saved_wires()
    check('both schematics start out with the same wires', a == b, f'{len(a)} / {len(b)}')
    global slot
    try:
        slot = int(open(f'{R}/sch-slot').read())
    except Exception:
        slot = 0
    open(f'{R}/sch-slot', 'w').write(str(slot + 3))     # no scenario draws more than three
    return a


def drop():
    print('\n== drop: the connection goes mid-session ==')
    before = prepare()
    marks = log('a').count('COLLAB offline')
    ctl('down')
    check('A notices the connection is gone', bool(wait(lambda: log('a').count('COLLAB offline') > marks, 20)))
    draw_wire('a', slot)
    draw_wire('a', slot + 1)
    draw_wire('b', slot + 2)
    time.sleep(2)
    shot('a', 'sch-drop-1-a-offline'); shot('b', 'sch-drop-1-b-meanwhile')
    a, b = saved_wires()
    check('A drew two wires offline', len(a - before) == 2, f'{len(a - before)}')
    check('B drew one wire meanwhile', len(b - before) == 1, f'{len(b - before)}')
    check('neither has the other\'s wires yet', not (a - before) & (b - before))
    sent = log('a').count('COLLAB online')
    ctl('up')
    check('A reconnects and sends its queue', bool(wait(lambda: log('a').count('COLLAB online') > sent, 90)),
          log('a').strip().split('\n')[-1])
    time.sleep(3)
    shot('a', 'sch-drop-2-a-merged'); shot('b', 'sch-drop-2-b-merged')
    a2, b2 = saved_wires()
    check('both schematics have all three new wires', a2 == b2 and len(a2 - before) == 3, f'{len(a2 - before)} / {len(b2 - before)}')


def snapshot():
    print('\n== snapshot: the server no longer has the ops A missed ==')
    before = prepare()
    doc = psql(f"SELECT d.id FROM documents d WHERE d.path='{NAME}.kicad_sch' AND d.project_id='{json.load(open(f'{R}/a/{NAME}/{NAME}.collab/link.json'))['projectId']}'")
    marks = log('a').count('COLLAB offline')
    ctl('down')
    check('A notices the connection is gone', bool(wait(lambda: log('a').count('COLLAB offline') > marks, 20)))
    draw_wire('a', slot)
    draw_wire('b', slot + 1)
    time.sleep(2)
    save('b')
    head = int(psql(f"SELECT COALESCE(MAX(seq),0) FROM ops WHERE doc_id='{doc}'"))
    r = urllib.request.Request(f'http://127.0.0.1:8099/api/docs/{doc}/snapshots?seq={head}', data=open(sch('b'), 'rb').read(), method='POST',
                               headers={'Authorization': 'Bearer ' + rig['bob'], 'Content-Type': 'application/octet-stream'})
    urllib.request.urlopen(r).read()
    psql(f"DELETE FROM ops WHERE doc_id='{doc}'")
    ctl('up')

    def converged():
        a, b = saved_wires()
        return a == b and len(a - before) == 2
    check('after the three-way merge both schematics have both new wires', bool(wait(converged, 90)),
          f'{len(wires("a") - before)} / {len(wires("b") - before)}')
    shot('a', 'sch-snapshot-a-merged')


ALL = {'drop': drop, 'snapshot': snapshot}
for name in (sys.argv[1:] or list(ALL)):
    try:
        ALL[name]()
    except Exception as e:
        check(f'{name} ran to the end', False, repr(e))
print(f'\n{sum(results)} of {len(results)} checks passed')
sys.exit(0 if all(results) else 1)
