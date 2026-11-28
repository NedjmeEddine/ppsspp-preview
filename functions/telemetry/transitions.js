/**
 * Cloudflare Pages Function: POST /telemetry/transitions
 * Replaces the Go server during PoC: receives binary beacon batches
 * and writes them directly into R2 under transitions/{timestamp}_{random}.bin
 */
export async function onRequestPost(context) {
    const { env, request } = context;
    if (!env.BUCKET) {
        return new Response("R2 BUCKET binding not configured", { status: 500 });
    }

    try {
        const body = await request.arrayBuffer();
        if (!body || body.byteLength === 0) {
            return new Response("Empty telemetry payload", { status: 400 });
        }

        // Generate timestamped transition log key in R2
        const ts = Date.now();
        const rand = Math.random().toString(36).slice(2, 8);
        const r2Key = `transitions/${ts}_${rand}.bin`;

        await env.BUCKET.put(r2Key, body, {
            httpMetadata: {
                contentType: "application/octet-stream",
            },
            customMetadata: {
                uploadedAt: new Date().toISOString(),
                byteLength: String(body.byteLength),
            },
        });

        return new Response(JSON.stringify({ ok: true, key: r2Key }), {
            status: 200,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
            },
        });
    } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: err?.message || String(err) }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
        });
    }
}

export async function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        },
    });
}
