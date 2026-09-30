#!/usr/bin/env bash
# Renders every 3D shot at 1920x1080 / 30 fps into video/out/shots/<shot>/frame_####.png.
# Resumable: frames already on disk are skipped. Usage: bash video/render_all.sh [shot1_lock shot3_proof ...]
set -euo pipefail
cd "$(dirname "$0")/.."
BLENDER="${BLENDER:-$HOME/tools/blender-4.5.14-windows-x64/blender.exe}"
SHOTS=("${@:-shot1_lock shot2_hook shot3_proof shot4_vault shot5_close}")
for shot in ${SHOTS[@]}; do
  echo "=== $shot $(date +%T)"
  "$BLENDER" -b --factory-startup -P "video/blender/$shot.py" -- --out "video/out/shots/$shot" 2>&1 \
    | grep -E "^Fra:[0-9]+ .*(Sample [0-9]+/[0-9]+|Finished)|Saved|Error|Traceback" | grep -E "Saved|Error|Traceback" || true
  echo "=== $shot done $(date +%T): $(ls video/out/shots/$shot | wc -l) frames"
done
