'use client';

/**
 * The console shell: navigation, session state, and the idle warning.
 *
 * Navigation is filtered by permission rather than greyed out. Showing an Ops
 * admin a Finance tab they cannot open teaches them to ignore the nav; showing
 * them only what they can do makes the tool smaller and clearer. The server
 * enforces the same matrix regardless — this is ergonomics, not security.
 */

import React, { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useSession, IDLE_WARNING_SECONDS } from '@/lib/session';
import { api } from '@/lib/api';
import { Icon } from './ui';
import { clock, duration, ROLE_LABELS } from '@/lib/format';

const NAV: { href: string; label: string; icon: string; permission?: string; superAdmin?: boolean }[] = [
    { href: '/', label: 'Dashboard', icon: 'dashboard', permission: 'dashboard:view' },
    { href: '/kyc', label: 'KYC queue', icon: 'kyc', permission: 'kyc:view' },
    { href: '/moderation', label: 'Moderation', icon: 'moderation', permission: 'moderation:view' },
    { href: '/reports', label: 'Reports', icon: 'report', permission: 'report:view' },
    { href: '/grievances', label: 'Grievances', icon: 'grievance', permission: 'grievance:view' },
    { href: '/bookings', label: 'Bookings', icon: 'booking', permission: 'booking:view' },
    { href: '/finance', label: 'Finance', icon: 'finance', permission: 'payout:view' },
    { href: '/users', label: 'Users', icon: 'users', permission: 'user:view' },
    { href: '/audit', label: 'Audit log', icon: 'audit', permission: 'audit:view' },
    { href: '/admins', label: 'Admin accounts', icon: 'admins', superAdmin: true },
];

type Counts = Record<string, number>;

export function Shell({ children }: { children: React.ReactNode }) {
    const { admin, can, isSuperAdmin, signOut, idleSecondsLeft, absoluteSecondsLeft, mfaBypassed } = useSession();
    const pathname = usePathname();
    const router = useRouter();
    const [counts, setCounts] = useState<Counts>({});

    // Queue badges come from the same counters the dashboard renders, so the nav
    // and the dashboard can never disagree.
    useEffect(() => {
        if (!admin || !can('dashboard:view')) return;
        let cancelled = false;
        const load = () => {
            api<any>('/dashboard')
                .then((res) => {
                    if (cancelled) return;
                    const t = res.data.tiles;
                    setCounts({
                        '/kyc': t.kyc.open,
                        '/moderation': t.moderation.open,
                        '/reports': t.reports.open,
                        '/grievances': t.grievances.open,
                        '/bookings': t.disputes.open,
                        '/finance': t.payouts.pending + t.payouts.failed + t.payouts.held,
                        '/users': t.deletions.pending,
                    });
                })
                .catch(() => {});
        };
        load();
        const timer = setInterval(load, 60_000);
        return () => { cancelled = true; clearInterval(timer); };
    }, [admin, can, pathname]);

    if (!admin) return null;

    const visible = NAV.filter((item) =>
        item.superAdmin ? isSuperAdmin : !item.permission || can(item.permission)
    );

    const idleWarning = idleSecondsLeft > 0 && idleSecondsLeft <= IDLE_WARNING_SECONDS;

    return (
        <div style={{ display: 'grid', gridTemplateColumns: '236px 1fr', minHeight: '100vh' }}>
            {/* ── Sidebar ────────────────────────────────────────────────── */}
            <aside style={{
                background: 'var(--panel)', borderRight: '1px solid var(--border)',
                display: 'flex', flexDirection: 'column', position: 'sticky', top: 0, height: '100vh',
            }}>
                <div style={{ padding: '20px 18px 16px', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                        <div className="hexagon" style={{
                            width: 26, height: 28, background: 'var(--color-accent)',
                            clipPath: 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)',
                        }} />
                        <div>
                            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, lineHeight: 1.1 }}>Hive Admin</div>
                            <div style={{ fontSize: 10.5, color: 'var(--muted-2)', letterSpacing: '.05em' }}>v2.1</div>
                        </div>
                    </div>
                </div>

                <nav style={{ padding: '10px 10px', flex: 1, overflowY: 'auto' }}>
                    {visible.map((item) => {
                        const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
                        const badge = counts[item.href];
                        return (
                            <Link
                                key={item.href}
                                href={item.href}
                                style={{
                                    display: 'flex', alignItems: 'center', gap: 10,
                                    padding: '8px 10px', borderRadius: 'var(--radius-sm)',
                                    marginBottom: 2, fontSize: 13, fontWeight: active ? 700 : 500,
                                    background: active ? 'var(--accent-soft)' : 'transparent',
                                    color: active ? 'var(--color-accent-press)' : 'var(--muted)',
                                }}
                            >
                                <Icon name={item.icon} size={15} />
                                <span style={{ flex: 1 }}>{item.label}</span>
                                {badge != null && badge > 0 && (
                                    <span className="pill pill-neutral" style={{ padding: '1px 7px', fontSize: 10.5 }}>{badge}</span>
                                )}
                            </Link>
                        );
                    })}
                </nav>

                {/* ── Session footer (AR-04 made visible) ─────────────────── */}
                <div style={{ padding: 14, borderTop: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700 }}>{admin.name}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted-2)', marginBottom: 8 }}>
                        {ROLE_LABELS[admin.role] ?? admin.role}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted-2)', marginBottom: 10, display: 'grid', gap: 2 }}>
                        <div>Session ends in {duration(absoluteSecondsLeft * 1000)}</div>
                        <div style={idleWarning ? { color: 'var(--color-breach)', fontWeight: 700 } : undefined}>
                            Idle timeout {clock(idleSecondsLeft)}
                        </div>
                    </div>
                    <button
                        className="btn btn-sm"
                        style={{ width: '100%' }}
                        onClick={async () => { await signOut(); router.push('/'); }}
                    >
                        <Icon name="logout" size={13} /> Sign out
                    </button>
                </div>
            </aside>

            {/* ── Content ────────────────────────────────────────────────── */}
            <main style={{ padding: '26px 30px 60px', maxWidth: 1440 }}>
                {/* Standing, not dismissible. A disabled security control that can be
                    clicked away is a disabled security control everyone forgets about. */}
                {mfaBypassed && (
                    <div
                        role="alert"
                        style={{
                            padding: '9px 16px', marginBottom: 18, borderRadius: 'var(--radius-sm)',
                            background: 'var(--color-breach)', color: '#fff',
                            display: 'flex', alignItems: 'center', gap: 9, fontSize: 12.5, fontWeight: 600,
                        }}
                    >
                        <Icon name="alert" size={15} />
                        Demo configuration — two-factor authentication is disabled
                        (<span className="mono" style={{ fontSize: 11.5 }}>ADMIN_DEMO_SKIP_MFA=1</span>).
                        This flag cannot be used against real data.
                    </div>
                )}

                {idleWarning && (
                    <div
                        role="alert"
                        className="panel"
                        style={{
                            padding: '11px 16px', marginBottom: 18,
                            borderColor: 'rgba(179,53,44,.3)', background: 'rgba(179,53,44,.05)',
                            display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, fontWeight: 600,
                        }}
                    >
                        <Icon name="clock" size={16} />
                        Signing you out in {clock(idleSecondsLeft)} — move the mouse or press a key to stay.
                    </div>
                )}
                {children}
            </main>
        </div>
    );
}
