#!/usr/bin/env bash
# Encodes the rendered hero loop (video/out/shots/hero_loop) for the landing page:
#   web/public/hero/loop.mp4 (H.264), loop.webm (VP9) and poster.jpg (the loop's first frame, so there is no
#   flash before playback). No audio track; +faststart so playback begins while the file is still downloading.
set -euo pipefail
cd "$(dirname "$0")/.."
FFMPEG="${FFMPEG:-$HOME/tools/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe}"
FRAMES="video/out/shots/hero_loop/frame_%04d.png"
OUT="web/public/hero"
mkdir -p "$OUT"
"$FFMPEG" -v error -y -framerate 30 -i "$FRAMES" -an -c:v libx264 -preset slow -crf 21 -pix_fmt yuv420p \
  -profile:v high -movflags +faststart "$OUT/loop.mp4"
"$FFMPEG" -v error -y -framerate 30 -i "$FRAMES" -an -c:v libvpx-vp9 -crf 33 -b:v 0 -row-mt 1 -pix_fmt yuv420p "$OUT/loop.webm"
"$FFMPEG" -v error -y -i "video/out/shots/hero_loop/frame_0001.png" -q:v 3 "$OUT/poster.jpg"
ls -la "$OUT"
