'use client';

/**
 * Report queue (PRD §6.2).
 *
 * M-09 is the constraint that shapes this screen: the reporter is never named
 * anywhere the reported party could see, and the ticket says so on its face so
 * an admin composing a message does not have to remember the rule.
 *
 * The enforcement ladder is presented in order of severity with the consequence
 * of each rung spelled out. "Withhold payout" and "permanent removal" are one
 * click apart, and the difference matters to someone's income.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import {
    PageHeader, Panel, Pill, Loading, ErrorNote, Empty, Icon, Modal, Field, FieldGrid, Toast,
} from '@/components/ui';
import { relativeTime, dateTime, titleCase } from '@/lib/format';

const CONSEQUENCE: Record<string, string> = {
    warn: 'A formal warning is sent. Nothing else changes.',
    remove_content: 'Bio and photos are cleared from the profile.',
    temp_suspension: 'The account cannot be used until the suspension ends.',
    withhold_payout: 'Any pending payout for this companion is put on hold.',
    permanent_removal: 'The account is removed and the profile taken down.',
    law_enforcement: 'A Super Admin is alerted for referral. Nothing is sent automatically.',
};

export default function ReportsPage() {
    const { can } = useSession();
    const [severity, setSeverity] = useState('');
    const [list, setList] = useState<any>(null);
    const [selected, setSelected] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);
    const [acting, setActing] = useState(false);
    const [toast, setToast] = useState<string | null>(null);

    const load = () => {
        setError(null);
        api<any>(`/reports?status=open${severity ? `&severity=${severity}` : ''}`).then(setList).catch((e) => setError(e.message));
    };

    useEffect(load, [severity]);

    const open = async (reportId: string) => {
        setSelected(null);
        const res = await api<any>(`/reports/${reportId}`);
        setSelected(res.data);
    };

    return (
        <>
            <PageHeader
                title="Reports"
                subtitle="User reports, highest severity and oldest first. The reporter's identity is never disclosed to the reported party."
            >
                <select value={severity} onChange={(e) => setSeverity(e.target.value)} style={{ width: 150 }}>
                    <option value="">All severities</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                </select>
                <button className="btn" onClick={load}><Icon name="refresh" size={14} /></button>
            </PageHeader>

            {error && <ErrorNote error={error} onRetry={load} />}
            {!list && !error && <Panel><Loading /></Panel>}

            {list && (
                <Panel padded={false}>
                    {list.data.length === 0 ? (
                        <Empty message="No open reports" />
                    ) : (
                        <table>
                            <thead>
                                <tr>
                                    <th>Reported</th><th>Category</th><th>Severity</th>
                                    <th>Open for</th><th>Prior reports</th><th />
                                </tr>
                            </thead>
                            <tbody>
                                {list.data.map((r: any) => (
                                    <tr key={r.reportId} className={`clickable ${r.severity === 'high' ? 'row-breach' : r.severity === 'medium' ? 'row-warning' : ''}`} onClick={() => open(r.reportId)}>
                                        <td>
                                            <div style={{ fontWeight: 600 }}>{r.reportedUserName}</div>
                                            <div className="mono" style={{ color: 'var(--muted-2)' }}>{r.reportedUserId}</div>
                                        </td>
                                        <td>{titleCase(r.category)}</td>
                                        <td>
                                            <Pill tone={r.severity === 'high' ? 'breach' : r.severity === 'medium' ? 'warning' : 'neutral'}>
                                                {r.severity}
                                            </Pill>
                                        </td>
                                        <td>{r.hoursOpen}h</td>
                                        <td>{r.priorReportsAgainst > 0 ? <Pill tone="warning">{r.priorReportsAgainst}</Pill> : '—'}</td>
                                        <td style={{ textAlign: 'right' }}><Icon name="chevron" size={14} /></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </Panel>
            )}

            {selected && (
                <Modal title={`Report — ${titleCase(selected.category)}`} onClose={() => setSelected(null)} width={640}>
                    <div style={{
                        padding: '9px 13px', marginBottom: 16, borderRadius: 'var(--radius-sm)',
                        background: 'rgba(179,53,44,.05)', border: '1px solid rgba(179,53,44,.2)', fontSize: 12.5,
                    }}>
                        <strong>The reporter is never named to the reported party.</strong> Nothing you write in an
                        enforcement note is sent to them — the notice is composed by the platform.
                    </div>

                    <FieldGrid columns={2}>
                        <Field label="Reported party">
                            <Link href={`/users/${encodeURIComponent(selected.reportedUserId)}`} style={{ textDecoration: 'underline' }}>
                                {selected.reportedUserName}
                            </Link>
                        </Field>
                        <Field label="Filed">{dateTime(selected.createdAt)}</Field>
                        <Field label="Severity"><Pill tone={selected.severity === 'high' ? 'breach' : 'neutral'}>{selected.severity}</Pill></Field>
                        <Field label="Related booking">
                            {selected.relatedBooking ? (
                                <Link href={`/bookings/${selected.relatedBooking.bookingId}`} style={{ textDecoration: 'underline' }}>
                                    {selected.relatedBooking.bookingId}
                                </Link>
                            ) : '—'}
                        </Field>
                    </FieldGrid>

                    <div style={{ marginTop: 16 }}>
                        <Field label="What was reported">
                            <span style={{ lineHeight: 1.6 }}>{selected.detail}</span>
                        </Field>
                    </div>

                    {selected.history.length > 0 && (
                        <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
                            <div className="eyebrow" style={{ marginBottom: 9 }}>
                                Prior reports involving either party ({selected.history.length})
                            </div>
                            <div style={{ display: 'grid', gap: 7, fontSize: 12.5 }}>
                                {selected.history.slice(0, 6).map((h: any) => (
                                    <div key={h.reportId} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                                        <Pill tone="neutral">{titleCase(h.category)}</Pill>
                                        <span style={{ color: 'var(--muted-2)' }}>{relativeTime(h.createdAt)}</span>
                                        <span style={{ color: 'var(--muted)' }}>
                                            {h.reportedPartyWasThisUser ? 'same reported party' : 'same reporter'}
                                        </span>
                                        {h.outcome && <Pill tone="neutral">{titleCase(h.outcome)}</Pill>}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {can('report:action') && selected.status === 'open' && (
                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 22 }}>
                            <button className="btn" onClick={() => { setSelected(null); }}>Close</button>
                            <button className="btn btn-primary" onClick={() => setActing(true)}>Take action</button>
                        </div>
                    )}
                </Modal>
            )}

            {acting && selected && (
                <EnforcementDialog
                    report={selected}
                    onClose={() => setActing(false)}
                    onDone={(message) => { setActing(false); setSelected(null); load(); setToast(message); }}
                />
            )}

            {toast && <Toast message={toast} onDone={() => setToast(null)} />}
        </>
    );
}

function EnforcementDialog({ report, onClose, onDone }: { report: any; onClose: () => void; onDone: (m: string) => void }) {
    const [actionId, setActionId] = useState('');
    const [note, setNote] = useState('');
    const [days, setDays] = useState(7);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const action = report.enforcementActions.find((a: any) => a.id === actionId);
    const valid = !!actionId && note.trim().length >= 10;

    async function submit(dismiss = false) {
        setBusy(true);
        setError(null);
        try {
            if (dismiss) {
                await api(`/reports/${report.reportId}/dismiss`, {
                    method: 'POST', body: { note, expectedVersion: report.version },
                });
                onDone('Report dismissed.');
            } else {
                await api(`/reports/${report.reportId}/act`, {
                    method: 'POST',
                    body: { actionId, note, suspensionDays: actionId === 'temp_suspension' ? days : undefined, expectedVersion: report.version },
                });
                onDone(`${action.label} applied and logged.`);
            }
        } catch (err: any) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal title="Enforcement" onClose={onClose} width={520}>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 16 }}>
                Pick the rung that fits. Every action is recorded against your name with the reason below,
                and the reported party is sent a notice that does not identify the reporter.
            </p>

            <div style={{ display: 'grid', gap: 7, marginBottom: 16 }}>
                {report.enforcementActions.map((a: any) => (
                    <label
                        key={a.id}
                        style={{
                            display: 'flex', gap: 11, alignItems: 'flex-start', cursor: 'pointer', margin: 0,
                            padding: '10px 12px', borderRadius: 'var(--radius-sm)',
                            border: `1px solid ${actionId === a.id ? 'var(--color-accent)' : 'var(--border)'}`,
                            background: actionId === a.id ? 'var(--accent-soft)' : 'transparent',
                        }}
                    >
                        <input
                            type="radio" name="action" value={a.id} checked={actionId === a.id}
                            onChange={() => setActionId(a.id)} style={{ width: 'auto', marginTop: 2 }}
                        />
                        <span>
                            <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text)' }}>{a.label}</span>
                            <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2, fontWeight: 400 }}>
                                {CONSEQUENCE[a.id]}
                            </span>
                        </span>
                    </label>
                ))}
            </div>

            {actionId === 'temp_suspension' && (
                <div style={{ marginBottom: 16 }}>
                    <label htmlFor="days">Suspension length (days)</label>
                    <input id="days" type="number" min={1} max={365} value={days} onChange={(e) => setDays(Number(e.target.value))} />
                </div>
            )}

            <div style={{ marginBottom: 16 }}>
                <label htmlFor="note">Why this action, on this report? (required)</label>
                <textarea id="note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>

            {error && <p style={{ color: 'var(--color-breach)', fontSize: 12.5, marginBottom: 14 }}>{error}</p>}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
                <button className="btn" onClick={() => submit(true)} disabled={busy || note.trim().length < 10}>
                    Dismiss report
                </button>
                <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
                    <button className="btn btn-danger" onClick={() => submit(false)} disabled={!valid || busy}>
                        {busy ? 'Applying…' : action ? action.label : 'Apply'}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
