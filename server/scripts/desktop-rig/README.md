# Two real desktop editors, driven without a screen

These scripts run two KiCad Collaborative editors as two users against a local server,
each on its own virtual display, and drive them through KiCad's IPC API (`kicad-python`).
They are how zone fills, groups and the offline merge were checked end to end on Linux.

Needs: a build tree with `pcbnew` (run from the build directory), `Xvfb`, `openbox`,
`xdotool`, ImageMagick's `import`, `pip install kicad-python`, the server on
`127.0.0.1:8099` started with `KC_DEV_LOGIN=1 JWT_SECRET=testsecret`, and Postgres.
Paths at the top of `setup.py`, `launch.sh` and `common.py` point at the rig folder and
the build tree; change them to yours.  Each profile has to get through the first-run
wizard once before `setup.py` copies it.

    python3 setup.py                         # project on the server, two linked local copies
    ./launch.sh a pcbnew <rig>/a/pic_programmer/pic_programmer.kicad_pcb
    ./launch.sh b pcbnew <rig>/b/pic_programmer/pic_programmer.kicad_pcb
    python3 tracks_and_refill.py             # then groups.py, zone_lifecycle.py
    python3 quit_without_saving.py           # kills and relaunches editor A itself
    python3 browser_refill.py                # close editor B first; drives web.mjs

`groups.py` has two checks that describe the API rather than the sync (a group cannot be
given a member created in the same uncommitted call, and its zone sits off the board);
both sides still agree, which is what the last checks assert.

Tuning patterns have no API, so `retune.sh <display> <pattern y> <spacing>` clicks one and
changes its spacing through the properties dialog.  Set the project up from a board that
has patterns (`RIG_SRC=<folder holding qa/data/pcbnew/issue22536> RIG_NAME=issue22536
python3 setup.py`), retune from each side in turn (`./retune.sh :91 440 0.8`,
`./retune.sh :92 505 1.0`) and compare `track_sig()` from `common.py` on both editors.

## Working offline

`cut_proxy.py` is a TCP proxy in front of the server whose cable can be pulled: `down`
closes and refuses connections, `stall` keeps them open but carries nothing (the editor has
to notice the silence by itself), `up` restores it.  `offline.py` puts editor A behind it
(B stays on the server itself) and runs six scenarios, each ending with both boards compared
track by track and footprint by footprint:

    python3 cut_proxy.py &                   # 8097 -> 8099, control on 8096
    python3 setup.py
    python3 offline.py                       # or: offline.py drop stall snapshot start discard saved

- `drop`: the connection goes mid-session; A adds 81 tracks, edits one of them twelve
  times, moves footprints and deletes a track while B works too, including on the same
  items; on return A's queue goes out in order and both boards agree.
- `stall`: the link goes quiet without closing; A reconnects after 45 s of silence.
- `snapshot`: the server no longer has the ops A missed, so A merges against a snapshot
  (three-way, the base being the board as it was when the connection dropped).
- `start`: A is opened with no server in reach, edits, and joins by itself later.
- `discard`: offline edits, quit without saving: nothing of them reaches anyone.
- `saved`: offline edits, saved, editor closed; the next launch carries them online.

`launch.sh` takes the server from `RIG_SERVER` (default the server itself); `offline.py`
sets it for A and rewrites A's `link.json` to match.  Screenshots land in `<rig>/shots`.


`sch_offline.py` does the same for the schematic editor (`drop` and `snapshot`).  There is
no scripting API for the schematic, so it draws wires with the mouse in the margin below
the drawing frame and reads the result from the saved files; it has room for 30 wires, then
wants fresh copies from `setup.py`.

When a three-way merge keeps more than you expect, launch the editor with
`RIG_ENV=KICAD_COLLAB_MERGE_TRACE=1` (launch.sh passes `RIG_ENV` into the editor's
environment): each item the merge treats as edited here is printed with the text where it
departs from the base.  That is how footprint reference points written in the wrong frame
at older file format versions were found.
