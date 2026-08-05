'use client';

/**
 * Grievance detail (PRD §6.3).
 *
 * The resolution form refuses to submit without reasoning, mirroring G-08 on the
 * server. That is intentional duplication: the server is the authority, and the
 * client saying so early is what stops someone typing "resolved" and being told
 * off by a 400 after they have closed the ticket in their head.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import {
    PageHeader, Panel, Pill, Loading, ErrorNote, Icon, Modal, Field, FieldGrid, Toast,
} from '@/components/ui';
import { dateTime, relativeTime, stateClass, titleCase } from '@/lib/format';

export default function GrievanceDetailPage() {
    const { grievanceId } = useParams<{ grievanceId: string }>();
    const { can, admin } = useSession();
    const [data, setData] = useState<any>(null);
    const [admins, setAdmins] = useState<any[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [dialog, setDialog] = useState<'resolve' | 'urgent' | 'note' | 'appeal' | null>(null);
    const [toast, setToast] = useState<string | null>(null);

    const load = () => {
        setError(null);
        api<any>(`/grievances/${grievanceId}`).then((r) => setData(r.data)).catch((e) => setError(e.message));
    };

    useEffect(load, [grievanceId]);
    useEffect(() => {
        api<any>('/admins').then((r) => setAdmins(r.data)).catch(() => setAdmins([]));
    }, []);

    if (error) return <ErrorNote error={error} onRetry={load} />;
    if (!data) return <Loading rows={6} />;

    const sla = data.sla;
    const open = !data.resolvedAt;

    async function assign(adminId: string) {
        try {
            await api(`/grievances/${grievanceId}/assign`, {
                method: 'POST',
                body: { assignedTo: adminId || null, expectedVersion: data.version },
            });
            load();
            setToast(adminId ? 'Assigned.' : 'Unassigned.');
        } catch (err: any) {
            setToast(err.message);
        }
    }

    return (
        <>
            <div style={{ marginBottom: 14 }}>
                <Link href="/grievances" style={{ fontSize: 12.5, color: 'var(--muted)' }}>← Back to grievances</Link>
            </div>

            <PageHeader
                title={data.reference}
                subtitle={`${titleCase(data.category)} · received via ${titleCase(data.channel)} ${relativeTime(data.receivedAt)}`}
            >
                {data.isUrgent && <Pill tone="breach">Urgent track — 24h</Pill>}
                {!open && <Pill tone="ok">Resolved</Pill>}
            </PageHeader>

            {/* G-03 / G-04 — the clocks, first, in colour. */}
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${data.isUrgent ? 3 : 2}, 1fr)`, gap: 14, marginBottom: 20 }}>
                <Clock title="Acknowledgement" commitment="Within 24 hours" clock={sla.acknowledgement} />
                {data.isUrgent && sla.urgentAction && (
                    <Clock title="Urgent action" commitment="Within 24 hours" clock={sla.urgentAction} />
                )}
                <Clock title="Resolution" commitment="Within 15 days" clock={sla.resolution} />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 18 }}>
                <div style={{ display: 'grid', gap: 18, alignContent: 'start' }}>
                    <Panel title="The complaint">
                        <p style={{ fontSize: 14, lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>{data.detail}</p>
                        <div style={{ marginTop: 18 }}>
                            <FieldGrid columns={2}>
                                <Field label="Complainant">
                                    {data.complainantName ?? data.complainantEmail ?? data.complainantUserId ?? 'Anonymous'}
                                    {!data.complainantUserId && (
                                        <div style={{ fontSize: 11, color: 'var(--muted-2)', marginTop: 2 }}>Not a Hive account</div>
                                    )}
                                </Field>
                                <Field label="Against">
                                    {data.againstUserId ? (
                                        <Link href={`/users/${encodeURIComponent(data.againstUserId)}`} style={{ textDecoration: 'underline' }}>
                                            {data.againstUserId}
                                        </Link>
                                    ) : '—'}
                                </Field>
                                <Field label="Received">{dateTime(data.receivedAt)}</Field>
                                <Field label="Entered">
                                    {dateTime(data.enteredAt)}
                                    {data.receivedAt !== data.enteredAt && (
                                        <div style={{ fontSize: 11, color: 'var(--muted-2)', marginTop: 2 }}>
                                            Backdated — SLA runs from receipt
                                        </div>
                                    )}
                                </Field>
                            </FieldGrid>
                        </div>
                    </Panel>

                    {data.resolution && (
                        <Panel title="Resolution">
                            <FieldGrid columns={3}>
                                <Field label="Outcome"><Pill tone={data.resolution.outcome === 'upheld' ? 'breach' : 'ok'}>{titleCase(data.resolution.outcome)}</Pill></Field>
                                <Field label="By">{data.resolution.byEmail}</Field>
                                <Field label="At">{dateTime(data.resolution.at)}</Field>
                            </FieldGrid>
                            <div style={{ marginTop: 14 }}>
                                <Field label="Reasoning">
                                    <span style={{ lineHeight: 1.6 }}>{data.resolution.reasoning}</span>
                                </Field>
                            </div>
                            <p style={{ marginTop: 12, fontSize: 11.5, color: 'var(--muted-2)' }}>
                                The complainant was sent this outcome and this reasoning.
                            </p>
                        </Panel>
                    )}

                    {data.urgentActionedAt && (
                        <Panel title="Urgent action taken">
                            <Field label={dateTime(data.urgentActionedAt)}>{data.urgentActionNote}</Field>
                        </Panel>
                    )}

                    {data.appeal && (
                        <Panel title="Appeal">
                            <FieldGrid columns={2}>
                                <Field label="Received">{dateTime(data.appeal.receivedAt)}</Field>
                                <Field label="Decision">
                                    {data.appeal.decidedAt ? <Pill tone="neutral">{data.appeal.decision}</Pill> : <Pill tone="warning">Open</Pill>}
                                </Field>
                            </FieldGrid>
                            <div style={{ marginTop: 12 }}><Field label="Grounds">{data.appeal.grounds}</Field></div>
                        </Panel>
                    )}

                    {data.relatedGrievances.length > 0 && (
                        <Panel title={`${data.relatedGrievances.length} related grievance(s)`}>
                            <div style={{ display: 'grid', gap: 9 }}>
                                {data.relatedGrievances.map((r: any) => (
                                    <Link key={r.grievanceId} href={`/grievances/${r.grievanceId}`}>
                                        <div style={{ display: 'flex', gap: 12, fontSize: 12.5, alignItems: 'center' }}>
                                            <span className="mono" style={{ fontWeight: 600 }}>{r.reference}</span>
                                            <span>{titleCase(r.category)}</span>
                                            <Pill tone={r.resolvedAt ? 'ok' : 'warning'}>{r.resolvedAt ? 'resolved' : 'open'}</Pill>
                                            <span style={{ color: 'var(--muted-2)', marginLeft: 'auto' }}>{relativeTime(r.receivedAt)}</span>
                                        </div>
                                    </Link>
                                ))}
                            </div>
                        </Panel>
                    )}
                </div>

                <div style={{ display: 'grid', gap: 18, alignContent: 'start' }}>
                    <Panel title="Assignment">
                        <label htmlFor="assignee">Owner</label>
                        <select
                            id="assignee" value={data.assignedTo ?? ''}
                            onChange={(e) => assign(e.target.value)}
                            disabled={!can('grievance:action')}
                        >
                            <option value="">Unassigned</option>
                            {admins.map((a) => <option key={a.adminId} value={a.adminId}>{a.name} — {a.email}</option>)}
                        </select>
                        {sla.assignment.state === 'breached' && (
                            <p style={{ marginTop: 10, fontSize: 12, color: 'var(--color-breach)', fontWeight: 600 }}>
                                {sla.assignment.label}
                            </p>
                        )}
                    </Panel>

                    {can('grievance:action') && (
                        <Panel title="Actions">
                            <div style={{ display: 'grid', gap: 8 }}>
                                {data.isUrgent && !data.urgentActionedAt && (
                                    <button className="btn btn-danger" onClick={() => setDialog('urgent')}>
                                        Record the 24-hour action
                                    </button>
                                )}
                                {open && (
                                    <button className="btn btn-primary" onClick={() => setDialog('resolve')}>Resolve</button>
                                )}
                                {!open && sla.appeal.open && !data.appeal && (
                                    <button className="btn" onClick={() => setDialog('appeal')}>Record an appeal</button>
                                )}
                                <button className="btn" onClick={() => setDialog('note')}>Add a note</button>
                            </div>
                            {!open && (
                                <p style={{ marginTop: 12, fontSize: 11.5, color: 'var(--muted-2)' }}>
                                    Appeal window {sla.appeal.open ? `closes in ${sla.appeal.remainingLabel}` : 'has closed'}.
                                </p>
                            )}
                        </Panel>
                    )}

                    {data.notes?.length > 0 && (
                        <Panel title="Notes">
                            <div style={{ display: 'grid', gap: 12 }}>
                                {data.notes.map((n: any, i: number) => (
                                    <div key={i} style={{ fontSize: 12.5 }}>
                                        <div style={{ color: 'var(--muted-2)', fontSize: 11, marginBottom: 3 }}>
                                            {n.byName} · {dateTime(n.at)}
                                        </div>
                                        {n.note}
                                    </div>
                                ))}
                            </div>
                        </Panel>
                    )}

                    <Panel title="Retention">
                        <p style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6 }}>
                            {sla.retention.purgeableAfter
                                ? `Retained until at least ${dateTime(sla.retention.purgeableAfter)} — 180 days from resolution.`
                                : 'Retention starts when this grievance is resolved: 180 days minimum.'}
                        </p>
                    </Panel>
                </div>
            </div>

            {dialog && (
                <ActionDialog
                    kind={dialog}
                    grievanceId={grievanceId}
                    version={data.version}
                    onClose={() => setDialog(null)}
                    onDone={(message) => { setDialog(null); load(); setToast(message); }}
                />
            )}
            {toast && <Toast message={toast} onDone={() => setToast(null)} />}
        </>
    );
}

function Clock({ title, commitment, clock }: { title: string; commitment: string; clock: any }) {
    const tone = stateClass(clock.state).replace('pill-', '');
    const accent = {
        breach: 'var(--color-breach)',
        critical: 'var(--color-critical)',
        warning: 'var(--color-warning)',
        ok: 'var(--color-ok)',
    }[tone] ?? 'var(--border-2)';

    return (
        <div className="panel" style={{ padding: 16, borderLeft: `3px solid ${accent}` }}>
            <div className="eyebrow">{title}</div>
            <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-display)', marginTop: 5, color: accent }}>
                {clock.label}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted-2)', marginTop: 4 }}>
                {commitment} · due {new Date(clock.deadline).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}
            </div>
        </div>
    );
}

function ActionDialog({ kind, grievanceId, version, onClose, onDone }: {
    kind: 'resolve' | 'urgent' | 'note' | 'appeal';
    grievanceId: string;
    version: number;
    onClose: () => void;
    onDone: (message: string) => void;
}) {
    const [outcome, setOutcome] = useState('');
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const config = {
        resolve: {
            title: 'Resolve this grievance',
            description: 'The complainant is sent the outcome and this reasoning. Both go into the regulatory export.',
            minLength: 20,
            label: 'Reasoning (required, at least 20 characters)',
        },
        urgent: {
            title: 'Record the 24-hour action',
            description: 'What was actually done — content removed, account suspended, referral made. This stops the urgent clock; the wider complaint stays open.',
            minLength: 10,
            label: 'What did you do?',
        },
        note: { title: 'Add a note', description: 'Visible to other admins on this ticket.', minLength: 1, label: 'Note' },
        appeal: {
            title: 'Record an appeal',
            description: 'The complainant has disputed the outcome within the 30-day window.',
            minLength: 10,
            label: 'Grounds for the appeal',
        },
    }[kind];

    async function submit() {
        setBusy(true);
        setError(null);
        try {
            if (kind === 'resolve') {
                await api(`/grievances/${grievanceId}/resolve`, {
                    method: 'POST',
                    body: { outcome, reasoning: text, expectedVersion: version },
                });
                onDone('Resolved. The complainant has been told the outcome and the reason.');
            } else if (kind === 'urgent') {
                await api(`/grievances/${grievanceId}/urgent-action`, {
                    method: 'POST',
                    body: { note: text, expectedVersion: version },
                });
                onDone('Urgent action recorded.');
            } else if (kind === 'note') {
                await api(`/grievances/${grievanceId}/note`, { method: 'POST', body: { note: text } });
                onDone('Note added.');
            } else {
                await api(`/grievances/${grievanceId}/appeal`, { method: 'POST', body: { grounds: text } });
                onDone('Appeal recorded.');
            }
        } catch (err: any) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }

    const valid = text.trim().length >= config.minLength && (kind !== 'resolve' || !!outcome);

    return (
        <Modal title={config.title} onClose={onClose}>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 16 }}>{config.description}</p>

            {kind === 'resolve' && (
                <div style={{ marginBottom: 14 }}>
                    <label htmlFor="outcome">Outcome</label>
                    <select id="outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                        <option value="">Choose…</option>
                        <option value="upheld">Upheld — the complaint was justified</option>
                        <option value="partially_upheld">Partially upheld</option>
                        <option value="not_upheld">Not upheld</option>
                        <option value="no_action_required">No action required</option>
                    </select>
                </div>
            )}

            <div style={{ marginBottom: 16 }}>
                <label htmlFor="text">{config.label}</label>
                <textarea id="text" rows={5} value={text} onChange={(e) => setText(e.target.value)} />
                {text.length > 0 && text.trim().length < config.minLength && (
                    <p style={{ marginTop: 6, fontSize: 12, color: 'var(--muted-2)' }}>
                        {config.minLength - text.trim().length} more character(s) needed.
                    </p>
                )}
            </div>

            {error && <p style={{ color: 'var(--color-breach)', fontSize: 12.5, marginBottom: 14 }}>{error}</p>}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
                <button className="btn btn-primary" onClick={submit} disabled={!valid || busy}>
                    {busy ? 'Saving…' : 'Confirm'}
                </button>
            </div>
        </Modal>
    );
}
