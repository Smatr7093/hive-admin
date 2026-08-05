import type { Metadata } from 'next';
import { headers } from 'next/headers';
import './globals.css';
import { SessionProvider } from '@/lib/session';
import { AppFrame } from '@/components/AppFrame';

export const metadata: Metadata = {
    title: 'Hive Admin',
    description: 'Operations console for Hive — Siante Technologies Private Limited',
    // The console must never be indexed, previewed, or cached by anything.
    robots: { index: false, follow: false, nocache: true },
};

/**
 * Forces dynamic rendering.
 *
 * middleware.ts mints a per-request CSP nonce. Next can only stamp that nonce
 * onto its own inline bootstrap scripts while rendering the request — so a
 * statically prerendered page ships HTML with no nonce, the middleware still
 * sends a CSP header demanding one, and the browser blocks every script Next
 * emitted. The page then renders as inert HTML: the form is visible, nothing
 * is wired to it, and no request is made when you submit.
 *
 * Reading headers() below opts every route out of static rendering, which is
 * what makes the nonce reach the markup. Do not remove it.
 */
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
    // Read (and discard) the nonce. The access itself is what matters: it marks
    // this layout as dynamic so Next applies the nonce to its scripts.
    await headers();

    return (
        <html lang="en">
            <body>
                <SessionProvider>
                    <AppFrame>{children}</AppFrame>
                </SessionProvider>
            </body>
        </html>
    );
}
