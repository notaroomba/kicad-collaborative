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
