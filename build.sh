#!/usr/bin/env bash
set -euo pipefail

# Build script for Cloudflare Pages
echo "[build] Copying _headers into public/..."
cp _headers public/_headers

echo "[build] Build complete. Files in public/:"
ls -lh public/ | head -20
