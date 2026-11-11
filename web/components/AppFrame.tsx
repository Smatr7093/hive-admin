'use client';

/**
 * Decides between the login screen and the console.
 *
 * Everything below this point assumes an authenticated admin, so no page has to
 * write a "not signed in" branch.
 *
 * The session lives in an httpOnly cookie, which this code cannot read — so on
 * load we ask the server whether it still names a live session, and show
 * nothing until it answers. Rendering the login form during that moment would
 * flash a sign-in screen at someone who is already signed in, every refresh,
 * which looks like the bug it used to be.
 */

import React from 'react';
import { useSession } from '@/lib/session';
import { LoginGate } from './LoginGate';
import { Shell } from './Shell';

export function AppFrame({ children }: { children: React.ReactNode }) {
    const { admin, restoring } = useSession();

    // Deliberately bare: a spinner here would be the first thing on screen on
    // every load, and the check is one request against a warm server.
    if (restoring) {
        return (
            <div
                aria-busy="true"
                aria-live="polite"
                style={{ minHeight: '100dvh' }}
            >
                <span className="sr-only">Checking your session…</span>
            </div>
        );
    }

    if (!admin) return <LoginGate />;
    return <Shell>{children}</Shell>;
}
