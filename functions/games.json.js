/**
 * Cloudflare Pages Function: /games.json
 * Fetches games.json catalog from R2 bucket.
 */
export async function onRequest(context) {
    const { env, request } = context;
    if (!env.BUCKET) {
        return new Response("R2 BUCKET binding not configured", { status: 500 });
    }

    const object = await env.BUCKET.get("games.json", {
        range: request.headers,
        onlyIf: request.headers,
    });

    if (!object) {
        return new Response("games.json not found", { status: 404 });
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Cache-Control", "no-cache");
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");

    return new Response(object.body, {
        headers,
        status: object.range ? 206 : 200,
    });
}
