#!/bin/bash
# Stop only this task's Paperclip instance: the launcher PID tree + postgres on our data dir.
root=$(cat /tmp/accept-ag/pc-launch.pid)
tree() { echo $1; for c in $(pgrep -P $1); do tree $c; done; }
pids=$(tree $root)
pg=$(pgrep -f "/tmp/accept-ag/pc-home/instances/[^ ]*/db")  # SIGINT below = fast shutdown
echo "launcher tree: $(echo $pids | tr '\n' ' ') postgres: $pg"
for p in $pids; do tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null | cut -c1-120; echo; done
kill -TERM $pids 2>/dev/null; sleep 4
[ -n "$pg" ] && kill -INT $pg 2>/dev/null; sleep 3
echo "listeners left: $(ss -ltn | grep -cE ':(8560|54329|18560) ')"
echo "survivors: $(for p in $pids $pg; do [ -d /proc/$p ] && echo $p; done | tr '\n' ' ')"
