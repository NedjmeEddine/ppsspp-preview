/**
 * Cloudflare Pages Function: /games/*
 * Streams manifests and packs from R2 with HTTP 206 Range support.
 */
export async function onRequest(context) {
    const { env, request, params } = context;
    if (!env.BUCKET) {
        return new Response("R2 BUCKET binding not configured", { status: 500 });
    }

    // params.path is an array of URL segments after /games/
    const subpath = Array.isArray(params.path) ? params.path.join("/") : params.path;
    const r2Key = `games/${subpath}`;

    const object = await env.BUCKET.get(r2Key, {
        range: request.headers,
        onlyIf: request.headers,
    });

    if (!object) {
        return new Response(`Object ${r2Key} not found`, { status: 404 });
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("Accept-Ranges", "bytes");
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");

    // Cache immutable packs forever, revalidate manifests
    if (r2Key.includes("/packs/")) {
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
    } else {
        headers.set("Cache-Control", "no-cache");
    }

    return new Response(object.body, {
        headers,
        status: object.range ? 206 : 200,
    });
}
