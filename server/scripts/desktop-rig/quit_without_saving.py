from common import *
import subprocess, os
def launch(w): subprocess.run([f'{R}/launch.sh',w,'pcbnew',f'{R}/{w}/pic_programmer/pic_programmer.kicad_pcb']); time.sleep(1)
def up(w): return wait(lambda: 'COLLAB merge' in open(f'{R}/{w}-pcbnew.log').read() and len(board(w,5000).get_tracks())>0, 90)
check('both editors join', bool(up('a')) and bool(up('b')))
A=board('a'); B=board('b'); n0=len(A.get_tracks())
net=[n for n in B.get_nets() if n.name=='GND'][0]
t=bt.Track(); t.start=Vector2.from_xy_mm(150,160); t.end=Vector2.from_xy_mm(160,160); t.width=300000; t.layer=bt.BoardLayer.BL_F_Cu; t.net=net
tid=str(B.create_items(t)[0].id.value)
victim=B.get_tracks()[5]; vid=str(victim.id.value); B.remove_items([victim])
has=lambda b,i: any(str(x.id.value)==i for x in b.get_tracks())
check('A receives a track added and a track deleted by B', bool(wait(lambda: has(A,tid) and not has(A,vid))))
subprocess.run(['pkill','-f',f'pcbnew {R}/a/']); time.sleep(2)   # A quits without saving
launch('a'); check('A reopens its unsaved copy and rejoins', bool(up('a')))
A=board('a'); time.sleep(3)
print(open(f'{R}/a-pcbnew.log').read().strip().split('\n')[-1])
check('A is brought up to date again', bool(wait(lambda: has(A,tid) and not has(A,vid))))
check('…and B keeps its work (nothing was pushed back)', has(B,tid) and not has(B,vid) and len(B.get_tracks())==n0, f'{len(B.get_tracks())} tracks, was {n0}')
log=open(f'{R}/a-pcbnew.log').read()
check('the rejoin merge kept no phantom local edits', ', 0 kept' in log.strip().split('\n')[-1], log.strip().split('\n')[-1])
import sys; sys.exit(0 if all(results) else 1)
