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

const SIDEBAR_WIDTH = 236;
const COLLAPSED_WIDTH = 60;
const COLLAPSE_KEY = 'hive-admin:nav-collapsed';

export function Shell({ children }: { children: React.ReactNode }) {
    const { admin, can, isSuperAdmin, signOut, idleSecondsLeft, absoluteSecondsLeft, mfaBypassed } = useSession();
    const pathname = usePathname();
    const router = useRouter();
    const [counts, setCounts] = useState<Counts>({});

    // Remembered per browser, so collapsing it once is a decision rather than
    // something to redo on every page load. Read after mount, not during
    // render: the server has no localStorage, and reading it in the initial
    // state makes the markup disagree with the client's first paint.
    const [collapsed, setCollapsed] = useState(false);
    useEffect(() => {
        try {
            setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === '1');
        } catch {
            /* private windows and blocked site data — the default stands */
        }
    }, []);

    const toggleCollapsed = () => {
        setCollapsed((previous) => {
            const next = !previous;
            try { window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
            return next;
        });
    };

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
        // The frame is exactly the viewport and does not scroll. Only the two
        // panes inside it do, so the nav and the session timer stay put while a
        // long queue moves — on a 13" laptop the old layout scrolled the whole
        // page, taking "signing you out in 30 seconds" off the screen.
        <div style={{
            display: 'grid',
            gridTemplateColumns: `${collapsed ? COLLAPSED_WIDTH : SIDEBAR_WIDTH}px 1fr`,
            height: '100vh',
            overflow: 'hidden',
            transition: 'grid-template-columns 160ms ease',
        }}>
            {/* ── Sidebar ────────────────────────────────────────────────── */}
            <aside style={{
                background: 'var(--panel)', borderRight: '1px solid var(--border)',
                display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden',
            }}>
                <div style={{
                    padding: collapsed ? '20px 0 16px' : '20px 18px 16px',
                    borderBottom: '1px solid var(--border)',
                    display: 'flex', alignItems: 'center',
                    justifyContent: collapsed ? 'center' : 'space-between', gap: 9,
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                        <div className="hexagon" style={{
                            width: 26, height: 28, flexShrink: 0, background: 'var(--color-accent)',
                            clipPath: 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)',
                        }} />
                        {!collapsed && (
                            <div style={{ minWidth: 0 }}>
                                <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, lineHeight: 1.1 }}>Hive Admin</div>
                                <div style={{ fontSize: 10.5, color: 'var(--muted-2)', letterSpacing: '.05em' }}>v2.1</div>
                            </div>
                        )}
                    </div>
                    {!collapsed && (
                        <button
                            onClick={toggleCollapsed}
                            aria-label="Collapse navigation"
                            title="Collapse navigation"
                            style={{
                                background: 'none', border: 'none', cursor: 'pointer', padding: 4,
                                color: 'var(--muted-2)', lineHeight: 0, flexShrink: 0,
                            }}
                        >
                            <Icon name="chevron" size={16} className="flip-x" />
                        </button>
                    )}
                </div>

                {collapsed && (
                    <button
                        onClick={toggleCollapsed}
                        aria-label="Expand navigation"
                        title="Expand navigation"
                        style={{
                            background: 'none', border: 'none', cursor: 'pointer',
                            padding: '10px 0 2px', color: 'var(--muted-2)', lineHeight: 0,
                        }}
                    >
                        <Icon name="chevron" size={16} />
                    </button>
                )}

                <nav style={{ padding: '10px 10px', flex: 1, overflowY: 'auto' }}>
                    {visible.map((item) => {
                        const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
                        const badge = counts[item.href];
                        return (
                            <Link
                                key={item.href}
                                href={item.href}
                                // Collapsed, the label is the only thing naming the
                                // destination, so it becomes the tooltip. A row of
                                // unlabelled icons is a guessing game.
                                title={collapsed ? item.label : undefined}
                                style={{
                                    display: 'flex', alignItems: 'center', gap: 10,
                                    justifyContent: collapsed ? 'center' : 'flex-start',
                                    position: 'relative',
                                    padding: collapsed ? '9px 0' : '8px 10px',
                                    borderRadius: 'var(--radius-sm)',
                                    marginBottom: 2, fontSize: 13, fontWeight: active ? 700 : 500,
                                    background: active ? 'var(--accent-soft)' : 'transparent',
                                    color: active ? 'var(--color-accent-press)' : 'var(--muted)',
                                }}
                            >
                                <Icon name={item.icon} size={15} />
                                {!collapsed && <span style={{ flex: 1 }}>{item.label}</span>}
                                {badge != null && badge > 0 && (collapsed ? (
                                    // A dot, not a number. Three digits do not fit in
                                    // 60px, but "something is waiting here" still has
                                    // to survive the collapse.
                                    <span
                                        aria-label={`${badge} waiting`}
                                        style={{
                                            position: 'absolute', top: 6, right: 12,
                                            width: 6, height: 6, borderRadius: '50%',
                                            background: 'var(--color-accent)',
                                        }}
                                    />
                                ) : (
                                    <span className="pill pill-neutral" style={{ padding: '1px 7px', fontSize: 10.5 }}>{badge}</span>
                                ))}
                            </Link>
                        );
                    })}
                </nav>

                {/* ── Session footer (AR-04 made visible) ─────────────────── */}
                <div style={{
                    padding: collapsed ? '10px 6px' : 14,
                    borderTop: '1px solid var(--border)',
                }}>
                    {!collapsed && (
                        <>
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
                        </>
                    )}
                    <button
                        className="btn btn-sm"
                        // Collapsed, the countdown has nowhere to go, so it moves
                        // into the tooltip rather than disappearing — the session
                        // ending without warning is the thing this footer exists
                        // to prevent.
                        title={collapsed
                            ? `${admin.name} · signing out in ${duration(absoluteSecondsLeft * 1000)}`
                            : undefined}
                        style={{ width: '100%', justifyContent: 'center' }}
                        onClick={async () => { await signOut(); router.push('/'); }}
                    >
                        <Icon name="logout" size={13} />{!collapsed && ' Sign out'}
                    </button>
                </div>
            </aside>

            {/* ── Content ────────────────────────────────────────────────── */}
            {/* The only scrolling pane. maxWidth is gone: this is a console read
                on wide screens, and capping it at 1440 left a third of a desk
                monitor empty while booking tables scrolled sideways. */}
            <main style={{
                padding: '26px 30px 60px',
                height: '100vh',
                overflowY: 'auto',
                overflowX: 'hidden',
                minWidth: 0,
            }}>
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
