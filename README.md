# PPSSPP-Preview (Cloudflare Pages + R2 Deployment)

Production serverless deployment for [PPSSPP-Stream](https://github.com/NedjmeEddine/ppsspp-stream) running 100% on **Cloudflare Pages** and **Cloudflare R2** with zero server maintenance.

---

## Architecture

* **Cloudflare Pages (`public/`):** Serves the static web shell, workers (`worker_a.js`, `worker_b.js`), and HUD overlay with required `COOP: same-origin` and `COEP: require-corp` headers.
* **Cloudflare R2 (`ppsspp-data` bucket):** Stores game `.bin` packs, `manifest.bin`, `games.json`, and the compiled `cores/ppsspp/PPSSPPSDL.{js,wasm,data}` core files.
* **Cloudflare Pages Functions (`functions/`):** Automatically routes `/games.json`, `/games/*`, and `/cores/*` requests to the R2 bucket with native HTTP `206` byte-range streaming.

---

## Setup & Deployment Guide

### 1. Create an R2 Bucket
In your Cloudflare Dashboard (or via Wrangler CLI):
```bash
npx wrangler r2 bucket create ppsspp-data
```

### 2. Upload Core Files & Games to R2
Upload the compiled PPSSPP WASM core files into `cores/` in your R2 bucket:
* `cores/ppsspp/PPSSPPSDL.js`
* `cores/ppsspp/PPSSPPSDL.wasm`
* `cores/ppsspp/PPSSPPSDL.data`

Upload your `dist/` games and catalog into the bucket:
* `games.json`
* `games/<game_id>/manifest.bin`
* `games/<game_id>/packs/pak_<hash>_0000.bin`

You can use the Cloudflare Dashboard web interface or `wrangler r2 object put`:
```bash
# Example uploading games.json
npx wrangler r2 object put ppsspp-data/games.json --file=./dist/games.json
```

### 3. Connect to Cloudflare Pages
1. In Cloudflare Dashboard, go to **Workers & Pages** -> **Create application** -> **Pages** -> **Connect to Git**.
2. Select repository `ppsspp-preview` (branch: `cloudflare-deploy` or `main`).
3. Set **Build Settings**:
   * **Framework preset:** `None`
   * **Build command:** `bash build.sh`
   * **Build output directory:** `public`
4. Bind the R2 bucket:
   * Go to **Settings** -> **Functions** -> **R2 bucket bindings**.
   * Variable name: `BUCKET`
   * R2 bucket: `ppsspp-data`
5. Deploy!
