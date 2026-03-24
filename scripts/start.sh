#!/bin/bash
# claude2bot wrapper — auto-restart on flag
RESTART_FLAG="${TMPDIR:-/tmp}/claude2bot-restart"

while true; do
  claude --chrome --dangerously-load-development-channels plugin:claude2bot@claude2bot
  if [ ! -f "$RESTART_FLAG" ]; then
    echo "claude2bot: session ended normally."
    break
  fi
  reason=$(cat "$RESTART_FLAG" 2>/dev/null || echo "unknown")
  rm -f "$RESTART_FLAG"
  echo "claude2bot: restarting ($reason)..."
  sleep 2
done
