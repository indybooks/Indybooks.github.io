// Server-side RSS/Atom feed fetcher.
//
// A browser can't fetch most podcast feeds directly - they carry no CORS
// headers - so the client falls back to free public CORS-proxy services.
// Those work for small feeds but impose their own timeout/response-size
// limits, which a large feed (hundreds of episodes) can exceed even though
// the feed itself is perfectly valid and reachable by any non-browser
// client. Running the fetch here, under this project's own compute, is
// subject to neither restriction.
//
// JWT verification is left ON (the Edge Function default): only a signed-in
// user of this project can invoke it. That, together with the ALLOWED_ORIGINS
// check below, is what stops this from being an open fetch proxy for other
// sites' traffic.

// Edit this before deploying: list the exact origin(s) this app is actually
// served from. A request whose Origin header isn't in this list still runs,
// but the response won't carry CORS headers for that origin, so the browser
// will block the calling page from reading it.
const ALLOWED_ORIGINS = [
    'https://indybooks.github.io',
];

const MAX_RESPONSE_BYTES = 15 * 1024 * 1024; // generous - real feeds run KB to a few MB
const FETCH_TIMEOUT_MS = 20000;

function corsHeadersFor(origin: string | null) {
    const allowOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    return {
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Vary': 'Origin',
    };
}

function jsonError(message: string, status: number, cors: Record<string, string>) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json' },
    });
}

Deno.serve(async (req) => {
    const cors = corsHeadersFor(req.headers.get('origin'));

    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: cors });
    }
    if (req.method !== 'GET') {
        return jsonError('Only GET is supported.', 405, cors);
    }

    const feedUrlParam = new URL(req.url).searchParams.get('url');
    if (!feedUrlParam) {
        return jsonError('Missing required "url" query parameter.', 400, cors);
    }

    let target: URL;
    try {
        target = new URL(feedUrlParam);
    } catch {
        return jsonError('Malformed feed URL.', 400, cors);
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        return jsonError('Only http/https feed URLs are supported.', 400, cors);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        const feedResponse = await fetch(target.toString(), {
            redirect: 'follow',
            signal: controller.signal,
            headers: {
                // Some podcast hosts block requests with no recognizable
                // client, or specifically reject known-generic server
                // User-Agents. A real device UA is more consistently let
                // through than something like "curl" or "Deno".
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 IndyBooksPWA/1.0',
                'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
            },
        });

        if (!feedResponse.ok || !feedResponse.body) {
            return jsonError(`Feed host responded with HTTP ${feedResponse.status}.`, 502, cors);
        }

        // Read with a hard cap instead of trusting Content-Length (hosts can
        // omit or misreport it), so a runaway or hostile response can't tie
        // up the function indefinitely.
        const reader = feedResponse.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_RESPONSE_BYTES) {
                await reader.cancel();
                return jsonError('Feed exceeded the maximum allowed size.', 413, cors);
            }
            chunks.push(value);
        }

        const body = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
        }

        // Returned as raw text, not JSON - the client's existing XML parser
        // reads this response body directly, the same way it reads a direct
        // or proxied fetch. No episode limit is applied here or anywhere in
        // this function; every episode the source feed lists comes through.
        return new Response(new TextDecoder('utf-8').decode(body), {
            status: 200,
            headers: { ...cors, 'Content-Type': 'application/xml; charset=utf-8' },
        });
    } catch (err) {
        const message = controller.signal.aborted
            ? 'Feed host took too long to respond.'
            : (err instanceof Error ? err.message : 'Unknown error fetching feed.');
        return jsonError(message, 502, cors);
    } finally {
        clearTimeout(timeout);
    }
});
