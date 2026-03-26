#!/bin/bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 /path/to/wezterm-fork" >&2
  exit 1
fi

TARGET="$1"
PATCH_DIR="$(cd "$(dirname "$0")/.." && pwd)/patches/wezterm"

if [ ! -d "$TARGET/.git" ]; then
  echo "target is not a git repository: $TARGET" >&2
  exit 1
fi

git -C "$TARGET" apply "$PATCH_DIR/0001-attach-existing-domain-without-empty-window.patch"
echo "Applied WezTerm patch to: $TARGET"
