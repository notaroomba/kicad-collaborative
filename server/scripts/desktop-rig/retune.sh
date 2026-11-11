#!/bin/bash
# retune.sh <display> <pattern y> <spacing>: open a tuning pattern's properties and change its spacing
export DISPLAY=$1
xdotool key Escape; xdotool mousemove 830 $2 click 1; sleep 1; xdotool key e; sleep 2.5
read X Y < <(xdotool search --name "Tuning Pattern Properties" | head -1 | xargs -I{} xdotool getwindowgeometry {} | awk '/Position/{split($2,a,","); print a[1], a[2]}')
xdotool mousemove $((X+503)) $((Y+176)) click --repeat 3 1; xdotool type "$3"; sleep 0.3
xdotool mousemove $((X+881)) $((Y+290)) click 1; sleep 6
