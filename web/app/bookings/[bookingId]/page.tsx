'use client';

/**
 * Booking detail (PRD §7, B-02 … B-06).
 *
 * The timeline renders stages the booking never reached as gaps rather than
 * omitting them. "Paid, never checked in" is the shape of most disputes, and a
 * list that only shows what happened hides exactly the thing you are looking for.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { PiiField } from '@/components/MaskedValue';
import {
    PageHeader, Panel, Pill, Loading, ErrorNote, Icon, ReasonDialog, Field, FieldGrid, Toast,
} from '@/components/ui';
import { rupees, dateTime, dateOnly, titleCase } from '@/lib/format';

export default function BookingDetailPage() {
    const { bookingId } = useParams<{ bookingId: string }>();
    const { can } = useSession();
    const [data, setData] = useState<any>(null);
    const [reasons, setReasons] = useState<any[]>([]);
    const [piiReasons, setPiiReasons] = useState<any[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [dialog, setDialog] = useState<'complete' | 'cancel' | null>(null);
    const [busy, setBusy] = useState(false);
    const [toast, setToast] = useState<string | null>(null);

    const load = () => {
        setError(null);
        api<any>(`/bookings/${bookingId}`).then((r) => { setData(r.data); setReasons(r.data.forceReasons); }).catch((e) => setError(e.message));
    };

    useEffect(load, [bookingId]);
    useEffect(() => { api<any>('/pii/reasons').then((r) => setPiiReasons(r.data)).catch(() => {}); }, []);

    if (error) return <ErrorNote error={error} onRetry={load} />;
    if (!data) return <Loading rows={6} />;

    async function force(path: string, body: Record<string, unknown>) {
        setBusy(true);
        try {
            await api(`/bookings/${bookingId}/${path}`, { method: 'POST', body: { ...body, expectedVersion: data.version } });
            setToast(path === 'force-complete' ? 'Booking force-completed and logged.' : 'Booking cancelled; a refund is pending approval.');
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
                <Link href="/bookings" style={{ fontSize: 12.5, color: 'var(--muted)' }}>← Back to bookings</Link>
            </div>

            <PageHeader
                title={data.serviceTitle || 'Booking'}
                subtitle={`${data.bookingId} · ${dateOnly(data.selectedDate)} at ${data.selectedTime} · ${data.durationHours}h`}
            >
                <Pill tone={data.status === 'cancelled' ? 'breach' : data.status === 'completed' ? 'ok' : 'neutral'}>
                    {data.status}
                </Pill>
            </PageHeader>

            <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 18 }}>
                <div style={{ display: 'grid', gap: 18, alignContent: 'start' }}>
                    <Panel title="Timeline">
                        <div style={{ display: 'grid', gap: 0 }}>
                            {data.timeline.map((stage: any, i: number) => (
                                <div key={stage.id} style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 18 }}>
                                        <div style={{
                                            width: 10, height: 10, borderRadius: 999, flexShrink: 0, marginTop: 4,
                                            background: stage.reached ? 'var(--color-ok)' : 'transparent',
                                            border: stage.reached ? 'none' : '2px dashed var(--border-2)',
                                        }} />
                                        {i < data.timeline.length - 1 && (
                                            <div style={{
                                                width: 2, flex: 1, minHeight: 26,
                                                background: stage.reached ? 'var(--color-ok)' : 'var(--border)',
                                                opacity: stage.reached ? 0.35 : 1,
                                            }} />
                                        )}
                                    </div>
                                    <div style={{ paddingBottom: 16, flex: 1 }}>
                                        <div style={{ fontWeight: stage.reached ? 600 : 400, color: stage.reached ? 'var(--text)' : 'var(--muted-2)', fontSize: 13 }}>
                                            {stage.label}
                                        </div>
                                        <div style={{ fontSize: 11.5, color: 'var(--muted-2)', marginTop: 2 }}>
                                            {stage.reached ? dateTime(stage.at) : 'Never reached'}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </Panel>

                    {data.checkInFailure && (
                        <Panel title="Check-in failure">
                            <FieldGrid columns={2}>
                                <Field label="When">{dateTime(data.checkInFailure.at)}</Field>
                                <Field label="Reported by"><span className="mono">{data.checkInFailure.reportedBy}</span></Field>
                            </FieldGrid>
                            <div style={{ marginTop: 12 }}><Field label="Reason">{data.checkInFailure.reason}</Field></div>
                        </Panel>
                    )}

                    {data.noShowReports?.length > 0 && (
                        <Panel title={`No-show reports (${data.noShowReports.length})`}>
                            <div style={{ display: 'grid', gap: 12 }}>
                                {data.noShowReports.map((r: any, i: number) => (
                                    <div key={i} style={{ fontSize: 12.5 }}>
                                        <div style={{ color: 'var(--muted-2)', fontSize: 11, marginBottom: 3 }}>
                                            <span className="mono">{r.by}</span> · {dateTime(r.at)}
                                            {r.waitedMinutes != null && ` · waited ${r.waitedMinutes} min`}
                                        </div>
                                        {r.reason}
                                    </div>
                                ))}
                            </div>
                        </Panel>
                    )}

                    {data.dispute && (
                        <Panel title="Dispute">
                            <FieldGrid columns={3}>
                                <Field label="Category">{titleCase(data.dispute.category)}</Field>
                                <Field label="Status"><Pill tone={data.dispute.status === 'open' ? 'warning' : 'ok'}>{data.dispute.status}</Pill></Field>
                                <Field label="Opened">{dateTime(data.dispute.openedAt)}</Field>
                            </FieldGrid>
                            {data.dispute.blockSignal && (
                                <p style={{ marginTop: 12, fontSize: 12.5, color: 'var(--color-breach)', fontWeight: 600 }}>
                                    One party blocked the other while this booking was active — treat as a safety signal.
                                </p>
                            )}
                        </Panel>
                    )}
                </div>

                <div style={{ display: 'grid', gap: 18, alignContent: 'start' }}>
                    <Panel title="Parties">
                        <div style={{ display: 'grid', gap: 16 }}>
                            {data.seeker && (
                                <div>
                                    <div className="eyebrow" style={{ marginBottom: 7 }}>Seeker</div>
                                    <Link href={`/users/${encodeURIComponent(data.seeker.userId)}`} style={{ fontWeight: 600, textDecoration: 'underline' }}>
                                        {data.seeker.name ?? data.seeker.userId}
                                    </Link>
                                    <div style={{ marginTop: 7, display: 'grid', gap: 6 }}>
                                        <PiiField record={data.seeker} field="phone" recordType="user" recordId={data.seeker.userId} reasons={piiReasons} label="Phone" />
                                        <PiiField record={data.seeker} field="email" recordType="user" recordId={data.seeker.userId} reasons={piiReasons} label="Email" />
                                    </div>
                                </div>
                            )}
                            {data.companion && (
                                <div style={{ paddingTop: 16, borderTop: '1px solid var(--border)' }}>
                                    <div className="eyebrow" style={{ marginBottom: 7 }}>Companion</div>
                                    <Link href={`/users/${encodeURIComponent(data.companion.userId)}`} style={{ fontWeight: 600, textDecoration: 'underline' }}>
                                        {data.companion.name ?? data.companion.userId}
                                    </Link>
                                    <div style={{ marginTop: 5 }}>
                                        <Pill tone={data.companion.isKycVerified ? 'ok' : 'warning'}>
                                            {data.companion.isKycVerified ? 'KYC verified' : 'KYC not verified'}
                                        </Pill>
                                    </div>
                                </div>
                            )}
                        </div>
                    </Panel>

                    <Panel title="Money">
                        <div style={{ display: 'grid', gap: 8, fontSize: 13 }}>
                            <MoneyRow label="Base" value={rupees(data.baseAmount)} />
                            <MoneyRow label="Platform fee" value={rupees(data.platformFee)} />
                            <MoneyRow label="Total charged" value={rupees(data.totalAmount)} strong />
                        </div>
                        {data.relatedRefunds?.length > 0 && (
                            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                                <div className="eyebrow" style={{ marginBottom: 7 }}>Refunds</div>
                                {data.relatedRefunds.map((r: any) => (
                                    <div key={r.refundId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 5 }}>
                                        <span>{rupees(r.amount)} — {r.reasonLabel}</span>
                                        <Pill tone={r.status === 'approved' ? 'ok' : 'warning'}>{r.status.replace('_', ' ')}</Pill>
                                    </div>
                                ))}
                            </div>
                        )}
                    </Panel>

                    {can('booking:force') && !['completed', 'cancelled'].includes(data.status) && (
                        <Panel title="Force an outcome">
                            <p style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12, lineHeight: 1.55 }}>
                                Use these when the app could not close the booking itself — a failed check-in, or
                                both parties confirming out of band. Both need a reason and are logged.
                            </p>
                            <div style={{ display: 'grid', gap: 8 }}>
                                <button className="btn btn-ok" onClick={() => setDialog('complete')}>Force-complete</button>
                                <button className="btn btn-danger" onClick={() => setDialog('cancel')}>Force-cancel with refund</button>
                            </div>
                        </Panel>
                    )}
                </div>
            </div>

            {dialog === 'complete' && (
                <ReasonDialog
                    title="Force-complete this booking"
                    description="The booking is marked completed as though it had run normally. The companion becomes eligible for payout."
                    reasons={reasons} tone="ok" confirmLabel="Force-complete" busy={busy}
                    onCancel={() => setDialog(null)}
                    onConfirm={({ reasonCode, note }) => force('force-complete', { reasonCode, note })}
                />
            )}
            {dialog === 'cancel' && (
                <ReasonDialog
                    title="Force-cancel and refund"
                    description={`The booking is cancelled and a refund of ${rupees(data.totalAmount)} is raised. Refunds above the threshold need a second admin's approval before they are issued.`}
                    reasons={reasons} tone="danger" confirmLabel="Cancel and refund" busy={busy}
                    onCancel={() => setDialog(null)}
                    onConfirm={({ reasonCode, note }) => force('force-cancel', { reasonCode, note, refund: true })}
                />
            )}
            {toast && <Toast message={toast} onDone={() => setToast(null)} />}
        </>
    );
}

function MoneyRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
    return (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: strong ? 700 : 400 }}>
            <span style={{ color: strong ? 'var(--text)' : 'var(--muted)' }}>{label}</span>
            <span>{value}</span>
        </div>
    );
}
