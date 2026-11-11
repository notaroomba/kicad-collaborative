#!/bin/bash
# launch.sh <a|b> <pcbnew|eeschema> <file>
who=$1; app=$2; file=$3; W=${who^^}
disp=$([ $who = a ] && echo :91 || echo :92)
pgrep -f "Xvfb $disp" >/dev/null || { (Xvfb $disp -screen 0 1600x1000x24 >/dev/null 2>&1 &); sleep 1; (DISPLAY=$disp openbox >/dev/null 2>&1 &); }
tok=$(python3 -c "import json;print(json.load(open('/tmp/claude-0/rig/rig.json'))['$([ $who = a ] && echo alice || echo bob)'])")
rm -f /tmp/claude-0/rig/api-$who-$app.sock /tmp/claude-0/rig/$who/*/*.lck /tmp/claude-0/rig/$who/*/~*.lck; cd /home/claude/build
DISPLAY=$disp KICAD_CONFIG_HOME=/tmp/claude-0/rig/cfg$W KICAD_RUN_FROM_BUILD_DIR=1 KICAD_LOG_TO_STDERR=1 \
 KICAD_COLLAB_SERVER=${RIG_SERVER:-http://127.0.0.1:8099} KICAD_COLLAB_TOKEN=$tok KICAD_API_SOCKET_PATH=/tmp/claude-0/rig/api-$who-$app.sock \
 nohup env $RIG_ENV ./$app/$app "$file" > /tmp/claude-0/rig/$who-$app.log 2>&1 &
