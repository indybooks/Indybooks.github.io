// =========================================================================
// fetch-feed — server-side RSS fetcher
//
// Replaces the third-party CORS proxy the app used to call. A browser cannot
// fetch an arbitrary podcast feed directly (no CORS headers on most feeds),
// so something server-side has to do it. Previously that was a public proxy
// which saw every feed URL any user imported and had no availability
// guarantee. This runs in your own project instead.
//
// Deploy:  supabase functions deploy fetch-feed
// Or commit under supabase/functions/ and let the GitHub integration ship it.
//
// This function requires a signed-in caller (verify_jwt is on by default), so
// it is not an open proxy that strangers can route traffic through.
// =========================================================================

const ALLOWED_ORIGINS = [
  // Add your deployed origins here. Keep this tight: it is what stops other
  // sites from using your project's compute to fetch their traffic.
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'https://indybooks.pages.dev',
];

const MAX_BYTES = 5 * 1024 * 1024;   // a 5MB feed is already pathological
const FETCH_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;

function corsHeaders(origin: string | null) {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

/**
 * Reject anything that isn't a public http(s) URL.
 *
 * This is the security-critical part. Without it the function is an SSRF
 * gadget: a caller could ask it to fetch cloud metadata endpoints or hosts
 * inside the platform's network and hand back the response.
 */
function validateTarget(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Not a valid URL.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https feeds are supported.');
  }

  const host = url.hostname.toLowerCase();

  // Literal loopback / link-local / metadata hosts.
  const blockedHosts = [
    'localhost', '127.0.0.1', '0.0.0.0', '::1',
    'metadata.google.internal', '169.254.169.254',
  ];
  if (blockedHosts.includes(host)) throw new Error('That host is not allowed.');

  // Private IPv4 ranges, when the host is a bare address. Hostnames that
  // resolve to private space are not caught here — Deno gives no hook
  // between DNS resolution and connection — but the allowlisted origin plus
  // the JWT requirement keep this to your own signed-in users.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    const isPrivate =
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a === 0 ||
      a >= 224;
    if (isPrivate) throw new Error('That address range is not allowed.');
  }

  // IPv6 loopback / unique-local / link-local.
  if (host.includes(':') && /^\[?(::1|fc|fd|fe8|fe9|fea|feb)/i.test(host)) {
    throw new Error('That address range is not allowed.');
  }

  return url;
}

/** Follow redirects manually so every hop is validated, not just the first. */
async function fetchFeed(target: URL, signal: AbortSignal): Promise<Response> {
  let current = target;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await fetch(current.toString(), {
      redirect: 'manual',
      signal,
      headers: {
        // Some hosts serve a different body, or block entirely, without these.
        'User-Agent': 'IndyBooks/1.0 (podcast feed reader)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new Error('Redirect without a destination.');
      // A redirect to a private address is the classic SSRF bypass.
      current = validateTarget(new URL(location, current).toString());
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects.');
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const cors = corsHeaders(origin);

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });

  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.url !== 'string') {
      return json({ error: 'Send { "url": "https://…" }.' }, 400);
    }

    const target = validateTarget(body.url);
    const res = await fetchFeed(target, controller.signal);

    if (!res.ok) {
      return json({ error: `The feed host returned ${res.status}.` }, 502);
    }

    // Guard against a huge or endless body before reading it into memory.
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) {
      return json({ error: 'That feed is too large.' }, 413);
    }

    const buffer = new Uint8Array(await res.arrayBuffer());
    if (buffer.byteLength > MAX_BYTES) {
      return json({ error: 'That feed is too large.' }, 413);
    }

    // Feeds are frequently declared in something other than UTF-8, and
    // mis-decoding mangles episode titles. Honour the charset when given.
    const contentType = res.headers.get('content-type') || '';
    const charset = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim() || 'utf-8';
    let contents: string;
    try {
      contents = new TextDecoder(charset).decode(buffer);
    } catch {
      contents = new TextDecoder('utf-8').decode(buffer);
    }

    return json({
      contents,
      finalUrl: res.url || target.toString(),
      contentType,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const aborted = message.includes('abort') || (err as Error)?.name === 'AbortError';
    return json({ error: aborted ? 'The feed took too long to respond.' : message },
                aborted ? 504 : 400);
  } finally {
    clearTimeout(timer);
  }
});
