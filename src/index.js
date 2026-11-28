/**
 * Cloudflare Worker with Static Assets + R2 Streaming
 * Handles /games.json, /games/*, /packs/*, /cores/*, and telemetry
 * while serving static assets from env.ASSETS with COOP/COEP isolation.
 */
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const pathname = url.pathname;

        // 1. Telemetry endpoint
        if (pathname === "/telemetry/transitions") {
            if (request.method === "OPTIONS") {
                return new Response(null, {
                    status: 204,
                    headers: {
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Methods": "POST, OPTIONS",
                        "Access-Control-Allow-Headers": "Content-Type",
                    },
                });
            }
            if (request.method === "POST" && env.BUCKET) {
                try {
                    const body = await request.arrayBuffer();
                    if (!body || body.byteLength === 0) {
                        return new Response("Empty payload", { status: 400 });
                    }
                    const r2Key = `transitions/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.bin`;
                    await env.BUCKET.put(r2Key, body);
                    return Response.json({ ok: true, key: r2Key });
                } catch (err) {
                    return Response.json({ ok: false, error: err.message }, { status: 500 });
                }
            }
        }

        // Helper to query R2 across fallback candidate keys
        async function getR2Object(candidates) {
            if (!env.BUCKET) return null;
            for (const key of candidates) {
                try {
                    const obj = await env.BUCKET.get(key, {
                        range: request.headers,
                        onlyIf: request.headers,
                    });
                    if (obj) return { obj, key };
                } catch (_) {}
            }
            return null;
        }

        // 2. Games catalog
        if (pathname === "/games.json" || pathname === "/api/games") {
            let res = await getR2Object(["games.json", "dist/games.json"]);
            if (!res) {
                // Fallback to static asset games.json if available
                return env.ASSETS.fetch(request);
            }
            const { obj } = res;
            const headers = new Headers();
            obj.writeHttpMetadata(headers);
            headers.set("etag", obj.httpEtag);
            headers.set("Content-Type", "application/json; charset=utf-8");
            headers.set("Cache-Control", "no-cache");
            headers.set("Cross-Origin-Opener-Policy", "same-origin");
            headers.set("Cross-Origin-Embedder-Policy", "require-corp");
            return new Response(obj.body, { headers, status: obj.range ? 206 : 200 });
        }

        // 3. Game manifests and 256MB pack streaming
        if (pathname.startsWith("/games/") || pathname.startsWith("/packs/") || pathname === "/manifest.bin") {
            if (!env.BUCKET) return new Response("R2 BUCKET not bound in Worker settings", { status: 500 });

            const cleanPath = pathname.replace(/^\/+/, "");
            const candidates = [cleanPath];

            if (cleanPath.includes("/packs/")) {
                candidates.push(cleanPath.replace("/packs/", "/"));
            }
            if (cleanPath.startsWith("games/")) {
                const subPath = cleanPath.slice("games/".length);
                candidates.push(subPath);
                if (subPath.includes("/packs/")) {
                    candidates.push(subPath.replace("/packs/", "/"));
                }
            }
            const parts = cleanPath.split("/");
            const filename = parts[parts.length - 1];
            if (!candidates.includes(filename)) {
                candidates.push(filename);
            }

            const res = await getR2Object(candidates);
            if (!res) {
                return new Response(`Object not found in R2 bucket.\nTried keys:\n- ${candidates.join("\n- ")}`, { status: 404 });
            }

            const { obj, key } = res;
            const headers = new Headers();
            obj.writeHttpMetadata(headers);
            headers.set("etag", obj.httpEtag);
            headers.set("Accept-Ranges", "bytes");
            headers.set("Cross-Origin-Opener-Policy", "same-origin");
            headers.set("Cross-Origin-Embedder-Policy", "require-corp");
            if (key.includes("pak_")) {
                headers.set("Cache-Control", "public, max-age=31536000, immutable");
            } else {
                headers.set("Cache-Control", "no-cache");
            }
            return new Response(obj.body, { headers, status: obj.range ? 206 : 200 });
        }

        // 4. Core files (/cores/*)
        if (pathname.startsWith("/cores/")) {
            if (!env.BUCKET) return new Response("R2 BUCKET not bound in Worker settings", { status: 500 });
            const cleanPath = pathname.replace(/^\/+/, "");
            const candidates = [cleanPath];
            if (cleanPath.startsWith("cores/")) {
                candidates.push(cleanPath.slice("cores/".length));
            }
            const parts = cleanPath.split("/");
            const filename = parts[parts.length - 1];
            if (!candidates.includes(filename)) {
                candidates.push(filename);
            }

            const res = await getR2Object(candidates);
            if (!res) {
                const assetRes = await env.ASSETS.fetch(request);
                if (assetRes.status !== 404) return assetRes;
                return new Response(`Core object not found in R2.\nTried keys:\n- ${candidates.join("\n- ")}`, { status: 404 });
            }

            const { obj, key } = res;
            const headers = new Headers();
            obj.writeHttpMetadata(headers);
            headers.set("etag", obj.httpEtag);
            headers.set("Cross-Origin-Opener-Policy", "same-origin");
            headers.set("Cross-Origin-Embedder-Policy", "require-corp");
            if (key.endsWith(".wasm")) headers.set("Content-Type", "application/wasm");
            if (key.endsWith(".js")) headers.set("Content-Type", "text/javascript; charset=utf-8");
            headers.set("Cache-Control", "public, max-age=31536000, immutable");
            return new Response(obj.body, { headers, status: obj.range ? 206 : 200 });
        }

        // 5. Static frontend assets (HTML, Workers, VFS WASM)
        const response = await env.ASSETS.fetch(request);
        const headers = new Headers(response.headers);
        headers.set("Cross-Origin-Opener-Policy", "same-origin");
        headers.set("Cross-Origin-Embedder-Policy", "require-corp");
        headers.set("Cross-Origin-Resource-Policy", "cross-origin");
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
        });
    },
};
