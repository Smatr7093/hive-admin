'use client';

/**
 * User profile (PRD §9, U-02).
 *
 * Everything about one person on one screen: registration, verification state,
 * booking history, reports filed and received, moderation history, grievances.
 *
 * Note what is deliberately absent: reports this user *filed* are counted but the
 * people they were filed against are not listed. M-09 protects reporters, and a
 * support admin browsing an account should not be able to reconstruct who
 * complained about whom.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { PiiField } from '@/components/MaskedValue';
import {
    PageHeader, Panel, Pill, Loading, ErrorNote, Icon, ReasonDialog, Field, FieldGrid, Toast, Empty,
} from '@/components/ui';
import { rupees, dateTime, relativeTime, dateOnly, titleCase } from '@/lib/format';

export default function UserDetailPage() {
    const { userId } = useParams<{ userId: string }>();
    const decodedId = decodeURIComponent(userId);
    const { can, isSuperAdmin } = useSession();

    const [data, setData] = useState<any>(null);
    const [piiReasons, setPiiReasons] = useState<any[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [dialog, setDialog] = useState<'suspend' | 'unsuspend' | 'remove' | null>(null);
    const [busy, setBusy] = useState(false);
    const [toast, setToast] = useState<string | null>(null);

    const load = () => {
        setError(null);
        api<any>(`/users/${encodeURIComponent(decodedId)}`).then((r) => setData(r.data)).catch((e) => setError(e.message));
    };

    useEffect(load, [decodedId]);
    useEffect(() => { api<any>('/pii/reasons').then((r) => setPiiReasons(r.data)).catch(() => {}); }, []);

    if (error) return <ErrorNote error={error} onRetry={load} />;
    if (!data) return <Loading rows={6} />;

    const p = data.profile;

    async function act(path: string, body: Record<string, unknown>) {
        setBusy(true);
        try {
            await api(`/users/${encodeURIComponent(decodedId)}/${path}`, { method: 'POST', body });
            setToast('Done and logged.');
            setDialog(null);
            load();
        } catch (err: any) {
            setToast(err.message);
            setDialog(null);
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            <div style={{ marginBottom: 14 }}>
                <Link href="/users" style={{ fontSize: 12.5, color: 'var(--muted)' }}>← Back to users</Link>
            </div>

            <PageHeader
                title={p.name ?? decodedId}
                subtitle={`${p.isCompanion ? 'Companion' : 'Seeker'} · registered ${relativeTime(p.registeredAt)} · ${p.authProvider ?? 'unknown'} sign-in`}
            >
                <Pill tone={p.accountStatus === 'active' ? 'ok' : p.accountStatus === 'suspended' ? 'warning' : 'breach'}>
                    {p.accountStatus}
                </Pill>
                {p.isCompanion && (
                    <Pill tone={p.isKycVerified ? 'ok' : 'warning'}>
                        {p.isKycVerified ? 'KYC verified' : `KYC ${p.kycStatus ?? 'pending'}`}
                    </Pill>
                )}
            </PageHeader>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 18 }}>
                <div style={{ display: 'grid', gap: 18, alignContent: 'start' }}>
                    <Panel title="Account">
                        <FieldGrid columns={3}>
                            <PiiField record={p} field="phone" recordType="user" recordId={decodedId} reasons={piiReasons} label="Phone" />
                            <PiiField record={p} field="email" recordType="user" recordId={decodedId} reasons={piiReasons} label="Email" />
                            <Field label="User ID" mono>{decodedId}</Field>
                            <Field label="Registered">{dateTime(p.registeredAt)}</Field>
                            <Field label="Reliability score">{p.reliabilityScore ?? '—'}</Field>
                            {p.isCompanion && (
                                <PiiField record={p} field="upiId" recordType="user" recordId={decodedId} reasons={piiReasons} label="UPI ID" />
                            )}
                        </FieldGrid>
                        {p.accountStatus === 'suspended' && (
                            <div style={{
                                marginTop: 16, padding: '11px 14px', borderRadius: 'var(--radius-sm)',
                                background: 'rgba(217,149,91,.08)', fontSize: 12.5,
                            }}>
                                <strong>Suspended.</strong> {p.suspensionReason}
                                {p.suspendedUntil ? ` — until ${dateTime(p.suspendedUntil)}` : ' — indefinitely'}
                            </div>
                        )}
                    </Panel>

                    <Panel title={`Bookings (${data.bookings.asSeeker} as seeker, ${data.bookings.asCompanion} as companion)`} padded={false}>
                        {data.bookings.recent.length === 0 ? (
                            <Empty message="No bookings" />
                        ) : (
                            <table>
                                <thead><tr><th>Booking</th><th>Role</th><th>Date</th><th>Amount</th><th>Status</th></tr></thead>
                                <tbody>
                                    {data.bookings.recent.map((b: any) => (
                                        <tr key={b.bookingId}>
                                            <td>
                                                <Link href={`/bookings/${b.bookingId}`} className="mono" style={{ textDecoration: 'underline' }}>
                                                    {b.bookingId}
                                                </Link>
                                            </td>
                                            <td>{b.role}</td>
                                            <td>{dateOnly(b.selectedDate)}</td>
                                            <td>{rupees(b.totalAmount)}</td>
                                            <td><Pill tone={b.status === 'cancelled' ? 'breach' : b.status === 'completed' ? 'ok' : 'neutral'}>{b.status}</Pill></td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </Panel>

                    {data.kycHistory.length > 0 && (
                        <Panel title="KYC history" padded={false}>
                            <table>
                                <thead><tr><th>Attempt</th><th>Submitted</th><th>Status</th><th>Reason</th><th /></tr></thead>
                                <tbody>
                                    {data.kycHistory.map((k: any) => (
                                        <tr key={k.submissionId}>
                                            <td>{k.attemptNumber}</td>
                                            <td>{dateOnly(k.submittedAt)}</td>
                                            <td><Pill tone={k.status === 'approved' ? 'ok' : k.status === 'rejected' ? 'breach' : 'neutral'}>{k.status.replace('_', ' ')}</Pill></td>
                                            <td style={{ fontSize: 12 }}>{k.reasonCode ? titleCase(k.reasonCode) : '—'}</td>
                                            <td style={{ textAlign: 'right' }}>
                                                <Link href={`/kyc/${k.submissionId}`}><span className="btn btn-sm">Open</span></Link>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </Panel>
                    )}

                    {data.moderationHistory.length > 0 && (
                        <Panel title="Moderation history" padded={false}>
                            <table>
                                <thead><tr><th>Type</th><th>When</th><th>Outcome</th><th>Reason</th></tr></thead>
                                <tbody>
                                    {data.moderationHistory.map((m: any) => (
                                        <tr key={m.itemId}>
                                            <td>{titleCase(m.type)}</td>
                                            <td>{dateOnly(m.createdAt)}</td>
                                            <td><Pill tone={m.status === 'approved' ? 'ok' : m.status === 'rejected' ? 'breach' : 'neutral'}>{m.status}</Pill></td>
                                            <td style={{ fontSize: 12 }}>{m.reasonCode ? titleCase(m.reasonCode) : '—'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </Panel>
                    )}

                    {data.grievances.length > 0 && (
                        <Panel title="Grievances" padded={false}>
                            <table>
                                <thead><tr><th>Reference</th><th>Side</th><th>Category</th><th>Received</th><th>State</th></tr></thead>
                                <tbody>
                                    {data.grievances.map((g: any) => (
                                        <tr key={g.grievanceId} className={g.isUrgent ? 'row-urgent' : ''}>
                                            <td>
                                                <Link href={`/grievances/${g.grievanceId}`} className="mono" style={{ textDecoration: 'underline' }}>
                                                    {g.reference}
                                                </Link>
                                            </td>
                                            <td>{g.side}</td>
                                            <td>{titleCase(g.category)}</td>
                                            <td>{dateOnly(g.receivedAt)}</td>
                                            <td><Pill tone={g.resolvedAt ? 'ok' : 'warning'}>{g.resolvedAt ? 'resolved' : 'open'}</Pill></td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </Panel>
                    )}
                </div>

                <div style={{ display: 'grid', gap: 18, alignContent: 'start' }}>
                    <Panel title="Reports">
                        <div style={{ display: 'grid', gap: 10, fontSize: 13 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span style={{ color: 'var(--muted)' }}>Filed by this user</span>
                                <strong>{data.reports.filed}</strong>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span style={{ color: 'var(--muted)' }}>Received about this user</span>
                                <strong style={{ color: data.reports.received > 0 ? 'var(--color-breach)' : undefined }}>
                                    {data.reports.received}
                                </strong>
                            </div>
                        </div>
                        <p style={{ marginTop: 12, fontSize: 11.5, color: 'var(--muted-2)', lineHeight: 1.5 }}>
                            Who this user reported is not shown here — reporter identities are never linked back
                            through a profile view.
                        </p>
                    </Panel>

                    <Panel title="Contact-sharing attempts">
                        <p style={{ fontSize: 12.5, color: 'var(--muted-2)', lineHeight: 1.55 }}>
                            Not available — depends on v2.2 chat (U-08). This panel is here so it is clear the data
                            is pending rather than absent.
                        </p>
                    </Panel>

                    {(can('user:suspend') || isSuperAdmin) && (
                        <Panel title="Account actions">
                            <div style={{ display: 'grid', gap: 8 }}>
                                {p.accountStatus === 'suspended' ? (
                                    <button className="btn btn-ok" onClick={() => setDialog('unsuspend')}>Lift suspension</button>
                                ) : p.accountStatus === 'active' && (
                                    <button className="btn btn-danger" onClick={() => setDialog('suspend')}>Suspend</button>
                                )}
                                {isSuperAdmin && p.accountStatus !== 'removed' && (
                                    <button className="btn btn-danger" onClick={() => setDialog('remove')}>Remove permanently</button>
                                )}
                            </div>
                            <p style={{ marginTop: 12, fontSize: 11.5, color: 'var(--muted-2)', lineHeight: 1.5 }}>
                                Permanent removal is Super Admin only and is refused while the account has pending
                                payouts, open disputes or active bookings.
                            </p>
                        </Panel>
                    )}
                </div>
            </div>

            {dialog === 'suspend' && (
                <ReasonDialog
                    title="Suspend this account"
                    description="The user cannot sign in or be booked while suspended. They are told the account was actioned, without naming any reporter."
                    reasons={data.suspensionReasons ?? []}
                    tone="danger" confirmLabel="Suspend" busy={busy}
                    extra={<DurationField />}
                    onCancel={() => setDialog(null)}
                    onConfirm={({ reasonCode, note }) => {
                        const days = (document.getElementById('suspend-days') as HTMLInputElement)?.value;
                        return act('suspend', { reasonCode, note, durationDays: days ? Number(days) : undefined });
                    }}
                />
            )}
            {dialog === 'unsuspend' && (
                <ReasonDialog
                    title="Lift this suspension"
                    description="The account becomes usable again immediately."
                    tone="ok" confirmLabel="Lift suspension" requireNote noteMinLength={5} busy={busy}
                    onCancel={() => setDialog(null)}
                    onConfirm={({ note }) => act('unsuspend', { note })}
                />
            )}
            {dialog === 'remove' && (
                <ReasonDialog
                    title="Remove this account permanently"
                    description="The profile is taken down and the account cannot be recovered from this console. Financial and safety records are retained under their own basis."
                    tone="danger" confirmLabel="Remove permanently" requireNote noteMinLength={15} busy={busy}
                    onCancel={() => setDialog(null)}
                    onConfirm={({ note }) => act('remove', { note })}
                />
            )}
            {toast && <Toast message={toast} onDone={() => setToast(null)} />}
        </>
    );
}

function DurationField() {
    return (
        <div style={{ marginBottom: 14 }}>
            <label htmlFor="suspend-days">Duration in days (leave blank for indefinite)</label>
            <input id="suspend-days" type="number" min={1} max={365} placeholder="e.g. 7" />
        </div>
    );
}
