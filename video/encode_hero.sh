#!/usr/bin/env bash
# Encodes the rendered hero loop (video/out/shots/hero_loop) as web/public/hero/loop.mp4 (H.264): the landing's
# fallback when the design video cannot load (the background fades in once playing, so no poster is needed). No audio
# track; +faststart so playback begins while the file is still downloading.
set -euo pipefail
cd "$(dirname "$0")/.."
FFMPEG="${FFMPEG:-$HOME/tools/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe}"
FRAMES="video/out/shots/hero_loop/frame_%04d.png"
OUT="web/public/hero"
mkdir -p "$OUT"
"$FFMPEG" -v error -y -framerate 30 -i "$FRAMES" -an -c:v libx264 -preset slow -crf 21 -pix_fmt yuv420p \
  -profile:v high -movflags +faststart "$OUT/loop.mp4"
ls -la "$OUT"
