'use client';

/**
 * Decides between the login screen and the console.
 *
 * Everything below this point assumes an authenticated admin, so no page has to
 * write a "not signed in" branch. Because the token lives in memory only, a
 * refresh lands here with no session and shows the login form — which is the
 * intended behaviour, not a bug to paper over with a persisted token.
 */

import React from 'react';
import { useSession } from '@/lib/session';
import { LoginGate } from './LoginGate';
import { Shell } from './Shell';

export function AppFrame({ children }: { children: React.ReactNode }) {
    const { admin } = useSession();
    if (!admin) return <LoginGate />;
    return <Shell>{children}</Shell>;
}
