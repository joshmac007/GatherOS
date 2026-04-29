#!/bin/bash
# Generates build/icon.icns from a 1024×1024 PNG.
#
# Usage:
#   ./scripts/make-icon.sh path/to/source.png
#
# Requires only the macOS-native sips + iconutil tools.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <path-to-1024x1024.png>" >&2
  exit 1
fi

SRC="$1"
if [ ! -f "$SRC" ]; then
  echo "Source image not found: $SRC" >&2
  exit 1
fi

# Verify the source is at least 1024×1024 — sips will silently upscale
# smaller images, which produces a blurry icon.
DIMS=$(sips -g pixelWidth -g pixelHeight "$SRC" | awk 'NR>1 {print $2}' | xargs)
WIDTH=$(echo "$DIMS" | cut -d' ' -f1)
HEIGHT=$(echo "$DIMS" | cut -d' ' -f2)
if [ "$WIDTH" -lt 1024 ] || [ "$HEIGHT" -lt 1024 ]; then
  echo "Source must be at least 1024×1024 (got ${WIDTH}×${HEIGHT})." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ICONSET="$(mktemp -d)/icon.iconset"
mkdir -p "$ICONSET"

sips -z 16   16   "$SRC" --out "$ICONSET/icon_16x16.png"      >/dev/null
sips -z 32   32   "$SRC" --out "$ICONSET/icon_16x16@2x.png"   >/dev/null
sips -z 32   32   "$SRC" --out "$ICONSET/icon_32x32.png"      >/dev/null
sips -z 64   64   "$SRC" --out "$ICONSET/icon_32x32@2x.png"   >/dev/null
sips -z 128  128  "$SRC" --out "$ICONSET/icon_128x128.png"    >/dev/null
sips -z 256  256  "$SRC" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -z 256  256  "$SRC" --out "$ICONSET/icon_256x256.png"    >/dev/null
sips -z 512  512  "$SRC" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
sips -z 512  512  "$SRC" --out "$ICONSET/icon_512x512.png"    >/dev/null
cp "$SRC"               "$ICONSET/icon_512x512@2x.png"

OUT="$REPO_ROOT/build/icon.icns"
iconutil -c icns "$ICONSET" -o "$OUT"

rm -rf "$ICONSET"
echo "✓ Wrote $OUT"
