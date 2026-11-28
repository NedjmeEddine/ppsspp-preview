/**
 * Cloudflare Worker with Static Assets + R2 Streaming
 * Replaces Pages Functions: handles /games.json, /games/*, /cores/*, and telemetry
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

        // 2. Games catalog
        if (pathname === "/games.json" || pathname === "/api/games") {
            if (!env.BUCKET) return new Response("R2 BUCKET not bound", { status: 500 });
            const obj = await env.BUCKET.get("games.json", {
                range: request.headers,
                onlyIf: request.headers,
            });
            if (!obj) return new Response("games.json not found in R2", { status: 404 });

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
        if (pathname.startsWith("/games/")) {
            if (!env.BUCKET) return new Response("R2 BUCKET not bound", { status: 500 });
            const r2Key = pathname.slice(1); // e.g. games/ben10_ua/manifest.bin
            const obj = await env.BUCKET.get(r2Key, {
                range: request.headers,
                onlyIf: request.headers,
            });
            if (!obj) return new Response(`Object ${r2Key} not found in R2`, { status: 404 });

            const headers = new Headers();
            obj.writeHttpMetadata(headers);
            headers.set("etag", obj.httpEtag);
            headers.set("Accept-Ranges", "bytes");
            headers.set("Cross-Origin-Opener-Policy", "same-origin");
            headers.set("Cross-Origin-Embedder-Policy", "require-corp");
            if (r2Key.includes("/packs/")) {
                headers.set("Cache-Control", "public, max-age=31536000, immutable");
            } else {
                headers.set("Cache-Control", "no-cache");
            }
            return new Response(obj.body, { headers, status: obj.range ? 206 : 200 });
        }

        // 4. Core files (/cores/*)
        if (pathname.startsWith("/cores/")) {
            if (!env.BUCKET) return new Response("R2 BUCKET not bound", { status: 500 });
            const r2Key = pathname.slice(1);
            const obj = await env.BUCKET.get(r2Key, {
                range: request.headers,
                onlyIf: request.headers,
            });
            if (!obj) return new Response(`Core ${r2Key} not found in R2`, { status: 404 });

            const headers = new Headers();
            obj.writeHttpMetadata(headers);
            headers.set("etag", obj.httpEtag);
            headers.set("Cross-Origin-Opener-Policy", "same-origin");
            headers.set("Cross-Origin-Embedder-Policy", "require-corp");
            if (r2Key.endsWith(".wasm")) headers.set("Content-Type", "application/wasm");
            if (r2Key.endsWith(".js")) headers.set("Content-Type", "text/javascript; charset=utf-8");
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
