'use client';

/**
 * Operational dashboard (PRD §11).
 *
 * Counters only. Each tile answers "is there work outstanding, and how late is
 * it" — nothing here is a chart, because an operator opening this at 09:00 needs
 * to know where to start, not how last quarter went.
 *
 * The ordering is deliberate: the urgent grievance track sits above everything
 * else, because a 24-hour statutory clock outranks a queue that is merely long.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { PageHeader, Panel, Pill, Loading, ErrorNote, Icon } from '@/components/ui';
import { rupees, ROLE_LABELS } from '@/lib/format';

type Tile = Record<string, any>;

export default function DashboardPage() {
    const { admin, isSuperAdmin } = useSession();
    const [data, setData] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);

    const load = () => {
        setError(null);
        api<any>('/dashboard').then((r) => setData(r.data)).catch((e) => setError(e.message));
    };

    useEffect(load, []);

    if (error) return <ErrorNote error={error} onRetry={load} />;
    if (!data) return <Loading rows={4} />;

    const t = data.tiles as Record<string, Tile>;

    return (
        <>
            <PageHeader
                title={`Good ${greeting()}, ${admin!.name.split(' ')[0]}`}
                subtitle={`Signed in as ${ROLE_LABELS[admin!.role] ?? admin!.role}. Everything below is outstanding work, oldest and latest first.`}
            >
                <button className="btn" onClick={load}><Icon name="refresh" size={14} /> Refresh</button>
            </PageHeader>

            {/* Urgent track leads — G-05/G-06 make this the one thing that cannot wait. */}
            {t.urgentTrack.outstanding > 0 && (
                <Link href="/grievances?state=urgent">
                    <div
                        className="panel"
                        style={{
                            padding: 18, marginBottom: 20,
                            borderColor: 'rgba(179,53,44,.35)', background: 'rgba(179,53,44,.05)',
                            display: 'flex', alignItems: 'center', gap: 16,
                        }}
                    >
                        <div style={{ color: 'var(--color-breach)' }}><Icon name="alert" size={24} /></div>
                        <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 700, fontSize: 15 }}>
                                {t.urgentTrack.outstanding} urgent-track grievance{t.urgentTrack.outstanding === 1 ? '' : 's'} outstanding
                            </div>
                            <div style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 3 }}>
                                Non-consensual imagery, impersonation, morphed images, or anything involving a minor.
                                24-hour action deadline.
                                {t.urgentTrack.breached > 0 && ` ${t.urgentTrack.breached} already past deadline.`}
                            </div>
                        </div>
                        <Icon name="chevron" size={18} />
                    </div>
                </Link>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(268px, 1fr))', gap: 16, marginBottom: 22 }}>
                <StatTile
                    href={t.kyc.href} label="KYC queue" value={t.kyc.open}
                    caption={t.kyc.open ? `Oldest ${t.kyc.oldestHours}h in queue` : 'Nothing waiting'}
                    tone={t.kyc.breachingTarget > 0 ? 'warning' : 'ok'}
                    note={t.kyc.breachingTarget > 0 ? `${t.kyc.breachingTarget} past the 12h target` : undefined}
                />
                <StatTile
                    href={t.grievances.href} label="Grievances" value={t.grievances.open}
                    caption={`${t.grievances.awaitingAcknowledgement} awaiting acknowledgement`}
                    tone={t.grievances.breached > 0 ? 'breach' : t.grievances.critical > 0 ? 'critical' : 'ok'}
                    note={t.grievances.breached > 0
                        ? `${t.grievances.breached} breached SLA`
                        : t.grievances.critical > 0 ? `${t.grievances.critical} near deadline` : undefined}
                />
                <StatTile
                    href={t.reports.href} label="Open reports" value={t.reports.open}
                    caption={`${t.reports.high} high · ${t.reports.medium} medium · ${t.reports.low} low`}
                    tone={t.reports.high > 0 ? 'critical' : 'ok'}
                />
                <StatTile
                    href={t.moderation.href} label="Moderation queue" value={t.moderation.open}
                    caption={`${t.moderation.newProfiles} new · ${t.moderation.edits} edits`}
                    tone={t.moderation.escalated > 0 ? 'breach' : 'ok'}
                    note={t.moderation.escalated > 0 ? `${t.moderation.escalated} escalated` : undefined}
                />
                <StatTile
                    href={t.payouts.href} label="Payouts" value={t.payouts.pending}
                    caption={`${rupees(t.payouts.pendingValuePaise)} pending`}
                    tone={t.payouts.failed > 0 ? 'critical' : t.payouts.held > 0 ? 'warning' : 'ok'}
                    note={[
                        t.payouts.failed ? `${t.payouts.failed} failed` : null,
                        t.payouts.held ? `${t.payouts.held} held` : null,
                    ].filter(Boolean).join(' · ') || undefined}
                />
                <StatTile
                    href={t.disputes.href} label="Bookings in dispute" value={t.disputes.open}
                    caption={t.disputes.windowClosing ? `${t.disputes.windowClosing} closing within 4h` : '24h windows open'}
                    tone={t.disputes.distressSignals > 0 ? 'breach' : t.disputes.windowClosing > 0 ? 'critical' : 'ok'}
                    note={t.disputes.distressSignals > 0 ? `${t.disputes.distressSignals} distress signal(s)` : undefined}
                />
                <StatTile
                    href={t.deletions.href} label="Deletion requests" value={t.deletions.pending}
                    caption={t.deletions.blocked ? `${t.deletions.blocked} blocked by open obligations` : 'None blocked'}
                    tone={t.deletions.blocked > 0 ? 'warning' : 'ok'}
                />
                <StatTile
                    href={t.adminActivity.href} label="Admin actions (24h)" value={t.adminActivity.total}
                    caption={Object.entries(t.adminActivity.byRole)
                        .map(([role, n]) => `${ROLE_LABELS[role] ?? role} ${n}`).join(' · ') || 'No activity'}
                    tone="neutral"
                />
            </div>

            {/* Blocking dependencies from §15 — visible rather than buried in a doc. */}
            {(!data.config.kycRetentionPolicyResolved || !data.config.taxModuleEnabled) && (
                <div style={{ marginBottom: 22 }}>
                    <Panel title="Blocked — needs a decision outside engineering">
                        <div style={{ display: 'grid', gap: 12 }}>
                            {!data.config.kycRetentionPolicyResolved && (
                                <Blocker
                                    title="KYC retention on account deletion is unresolved"
                                    detail="tryhive.in/privacy says KYC data is deleted on account deletion. tryhive.in/delete-account says it is retained up to 8 years for financial compliance. The deletion queue will defer any account holding KYC records until this is settled, because U-07 requires the record to state which basis applied."
                                />
                            )}
                            {!data.config.taxModuleEnabled && (
                                <Blocker
                                    title="Tax module gated on the CA consultation"
                                    detail="194-O TDS and GST TCS applicability is undecided, which blocks §8.3 entirely and blocks the v2.0 payout data model. Payouts written before this is answered cannot produce reconcilable Form 16A figures later."
                                />
                            )}
                        </div>
                    </Panel>
                </div>
            )}

            {isSuperAdmin && data.superAdmin && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                    <Panel title="PII unmask activity (24h)">
                        {data.superAdmin.unmaskVolume.length === 0 ? (
                            <p style={{ color: 'var(--muted-2)', fontSize: 13 }}>No personal data was unmasked today.</p>
                        ) : (
                            <table>
                                <tbody>
                                    {data.superAdmin.unmaskVolume.map((u: any) => (
                                        <tr key={u.adminId}>
                                            <td style={{ padding: '8px 0' }}>{u.email ?? u.adminId}</td>
                                            <td style={{ padding: '8px 0', textAlign: 'right' }}>
                                                <Pill tone={u.count >= 10 ? 'breach' : 'neutral'}>{u.count} unmasks</Pill>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </Panel>

                    <Panel title="Admin accounts">
                        <div style={{ display: 'grid', gap: 9, fontSize: 13 }}>
                            <Row label="Active" value={data.superAdmin.adminAccounts.active} />
                            <Row label="Pending 2FA enrolment" value={data.superAdmin.adminAccounts.pendingEnrolment} />
                            <Row label="Disabled" value={data.superAdmin.adminAccounts.disabled} />
                            <Row label="Live sessions" value={data.superAdmin.activeSessions} />
                            <Row label="Super Admins" value={data.superAdmin.adminAccounts.superAdmins} />
                        </div>
                        {data.superAdmin.breakGlassRisk && (
                            <div style={{
                                marginTop: 14, padding: 12, borderRadius: 'var(--radius-sm)',
                                background: 'rgba(179,53,44,.06)', border: '1px solid rgba(179,53,44,.24)',
                                fontSize: 12.5, lineHeight: 1.55,
                            }}>
                                <strong>Only one Super Admin.</strong> Resetting a lost 2FA device requires a
                                second Super Admin — with one, there is no recovery path short of touching the
                                database. Create a second one before go-live (PRD §12, open question 1).
                            </div>
                        )}
                    </Panel>
                </div>
            )}
        </>
    );
}

function greeting() {
    const h = new Date().getHours();
    if (h < 12) return 'morning';
    if (h < 17) return 'afternoon';
    return 'evening';
}

function StatTile({ href, label, value, caption, tone, note }: {
    href: string; label: string; value: number; caption: string; tone: string; note?: string;
}) {
    const accent = {
        breach: 'var(--color-breach)',
        critical: 'var(--color-critical)',
        warning: 'var(--color-warning)',
        ok: 'var(--color-ok)',
        neutral: 'var(--border-2)',
    }[tone] ?? 'var(--border-2)';

    return (
        <Link href={href}>
            <div className="panel" style={{ padding: 18, height: '100%', borderTop: `3px solid ${accent}` }}>
                <div className="eyebrow">{label}</div>
                <div style={{ fontSize: 32, fontWeight: 700, fontFamily: 'var(--font-display)', lineHeight: 1.15, marginTop: 6 }}>
                    {value}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>{caption}</div>
                {note && (
                    <div style={{ marginTop: 10 }}>
                        <Pill tone={tone}>{note}</Pill>
                    </div>
                )}
            </div>
        </Link>
    );
}

function Blocker({ title, detail }: { title: string; detail: string }) {
    return (
        <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
            <div style={{ color: 'var(--color-warning)', flexShrink: 0, marginTop: 1 }}><Icon name="alert" size={16} /></div>
            <div>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{title}</div>
                <div style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 3, lineHeight: 1.6 }}>{detail}</div>
            </div>
        </div>
    );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--muted)' }}>{label}</span>
            <strong>{value}</strong>
        </div>
    );
}
