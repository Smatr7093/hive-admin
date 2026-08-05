import type { NextConfig } from 'next';

/**
 * Security headers.
 *
 * The Content-Security-Policy is NOT set here — it needs a per-request nonce, so
 * it lives in middleware.ts. Setting it in both places would mean the browser
 * enforcing the intersection of the two, and the nonce-less copy would block
 * Next's own scripts.
 *
 * Everything below is static and applies to every response.
 */
const nextConfig: NextConfig = {
    reactStrictMode: true,
    poweredByHeader: false,

    async headers() {
        return [
            {
                source: '/:path*',
                headers: [
                    { key: 'X-Content-Type-Options', value: 'nosniff' },
                    { key: 'X-Frame-Options', value: 'DENY' },
                    // The URL alone leaks which queue an admin was in and which
                    // record they opened. Never send it anywhere.
                    { key: 'Referrer-Policy', value: 'no-referrer' },
                    { key: 'Permissions-Policy', value: 'geolocation=(), camera=(), microphone=(), payment=()' },
                    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
                    { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
                    // Nothing in the console should ever be cached to disk.
                    { key: 'Cache-Control', value: 'no-store, max-age=0' },
                    ...(process.env.NODE_ENV === 'production'
                        ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }]
                        : []),
                ],
            },
        ];
    },
};

export default nextConfig;
