import { NextRequest, NextResponse } from 'next/server';

/**
 * AR-09 — strict CSP with a per-request nonce.
 *
 * Next's App Router streams RSC payload through inline `<script>` tags. Under a
 * plain `script-src 'self'` those are blocked and the page renders blank, and the
 * usual fix — adding `'unsafe-inline'` — is the fix that makes the CSP stop being
 * worth having: an injected `<script>alert(document.cookie)</script>` would run
 * too.
 *
 * So instead: a fresh nonce per request, set both on the response CSP and on the
 * request headers where Next reads it and stamps it onto its own scripts.
 * Anything Next did not emit has no nonce and does not run.
 *
 * `'strict-dynamic'` is what lets the nonced bootstrap script load the chunk
 * files it needs. Browsers honouring strict-dynamic ignore the `'self'` in
 * script-src, so the nonce becomes the only way in — which is the point.
 *
 * `connect-src` is pinned to the admin API. A compromised dependency cannot POST
 * a KYC document to an attacker's host, because the browser will not open the
 * connection.
 */

const API_ORIGIN = process.env.NEXT_PUBLIC_ADMIN_API ?? 'http://localhost:4000';
const isDev = process.env.NODE_ENV === 'development';

export function middleware(request: NextRequest) {
    const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

    const csp = [
        "default-src 'self'",
        // 'unsafe-eval' is dev-only — the webpack/turbopack dev runtime needs it.
        `script-src 'nonce-${nonce}' 'strict-dynamic' 'self'${isDev ? " 'unsafe-eval'" : ''}`,
        // Styles stay 'unsafe-inline': the console uses inline style attributes
        // throughout, and a style injection cannot execute code. Worth revisiting
        // if the styling ever moves fully into stylesheets.
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        `connect-src 'self' ${API_ORIGIN}${isDev ? ' ws: wss:' : ''}`,
        "frame-ancestors 'none'",
        "form-action 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        ...(isDev ? [] : ['upgrade-insecure-requests']),
    ].join('; ');

    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-nonce', nonce);
    requestHeaders.set('Content-Security-Policy', csp);

    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set('Content-Security-Policy', csp);
    return response;
}

export const config = {
    matcher: [
        // Everything except static assets and the favicon — those need no policy
        // and re-running the middleware on each chunk is pure overhead.
        {
            source: '/((?!_next/static|_next/image|favicon.ico).*)',
            missing: [
                { type: 'header', key: 'next-router-prefetch' },
                { type: 'header', key: 'purpose', value: 'prefetch' },
            ],
        },
    ],
};
