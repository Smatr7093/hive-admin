'use client';

/**
 * Audit log (PRD §10).
 *
 * Read-only by construction — there is no write path from this screen and no
 * update path anywhere in the system. The chain-integrity strip at the top is the
 * point of L-02: a mutable audit log is theatre, and being able to say "intact,
 * 412 entries, tip abc123" out loud is the difference between a log and evidence.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import {
    PageHeader, Panel, Pill, Loading, ErrorNote, Empty, Icon, Modal, Toast, Field, FieldGrid,
} from '@/components/ui';
import { dateTime, relativeTime, titleCase, ROLE_LABELS } from '@/lib/format';

export default function AuditPage() {
    const { can, isSuperAdmin } = useSession();
    const [filters, setFilters] = useState({ actorId: '', actionPrefix: '', targetId: '', from: '', to: '' });
    const [data, setData] = useState<any>(null);
    const [chain, setChain] = useState<any>(null);
    const [anomalies, setAnomalies] = useState<any>(null);
    const [admins, setAdmins] = useState<any[]>([]);
    const [selected, setSelected] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);
    const [exporting, setExporting] = useState(false);
    const [toast, setToast] = useState<string | null>(null);

    const load = () => {
        setError(null);
        const params = new URLSearchParams({ limit: '200' });
        Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v); });
        api<any>(`/audit?${params}`).then(setData).catch((e) => setError(e.message));
    };

    useEffect(load, [filters]);
    useEffect(() => {
        if (!isSuperAdmin) return;
        api<any>('/audit/verify').then((r) => setChain(r.data)).catch(() => {});
        api<any>('/audit/anomalies').then((r) => setAnomalies(r)).catch(() => {});
        api<any>('/admins').then((r) => setAdmins(r.data)).catch(() => {});
    }, [isSuperAdmin]);

    return (
        <>
            <PageHeader
                title="Audit log"
                subtitle="Every privileged action, with the actor, their role, the target, the reason and the before/after state. Append-only — nobody, including a Super Admin, can edit or delete an entry."
            >
                {can('audit:export') && (
                    <button className="btn" onClick={() => setExporting(true)}><Icon name="download" size={14} /> Export</button>
                )}
                <button className="btn" onClick={load}><Icon name="refresh" size={14} /></button>
            </PageHeader>

            {isSuperAdmin && chain && (
                <div className="panel" style={{
                    padding: '13px 17px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12,
                    borderColor: chain.intact ? 'rgba(107,142,95,.3)' : 'rgba(179,53,44,.35)',
                    background: chain.intact ? 'rgba(107,142,95,.05)' : 'rgba(179,53,44,.06)',
                }}>
                    <span style={{ color: chain.intact ? 'var(--color-ok)' : 'var(--color-breach)' }}>
                        <Icon name={chain.intact ? 'check' : 'alert'} size={17} />
                    </span>
                    <div style={{ flex: 1, fontSize: 13 }}>
                        {chain.intact ? (
                            <>
                                <strong>Chain intact.</strong> {chain.entries} entries verified end to end.
                                <span className="mono" style={{ color: 'var(--muted-2)', marginLeft: 8 }}>
                                    tip {String(chain.tip).slice(0, 16)}…
                                </span>
                            </>
                        ) : (
                            <>
                                <strong>Chain broken at entry {chain.brokenAt}.</strong> {chain.reason} — treat this
                                as an incident: entries were altered or removed at the storage layer.
                            </>
                        )}
                    </div>
                </div>
            )}

            {isSuperAdmin && anomalies?.data?.length > 0 && (
                <Panel title={`Anomalies in the last ${anomalies.meta.windowHours}h`}>
                    <div style={{ display: 'grid', gap: 10 }}>
                        {anomalies.data.map((a: any, i: number) => (
                            <div key={i} style={{ display: 'flex', gap: 11, alignItems: 'flex-start', fontSize: 13 }}>
                                <Pill tone={a.severity === 'critical' ? 'breach' : 'warning'}>{titleCase(a.kind)}</Pill>
                                <div>
                                    <strong>{a.email ?? a.adminId}</strong> — {a.detail}
                                </div>
                            </div>
                        ))}
                    </div>
                    <p style={{ marginTop: 14, fontSize: 11.5, color: 'var(--muted-2)', lineHeight: 1.55 }}>
                        These are advisory. Nothing is suspended automatically — a Super Admin looks and decides.
                        Who audits the Super Admin remains open question 5 in the PRD.
                    </p>
                </Panel>
            )}

            <div style={{ display: 'flex', gap: 10, margin: '18px 0 16px', flexWrap: 'wrap' }}>
                <select value={filters.actorId} onChange={(e) => setFilters({ ...filters, actorId: e.target.value })} style={{ width: 200 }}>
                    <option value="">Any admin</option>
                    {admins.map((a) => <option key={a.adminId} value={a.adminId}>{a.name}</option>)}
                </select>
                <select value={filters.actionPrefix} onChange={(e) => setFilters({ ...filters, actionPrefix: e.target.value })} style={{ width: 170 }}>
                    <option value="">All actions</option>
                    <option value="auth.">Authentication</option>
                    <option value="pii.">PII access</option>
                    <option value="document.">Document access</option>
                    <option value="kyc.">KYC</option>
                    <option value="moderation.">Moderation</option>
                    <option value="report.">Reports</option>
                    <option value="grievance.">Grievance</option>
                    <option value="booking.">Bookings</option>
                    <option value="payout.">Payouts</option>
                    <option value="refund.">Refunds</option>
                    <option value="user.">Users</option>
                    <option value="admin.">Admin accounts</option>
                </select>
                <input
                    value={filters.targetId} onChange={(e) => setFilters({ ...filters, targetId: e.target.value })}
                    placeholder="Target ID" style={{ width: 220 }}
                />
                <input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} style={{ width: 155 }} />
                <input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} style={{ width: 155 }} />
            </div>

            {error && <ErrorNote error={error} onRetry={load} />}
            {!data && !error && <Panel><Loading /></Panel>}

            {data && (
                <Panel padded={false}>
                    {data.data.length === 0 ? (
                        <Empty message="No entries match" />
                    ) : (
                        <table>
                            <thead>
                                <tr><th style={{ width: 60 }}>#</th><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Reason</th><th /></tr>
                            </thead>
                            <tbody>
                                {data.data.map((e: any) => (
                                    <tr key={e.eventId} className="clickable" onClick={() => setSelected(e)}>
                                        <td className="mono" style={{ color: 'var(--muted-2)' }}>{e.seq}</td>
                                        <td style={{ fontSize: 12 }}>
                                            {dateTime(e.at)}
                                            <div style={{ fontSize: 11, color: 'var(--muted-2)' }}>{relativeTime(e.at)}</div>
                                        </td>
                                        <td style={{ fontSize: 12 }}>
                                            {e.actorEmail ?? e.actorId ?? <span style={{ color: 'var(--muted-2)' }}>system</span>}
                                            {e.actorRole && (
                                                <div style={{ fontSize: 11, color: 'var(--muted-2)' }}>
                                                    {ROLE_LABELS[e.actorRole] ?? e.actorRole}
                                                </div>
                                            )}
                                        </td>
                                        <td>
                                            <span className="mono" style={{ fontSize: 11.5 }}>{e.action}</span>
                                        </td>
                                        <td className="mono" style={{ fontSize: 11, color: 'var(--muted-2)', maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                            {e.targetId ?? '—'}
                                        </td>
                                        <td style={{ fontSize: 12, maxWidth: 260 }}>{e.reason ?? '—'}</td>
                                        <td style={{ textAlign: 'right' }}><Icon name="chevron" size={13} /></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                    <div style={{ padding: '12px 16px', fontSize: 11.5, color: 'var(--muted-2)', borderTop: '1px solid var(--border)' }}>
                        Showing {data.data.length} of {data.meta.total}. Entries are retained for at least{' '}
                        {Math.round(data.meta.retentionDays / 365)} years.
                    </div>
                </Panel>
            )}

            {selected && (
                <Modal title={`Entry ${selected.seq} — ${selected.action}`} onClose={() => setSelected(null)} width={640}>
                    <FieldGrid columns={2}>
                        <Field label="When">{dateTime(selected.at)}</Field>
                        <Field label="Actor">{selected.actorEmail ?? 'system'}</Field>
                        <Field label="Role">{ROLE_LABELS[selected.actorRole] ?? selected.actorRole ?? '—'}</Field>
                        <Field label="IP" mono>{selected.ip ?? '—'}</Field>
                        <Field label="Target" mono>{selected.targetType ? `${selected.targetType}:${selected.targetId}` : '—'}</Field>
                        <Field label="Reason code">{selected.reasonCode ?? '—'}</Field>
                    </FieldGrid>

                    <div style={{ marginTop: 16 }}>
                        <Field label="Reason">{selected.reason ?? '—'}</Field>
                    </div>

                    {(selected.before || selected.after) && (
                        <div style={{ marginTop: 18, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                            <StateBlock label="Before" value={selected.before} />
                            <StateBlock label="After" value={selected.after} />
                        </div>
                    )}

                    {selected.metadata && (
                        <div style={{ marginTop: 16 }}>
                            <StateBlock label="Metadata" value={selected.metadata} />
                        </div>
                    )}

                    <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
                        <FieldGrid columns={1}>
                            <Field label="Entry hash" mono>{selected.entryHash}</Field>
                            <Field label="Previous hash" mono>{selected.previousHash}</Field>
                        </FieldGrid>
                        <p style={{ marginTop: 10, fontSize: 11.5, color: 'var(--muted-2)', lineHeight: 1.55 }}>
                            Each entry hashes its own content plus the hash before it. Altering or removing an entry
                            breaks every hash after it, which the chain check detects.
                        </p>
                    </div>

                    {selected.targetType && selected.targetId && (
                        <div style={{ marginTop: 16 }}>
                            <Link href={`/audit/target/${selected.targetType}/${encodeURIComponent(selected.targetId)}`}>
                                <span className="btn btn-sm">Everything that happened to this record</span>
                            </Link>
                        </div>
                    )}
                </Modal>
            )}

            {exporting && <ExportDialog onClose={() => setExporting(false)} onDone={(m) => { setExporting(false); setToast(m); }} />}
            {toast && <Toast message={toast} onDone={() => setToast(null)} />}
        </>
    );
}

function StateBlock({ label, value }: { label: string; value: any }) {
    return (
        <div>
            <div className="eyebrow" style={{ marginBottom: 6 }}>{label}</div>
            <pre className="mono" style={{
                margin: 0, padding: 11, background: 'var(--bg)', borderRadius: 'var(--radius-sm)',
                fontSize: 11.5, lineHeight: 1.5, overflowX: 'auto', maxHeight: 220,
            }}>
                {value == null ? '—' : JSON.stringify(value, null, 2)}
            </pre>
        </div>
    );
}

function ExportDialog({ onClose, onDone }: { onClose: () => void; onDone: (m: string) => void }) {
    const today = new Date().toISOString().slice(0, 10);
    const [from, setFrom] = useState(new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
    const [to, setTo] = useState(today);
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);

    async function run() {
        setBusy(true);
        try {
            const csv = await api<string>(
                `/audit/export?from=${from}&to=${to}&format=csv&reason=${encodeURIComponent(reason)}`,
                { raw: true }
            );
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `hive-audit-${from}-to-${to}.csv`;
            a.click();
            URL.revokeObjectURL(url);
            onDone('Exported. The export itself is now the newest entry in the log.');
        } catch (err: any) {
            onDone(err.message ?? 'Export failed');
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal title="Export the audit log" onClose={onClose}>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 16 }}>
                For a law-enforcement or regulatory request. The export is itself logged, with your reason.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
                <div><label htmlFor="from">From</label><input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
                <div><label htmlFor="to">To</label><input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
            </div>
            <div style={{ marginBottom: 18 }}>
                <label htmlFor="reason">What is this for?</label>
                <input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Police request ref CR/2026/882" />
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
