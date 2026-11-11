'use client';

/**
 * Session context.
 *
 * Owns three things the rest of the console leans on:
 *
 *  - who is signed in and what they may do (`can`), so screens gate on
 *    permissions rather than on role strings scattered through JSX;
 *  - the idle countdown, mirroring AR-04's 30-minute server-side timeout with a
 *    visible warning before it fires — being logged out mid-decision without
 *    notice is how people start writing their reasons in a text file first;
 *  - the absolute 8-hour deadline, shown in the header so a shift knows when it
 *    will end.
 *
 * The client clock is advisory. The server is the authority on both timeouts;
 * this only removes the surprise.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Admin, setToken, setUnauthorizedHandler, logout as apiLogout, restoreSession } from './api';

type SessionState = {
    admin: Admin | null;
    expiresAt: string | null;
    idleSecondsLeft: number;
    absoluteSecondsLeft: number;
    endedReason: string | null;
    /** True when the server is running the demo 2FA bypass. Drives a standing banner. */
    mfaBypassed: boolean;
    /**
     * True until the boot-time session restore has answered. The frame shows
     * nothing while this is true rather than the login form, so a refresh with
     * a valid cookie does not flash a sign-in screen on its way back in.
     */
    restoring: boolean;
};

type SessionContextValue = SessionState & {
    signIn: (admin: Admin, expiresAt: string, idleTimeoutSeconds: number, mfaBypassed?: boolean) => void;
    signOut: () => Promise<void>;
    touch: () => void;
    can: (permission: string) => boolean;
    isSuperAdmin: boolean;
};

const SessionContext = createContext<SessionContextValue | null>(null);

const IDLE_WARNING_SECONDS = 120;

export function SessionProvider({ children }: { children: React.ReactNode }) {
    const [admin, setAdmin] = useState<Admin | null>(null);
    const [expiresAt, setExpiresAt] = useState<string | null>(null);
    const [idleSecondsLeft, setIdleSecondsLeft] = useState(0);
    const [absoluteSecondsLeft, setAbsoluteSecondsLeft] = useState(0);
    const [endedReason, setEndedReason] = useState<string | null>(null);
    const [mfaBypassed, setMfaBypassed] = useState(false);
    const [restoring, setRestoring] = useState(true);

    const idleTimeout = useRef(1800);
    const lastActivity = useRef(Date.now());

    const end = useCallback((reason: string) => {
        setAdmin(null);
        setExpiresAt(null);
        setToken(null);
        setEndedReason(reason);
    }, []);

    useEffect(() => {
        setUnauthorizedHandler((code, message) => {
            const readable: Record<string, string> = {
                SESSION_IDLE: 'Signed out after 30 minutes idle.',
                SESSION_EXPIRED: 'Your 8-hour session has ended.',
                SESSION_REVOKED: 'A Super Admin revoked this session.',
                ACCOUNT_INACTIVE: 'This account is no longer active.',
            };
            end(readable[code] ?? message);
        });
    }, [end]);

    // On load, ask the server whether the httpOnly cookie still names a live
    // session. The cookie itself is unreadable here by design, so this is the
    // only way to know — and the server is the authority on the idle and
    // absolute timeouts anyway, so asking it is the correct answer rather than
    // a workaround.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const restored = await restoreSession();
            if (cancelled) return;
            if (restored) {
                idleTimeout.current = restored.idleTimeoutSeconds;
                lastActivity.current = Date.now();
                setAdmin(restored.admin);
                setExpiresAt(restored.expiresAt);
                setIdleSecondsLeft(restored.idleTimeoutSeconds);
            }
            setRestoring(false);
        })();
        return () => { cancelled = true; };
    }, []);

    const signIn = useCallback((
        nextAdmin: Admin,
        nextExpiresAt: string,
        idleTimeoutSeconds: number,
        bypassed = false,
    ) => {
        idleTimeout.current = idleTimeoutSeconds;
        lastActivity.current = Date.now();
        setAdmin(nextAdmin);
        setExpiresAt(nextExpiresAt);
        setEndedReason(null);
        setIdleSecondsLeft(idleTimeoutSeconds);
        setMfaBypassed(bypassed);
    }, []);

    const signOut = useCallback(async () => {
        await apiLogout().catch(() => {});
        end('Signed out.');
    }, [end]);

    const touch = useCallback(() => {
        lastActivity.current = Date.now();
    }, []);

    // Any real interaction counts as activity, matching what the server sees:
    // it refreshes lastSeenAt on every request, so a click that fetches keeps
    // the session alive either way. Tracking here keeps the countdown honest
    // between requests.
    useEffect(() => {
        if (!admin) return;
        const events = ['click', 'keydown', 'scroll', 'pointerdown'];
        const handler = () => touch();
        events.forEach((e) => window.addEventListener(e, handler, { passive: true }));
        return () => events.forEach((e) => window.removeEventListener(e, handler));
    }, [admin, touch]);

    useEffect(() => {
        if (!admin) return;
        const tick = setInterval(() => {
            const idleLeft = Math.max(0, idleTimeout.current - Math.floor((Date.now() - lastActivity.current) / 1000));
            setIdleSecondsLeft(idleLeft);
            if (expiresAt) {
                setAbsoluteSecondsLeft(Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000)));
            }
            if (idleLeft === 0) end('Signed out after 30 minutes idle.');
            else if (expiresAt && Date.parse(expiresAt) <= Date.now()) end('Your 8-hour session has ended.');
        }, 1000);
        return () => clearInterval(tick);
    }, [admin, expiresAt, end]);

    const value = useMemo<SessionContextValue>(() => ({
        admin,
        expiresAt,
        idleSecondsLeft,
        absoluteSecondsLeft,
        endedReason,
        mfaBypassed,
        restoring,
        signIn,
        signOut,
        touch,
        can: (permission: string) => !!admin?.permissions?.includes(permission),
        isSuperAdmin: admin?.role === 'super_admin',
    }), [admin, expiresAt, idleSecondsLeft, absoluteSecondsLeft, endedReason, mfaBypassed, restoring, signIn, signOut, touch]);

    return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
    const ctx = useContext(SessionContext);
    if (!ctx) throw new Error('useSession must be used inside SessionProvider');
    return ctx;
}

export { IDLE_WARNING_SECONDS };
