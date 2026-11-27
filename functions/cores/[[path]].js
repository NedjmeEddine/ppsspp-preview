/**
 * Cloudflare Pages Function: /cores/*
 * Serves compiled PPSSPP WASM core files (PPSSPPSDL.js, PPSSPPSDL.wasm, PPSSPPSDL.data) from R2.
 */
export async function onRequest(context) {
    const { env, request, params } = context;
    if (!env.BUCKET) {
        return new Response("R2 BUCKET binding not configured", { status: 500 });
    }

    const subpath = Array.isArray(params.path) ? params.path.join("/") : params.path;
    const r2Key = `cores/${subpath}`;

    const object = await env.BUCKET.get(r2Key, {
        range: request.headers,
        onlyIf: request.headers,
    });

    if (!object) {
        return new Response(`Core file ${r2Key} not found`, { status: 404 });
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");

    if (r2Key.endsWith(".wasm")) {
        headers.set("Content-Type", "application/wasm");
    } else if (r2Key.endsWith(".js")) {
        headers.set("Content-Type", "text/javascript; charset=utf-8");
    } else if (r2Key.endsWith(".data")) {
        headers.set("Content-Type", "application/octet-stream");
    }

    headers.set("Cache-Control", "public, max-age=31536000, immutable");

    return new Response(object.body, {
        headers,
        status: object.range ? 206 : 200,
    });
}
