'use client';

/**
 * Grievance SLA queue (PRD §6.3).
 *
 * The screen exists to make three things unmissable:
 *
 *  G-04 — colour-coded escalation as deadlines approach, and a breach that
 *         cannot be mistaken for anything else.
 *  G-06 — urgent-track tickets stay in view whatever the filter says. When a
 *         filter would have hidden one, the server sends it anyway flagged
 *         `pinnedByUrgency`, and the row says so out loud rather than quietly
 *         appearing.
 *  G-11 — the export is a button here, not a script someone has to be asked to
 *         run, because the moment it is needed is the moment nobody has time.
 */

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { PageHeader, Panel, Pill, Loading, ErrorNote, Empty, Icon, Modal, Toast } from '@/components/ui';
import { relativeTime, stateClass, rowClass, titleCase } from '@/lib/format';

export default function GrievancesPage() {
    const { can } = useSession();
    const [filters, setFilters] = useState({ state: '', assignedTo: '', channel: '', includeResolved: false });
    const [data, setData] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);
    const [exporting, setExporting] = useState(false);
    const [logging, setLogging] = useState(false);
    const [toast, setToast] = useState<string | null>(null);

    const query = useMemo(() => {
        const params = new URLSearchParams();
        if (filters.state) params.set('state', filters.state);
        if (filters.assignedTo) params.set('assignedTo', filters.assignedTo);
        if (filters.channel) params.set('channel', filters.channel);
        if (filters.includeResolved) params.set('includeResolved', '1');
        return params.toString();
    }, [filters]);

    const load = () => {
        setError(null);
        api<any>(`/grievances?${query}`).then(setData).catch((e) => setError(e.message));
    };

    useEffect(load, [query]);

    return (
        <>
            <PageHeader
                title="Grievances"
                subtitle="Acknowledgement within 24 hours, resolution within 15 days, urgent categories actioned within 24 hours. These are the commitments published on tryhive.in/grievance-redressal."
            >
                {can('grievance:action') && (
                    <button className="btn" onClick={() => setLogging(true)}>Log a grievance</button>
                )}
                {can('grievance:export') && (
                    <button className="btn" onClick={() => setExporting(true)}>
                        <Icon name="download" size={14} /> Export
                    </button>
                )}
                <button className="btn" onClick={load}><Icon name="refresh" size={14} /></button>
            </PageHeader>

            {data && (
                <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
                    <Pill tone="neutral">{data.meta.open} open</Pill>
                    {data.meta.urgentOpen > 0 && <Pill tone="breach">{data.meta.urgentOpen} urgent track</Pill>}
                    {data.meta.breached > 0 && <Pill tone="breach">{data.meta.breached} breached</Pill>}
                    {data.meta.critical > 0 && <Pill tone="critical">{data.meta.critical} near deadline</Pill>}
                    {data.meta.unassignedFlagged > 0 && <Pill tone="warning">{data.meta.unassignedFlagged} unassigned over 4h</Pill>}
                    {data.meta.awaitingAcknowledgement > 0 && (
                        <Pill tone="warning">{data.meta.awaitingAcknowledgement} not yet acknowledged</Pill>
                    )}
                </div>
            )}

            <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                <select value={filters.state} onChange={(e) => setFilters({ ...filters, state: e.target.value })} style={{ width: 175 }}>
                    <option value="">All SLA states</option>
                    <option value="breached">Breached</option>
                    <option value="critical">Critical</option>
                    <option value="warning">Warning</option>
                    <option value="ok">On track</option>
                </select>
                <select value={filters.channel} onChange={(e) => setFilters({ ...filters, channel: e.target.value })} style={{ width: 160 }}>
                    <option value="">All channels</option>
                    <option value="in_app">In-app</option>
                    <option value="email">Email</option>
                    <option value="postal">Postal</option>
                </select>
                <select value={filters.assignedTo} onChange={(e) => setFilters({ ...filters, assignedTo: e.target.value })} style={{ width: 160 }}>
                    <option value="">Anyone</option>
                    <option value="unassigned">Unassigned</option>
                </select>
                <label style={{ display: 'flex', alignItems: 'center', gap: 7, margin: 0, cursor: 'pointer' }}>
                    <input
                        type="checkbox" checked={filters.includeResolved} style={{ width: 'auto' }}
                        onChange={(e) => setFilters({ ...filters, includeResolved: e.target.checked })}
                    />
                    Include resolved
                </label>
                <span style={{ fontSize: 11.5, color: 'var(--muted-2)', marginLeft: 'auto' }}>
                    Urgent-track tickets stay visible whatever is filtered.
                </span>
            </div>

            {error && <ErrorNote error={error} onRetry={load} />}
            {!data && !error && <Panel><Loading /></Panel>}

            {data && (
                <Panel padded={false}>
                    {data.data.length === 0 ? (
                        <Empty message="No grievances match" hint="Nothing outstanding on this filter." />
                    ) : (
                        <table>
                            <thead>
                                <tr>
                                    <th>Reference</th>
                                    <th>Category</th>
                                    <th>Received</th>
                                    <th>Acknowledge</th>
                                    <th>{'Resolve / action'}</th>
                                    <th>Assigned</th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                {data.data.map((g: any) => {
                                    const primary = g.isUrgent && g.sla.urgentAction ? g.sla.urgentAction : g.sla.resolution;
                                    return (
                                        <tr key={g.grievanceId} className={g.isUrgent ? 'row-urgent' : rowClass(g.sla.worstState)}>
                                            <td>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                                                    <span className="mono" style={{ fontWeight: 600 }}>{g.reference}</span>
                                                    {g.isUrgent && <Pill tone="breach">urgent</Pill>}
                                                </div>
                                                {g.pinnedByUrgency && (
                                                    <div style={{ fontSize: 10.5, color: 'var(--color-breach)', marginTop: 3, fontWeight: 600 }}>
                                                        Shown despite your filter — urgent items cannot be hidden
                                                    </div>
                                                )}
                                            </td>
                                            <td>
                                                <div>{titleCase(g.category)}</div>
                                                <div style={{ fontSize: 11, color: 'var(--muted-2)' }}>{titleCase(g.channel)}</div>
                                            </td>
                                            <td>
                                                <div>{relativeTime(g.receivedAt)}</div>
                                                {g.channel === 'postal' && (
                                                    <div style={{ fontSize: 10.5, color: 'var(--muted-2)' }}>from physical receipt</div>
                                                )}
                                            </td>
                                            <td><Pill tone={stateClass(g.sla.acknowledgement.state).replace('pill-', '')}>{g.sla.acknowledgement.label}</Pill></td>
                                            <td>
                                                <Pill tone={stateClass(primary.state).replace('pill-', '')}>{primary.label}</Pill>
                                                {g.isUrgent && g.sla.urgentAction && (
                                                    <div style={{ fontSize: 10.5, color: 'var(--muted-2)', marginTop: 3 }}>24h action deadline</div>
                                                )}
                                            </td>
                                            <td>
                                                {g.assignedToName ?? (
                                                    <Pill tone={g.sla.assignment.state === 'breached' ? 'breach' : 'neutral'}>
                                                        {g.sla.assignment.state === 'breached' ? 'Unassigned >4h' : 'Unassigned'}
                                                    </Pill>
                                                )}
                                            </td>
                                            <td style={{ textAlign: 'right' }}>
                                                <Link href={`/grievances/${g.grievanceId}`}>
                                                    <span className="btn btn-sm">Open <Icon name="chevron" size={12} /></span>
                                                </Link>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
                </Panel>
            )}

            {exporting && <ExportDialog onClose={() => setExporting(false)} onDone={(m) => { setExporting(false); setToast(m); }} />}
            {logging && <LogDialog onClose={() => setLogging(false)} onDone={() => { setLogging(false); load(); setToast('Grievance logged and acknowledged.'); }} />}
            {toast && <Toast message={toast} onDone={() => setToast(null)} />}
        </>
    );
}

/** G-11 — the answer to "how was this complaint handled". */
function ExportDialog({ onClose, onDone }: { onClose: () => void; onDone: (message: string) => void }) {
    const today = new Date().toISOString().slice(0, 10);
    const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const [from, setFrom] = useState(monthAgo);
    const [to, setTo] = useState(today);
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);

    async function run() {
        setBusy(true);
        try {
            const csv = await api<string>(
                `/grievances/export?from=${from}&to=${to}&format=csv&reason=${encodeURIComponent(reason)}`,
                { raw: true }
            );
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `hive-grievances-${from}-to-${to}.csv`;
            a.click();
            URL.revokeObjectURL(url);
            onDone('Export downloaded. The export itself was logged.');
        } catch (err: any) {
            onDone(err.message ?? 'Export failed');
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal title="Export grievance activity" onClose={onClose}>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 16 }}>
                Every grievance received in the range, with both SLA clocks, the outcome and the reasoning.
                This is what a regulator, court, or law-enforcement request is answered with.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
                <div>
                    <label htmlFor="from">From</label>
                    <input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                </div>
                <div>
                    <label htmlFor="to">To</label>
                    <input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                </div>
            </div>
            <div style={{ marginBottom: 18 }}>
                <label htmlFor="reason">What is this for?</label>
                <input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. MeitY request ref 2026/114" />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
                <button className="btn btn-primary" onClick={run} disabled={busy || !reason}>
                    {busy ? 'Preparing…' : 'Download CSV'}
                </button>
            </div>
        </Modal>
    );
}

/** G-01 / §12 — email and postal grievances are entered by hand, with the real
 *  receipt date. */
function LogDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
    const [form, setForm] = useState({
        channel: 'email', category: '', detail: '',
        complainantEmail: '', complainantName: '', againstUserId: '',
        receivedAt: '',
    });
    const [categories, setCategories] = useState<any>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        api<any>('/grievances/categories').then((r) => setCategories(r.data)).catch(() => {});
    }, []);

    const postal = form.channel === 'postal';

    async function submit() {
        setBusy(true);
        setError(null);
        try {
            await api('/grievances', {
                method: 'POST',
                body: {
                    ...form,
                    receivedAt: form.receivedAt ? new Date(form.receivedAt).toISOString() : undefined,
                    againstUserId: form.againstUserId || undefined,
                },
            });
            onDone();
        } catch (err: any) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal title="Log a grievance" onClose={onClose} width={560}>
            <div style={{ display: 'grid', gap: 14 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                        <label htmlFor="channel">Channel</label>
                        <select id="channel" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
                            {(categories?.channels ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.label}</option>)}
                        </select>
                    </div>
                    <div>
                        <label htmlFor="category">Category</label>
                        <select id="category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                            <option value="">Choose…</option>
                            {categories && (
                                <>
                                    <optgroup label="Urgent track — 24h action">
                                        {categories.urgent.map((c: any) => <option key={c.id} value={c.id}>{c.label}</option>)}
                                    </optgroup>
                                    <optgroup label="Standard">
                                        {categories.standard.map((c: any) => <option key={c.id} value={c.id}>{c.label}</option>)}
                                    </optgroup>
                                </>
                            )}
                        </select>
                    </div>
                </div>

                <div>
                    <label htmlFor="receivedAt">
                        {postal ? 'Physical receipt date (required)' : 'Received at (leave blank for now)'}
                    </label>
                    <input
                        id="receivedAt" type="datetime-local" value={form.receivedAt}
                        onChange={(e) => setForm({ ...form, receivedAt: e.target.value })}
                    />
                    {postal && (
                        <p style={{ fontSize: 11.5, color: 'var(--muted-2)', marginTop: 5 }}>
                            The 24-hour and 15-day clocks run from this date, not from when you type it in.
                        </p>
                    )}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                        <label htmlFor="cname">Complainant name</label>
                        <input id="cname" value={form.complainantName} onChange={(e) => setForm({ ...form, complainantName: e.target.value })} />
                    </div>
                    <div>
                        <label htmlFor="cemail">Complainant email</label>
                        <input id="cemail" type="email" value={form.complainantEmail} onChange={(e) => setForm({ ...form, complainantEmail: e.target.value })} />
                    </div>
                </div>
                <p style={{ fontSize: 11.5, color: 'var(--muted-2)', marginTop: -6 }}>
                    A complainant does not need a Hive account — an email address is enough.
                </p>

                <div>
                    <label htmlFor="against">Against (user ID, optional)</label>
                    <input id="against" value={form.againstUserId} onChange={(e) => setForm({ ...form, againstUserId: e.target.value })} placeholder="phone_+9198…" />
                </div>

                <div>
                    <label htmlFor="detail">What is the complaint?</label>
                    <textarea id="detail" rows={4} value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })} />
                </div>

                {error && <p style={{ color: 'var(--color-breach)', fontSize: 12.5 }}>{error}</p>}

                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
                    <button
                        className="btn btn-primary" onClick={submit}
                        disabled={busy || !form.category || form.detail.length < 10 || (postal && !form.receivedAt)}
                    >
                        {busy ? 'Logging…' : 'Log and acknowledge'}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
