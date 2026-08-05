'use client';

/**
 * Bookings and disputes (PRD §7).
 *
 * Two tabs on one screen because they are the same investigation from different
 * ends: a dispute always leads to a booking, and a booking under scrutiny is
 * usually about to become one.
 *
 * B-09 rows lead the dispute list and are labelled as a safety signal rather
 * than as a category, because "block_during_active_booking" tells an operator
 * nothing about how quickly to act.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import {
    PageHeader, Panel, Pill, Loading, ErrorNote, Empty, Icon, Modal, Toast,
} from '@/components/ui';
import { rupees, relativeTime, dateOnly, duration, titleCase } from '@/lib/format';

export default function BookingsPage() {
    const [tab, setTab] = useState<'bookings' | 'disputes'>('disputes');

    return (
        <>
            <PageHeader
                title="Bookings"
                subtitle="Search any booking, walk its timeline, and work the dispute queue while the 24-hour windows are still open."
            >
                <div style={{ display: 'flex', gap: 6 }}>
                    <button className={`btn${tab === 'disputes' ? ' btn-primary' : ''}`} onClick={() => setTab('disputes')}>Disputes</button>
                    <button className={`btn${tab === 'bookings' ? ' btn-primary' : ''}`} onClick={() => setTab('bookings')}>Search</button>
                </div>
            </PageHeader>

            {tab === 'disputes' ? <Disputes /> : <BookingSearch />}
        </>
    );
}

function Disputes() {
    const { can } = useSession();
    const [data, setData] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);
    const [resolving, setResolving] = useState<any>(null);
    const [toast, setToast] = useState<string | null>(null);

    const load = () => {
        setError(null);
        api<any>('/bookings/disputes').then(setData).catch((e) => setError(e.message));
    };

    useEffect(load, []);

    if (error) return <ErrorNote error={error} onRetry={load} />;
    if (!data) return <Panel><Loading /></Panel>;

    return (
        <>
            {data.meta.distressSignals > 0 && (
                <div className="panel" style={{
                    padding: 16, marginBottom: 18, display: 'flex', gap: 13, alignItems: 'center',
                    borderColor: 'rgba(179,53,44,.35)', background: 'rgba(179,53,44,.05)',
                }}>
                    <span style={{ color: 'var(--color-breach)' }}><Icon name="alert" size={20} /></span>
                    <div style={{ fontSize: 13 }}>
                        <strong>{data.meta.distressSignals} distress signal(s).</strong> Someone blocked the other
                        party while a booking was active. Treat these as a safety matter, not a dispute.
                    </div>
                </div>
            )}

            <Panel padded={false}>
                {data.data.length === 0 ? (
                    <Empty message="No open disputes" />
                ) : (
                    <table>
                        <thead>
                            <tr><th>Booking</th><th>Raised by</th><th>Category</th><th>24h window</th><th /></tr>
                        </thead>
                        <tbody>
                            {data.data.map((d: any) => (
                                <tr key={d.disputeId} className={d.blockSignal ? 'row-urgent' : d.window.state === 'critical' ? 'row-critical' : ''}>
                                    <td>
                                        <Link href={`/bookings/${d.bookingId}`} style={{ fontWeight: 600, textDecoration: 'underline' }}>
                                            {d.bookingId}
                                        </Link>
                                        <div style={{ fontSize: 11, color: 'var(--muted-2)' }}>{relativeTime(d.openedAt)}</div>
                                    </td>
                                    <td className="mono">{d.raisedBy}</td>
                                    <td>
                                        {d.blockSignal
                                            ? <Pill tone="breach">Blocked mid-booking — safety signal</Pill>
                                            : <span>{titleCase(d.category)}</span>}
                                        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3, maxWidth: 320 }}>{d.detail}</div>
                                    </td>
                                    <td>
                                        <Pill tone={d.window.state === 'closed' ? 'breach' : d.window.state === 'critical' ? 'critical' : 'ok'}>
                                            {d.window.state === 'closed' ? 'Closed' : duration(d.window.remainingMs)}
                                        </Pill>
                                    </td>
                                    <td style={{ textAlign: 'right' }}>
                                        {can('booking:force') && (
                                            <button className="btn btn-sm" onClick={() => setResolving(d)}>Resolve</button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </Panel>

            {resolving && (
                <ResolveDisputeDialog
                    dispute={resolving}
                    onClose={() => setResolving(null)}
                    onDone={(m) => { setResolving(null); load(); setToast(m); }}
                />
            )}
            {toast && <Toast message={toast} onDone={() => setToast(null)} />}
        </>
    );
}

function ResolveDisputeDialog({ dispute, onClose, onDone }: { dispute: any; onClose: () => void; onDone: (m: string) => void }) {
    const [outcome, setOutcome] = useState('');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function submit() {
        setBusy(true);
        setError(null);
        try {
            await api(`/bookings/disputes/${dispute.disputeId}/resolve`, {
                method: 'POST',
                body: { outcome, note, expectedVersion: dispute.version },
            });
            onDone('Dispute resolved and logged.');
        } catch (err: any) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal title="Resolve dispute" onClose={onClose}>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 16 }}>
                Resolving records the decision. Any money movement is a separate, dual-approved action in Finance.
            </p>
            <div style={{ marginBottom: 14 }}>
                <label htmlFor="outcome">Outcome</label>
                <select id="outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                    <option value="">Choose…</option>
                    <option value="seeker_favoured">In the seeker's favour</option>
                    <option value="companion_favoured">In the companion's favour</option>
                    <option value="split">Split — both partly right</option>
                    <option value="no_action">No action required</option>
                </select>
            </div>
            <div style={{ marginBottom: 16 }}>
                <label htmlFor="note">Reasoning (required)</label>
                <textarea id="note" rows={4} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            {error && <p style={{ color: 'var(--color-breach)', fontSize: 12.5, marginBottom: 14 }}>{error}</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
                <button className="btn btn-primary" onClick={submit} disabled={busy || !outcome || note.trim().length < 10}>
                    {busy ? 'Saving…' : 'Resolve'}
                </button>
            </div>
        </Modal>
    );
}

function BookingSearch() {
    const [q, setQ] = useState('');
    const [status, setStatus] = useState('');
    const [data, setData] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);

    const load = () => {
        setError(null);
        const params = new URLSearchParams();
        if (q) params.set('q', q);
        if (status) params.set('status', status);
        api<any>(`/bookings?${params}`).then(setData).catch((e) => setError(e.message));
    };

    useEffect(load, []);

    return (
        <>
            <form
                onSubmit={(e) => { e.preventDefault(); load(); }}
                style={{ display: 'flex', gap: 10, marginBottom: 16 }}
            >
                <input
                    value={q} onChange={(e) => setQ(e.target.value)}
                    placeholder="Booking ID, user ID, companion name…"
                    style={{ flex: 1 }}
                />
                <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 150 }}>
                    <option value="">Any status</option>
                    <option value="pending">Pending</option>
                    <option value="confirmed">Confirmed</option>
                    <option value="completed">Completed</option>
                    <option value="cancelled">Cancelled</option>
                </select>
                <button className="btn btn-primary"><Icon name="search" size={14} /> Search</button>
            </form>

            {error && <ErrorNote error={error} onRetry={load} />}
            {!data && !error && <Panel><Loading /></Panel>}

            {data && (
                <Panel padded={false}>
                    {data.data.length === 0 ? (
                        <Empty message="No bookings match" />
                    ) : (
                        <table>
                            <thead>
                                <tr><th>Booking</th><th>Seeker</th><th>Companion</th><th>When</th><th>Amount</th><th>Status</th><th /></tr>
                            </thead>
                            <tbody>
                                {data.data.map((b: any) => (
                                    <tr key={b.bookingId}>
                                        <td className="mono">{b.bookingId}</td>
                                        <td className="mono" style={{ fontSize: 11.5 }}>{b.userId}</td>
                                        <td>{b.companionName}</td>
                                        <td>{dateOnly(b.selectedDate)} {b.selectedTime}</td>
                                        <td>{rupees(b.totalAmount)}</td>
                                        <td><Pill tone={b.status === 'cancelled' ? 'breach' : b.status === 'completed' ? 'ok' : 'neutral'}>{b.status}</Pill></td>
                                        <td style={{ textAlign: 'right' }}>
                                            <Link href={`/bookings/${b.bookingId}`}>
                                                <span className="btn btn-sm">Open</span>
                                            </Link>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </Panel>
            )}
        </>
    );
}
