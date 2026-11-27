#!/usr/bin/env bash
set -euo pipefail

# Build script for Cloudflare Pages
# Copies upstream/web into public/ with dereferenced symlinks (-L)
echo "[build] Updating submodules..."
git submodule update --init --recursive

echo "[build] Preparing public/ directory..."
rm -rf public
mkdir -p public

echo "[build] Copying web assets (dereferencing symlinks)..."
cp -rL upstream/web/* public/

echo "[build] Installing _headers for COOP/COEP..."
cp _headers public/_headers

echo "[build] Build complete. Files in public/:"
ls -lh public/ | head -20
