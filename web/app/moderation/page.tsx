'use client';

/**
 * Moderation queue (PRD §6.1) with the diff review inline.
 *
 * The detail is a panel rather than a route because moderation is a rhythm: open,
 * read two fields, decide, next. A page navigation per item turns a five-second
 * decision into a fifteen-second one, and the queue is the thing that has to keep
 * moving.
 */

import React, { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import {
    PageHeader, Panel, Pill, Loading, ErrorNote, Empty, Icon, ReasonDialog, Toast,
} from '@/components/ui';
import { relativeTime, titleCase } from '@/lib/format';

export default function ModerationPage() {
    const { can } = useSession();
    const [type, setType] = useState('all');
    const [list, setList] = useState<any>(null);
    const [selected, setSelected] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);
    const [dialog, setDialog] = useState<'approve' | 'reject' | 'escalate' | null>(null);
    const [busy, setBusy] = useState(false);
    const [toast, setToast] = useState<string | null>(null);

    const load = () => {
        setError(null);
        api<any>(`/moderation?type=${type}`).then(setList).catch((e) => setError(e.message));
    };

    useEffect(load, [type]);

    const open = async (itemId: string) => {
        setSelected(null);
        const res = await api<any>(`/moderation/${itemId}`);
        setSelected(res.data);
    };

    async function act(path: string, body: Record<string, unknown>) {
        setBusy(true);
        try {
            const res = await api<any>(`/moderation/${selected.itemId}/${path}`, {
                method: 'POST',
                body: { ...body, expectedVersion: selected.version },
            });
            setToast(res.escalated
                ? 'Rejected and escalated to Super Admin.'
                : path === 'approve' ? 'Approved — the change is live.' : 'Recorded.');
            setSelected(null);
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
            <PageHeader
                title="Moderation"
                subtitle="New profiles and edits to already-approved ones. An edit does not go live until it is approved — the previously approved version stays published while it waits."
            >
                <select value={type} onChange={(e) => setType(e.target.value)} style={{ width: 175 }}>
                    <option value="all">All</option>
                    <option value="new_profile">New profiles</option>
                    <option value="profile_edit">Edits</option>
                </select>
                <button className="btn" onClick={load}><Icon name="refresh" size={14} /></button>
            </PageHeader>

            {error && <ErrorNote error={error} onRetry={load} />}
            {!list && !error && <Panel><Loading /></Panel>}

            {list && (
                <div style={{ display: 'grid', gridTemplateColumns: selected ? '380px 1fr' : '1fr', gap: 18, alignItems: 'start' }}>
                    <Panel padded={false}>
                        {list.data.length === 0 ? (
                            <Empty message="Nothing to moderate" />
                        ) : (
                            <table>
                                <thead>
                                    <tr><th>Companion</th><th>Type</th><th>Waiting</th>{!selected && <th />}</tr>
                                </thead>
                                <tbody>
                                    {list.data.map((item: any) => (
                                        <tr
                                            key={item.itemId}
                                            className={`clickable ${item.escalated ? 'row-breach' : item.hoursInQueue > 24 ? 'row-warning' : ''}`}
                                            onClick={() => open(item.itemId)}
                                            style={selected?.itemId === item.itemId ? { background: 'var(--accent-soft)' } : undefined}
                                        >
                                            <td>
                                                <div style={{ fontWeight: 600 }}>{item.userName}</div>
                                                {item.changedFields?.length > 0 && (
                                                    <div style={{ fontSize: 11, color: 'var(--muted-2)' }}>
                                                        {item.changedFields.join(', ')} changed
                                                    </div>
                                                )}
                                            </td>
                                            <td>
                                                <Pill tone={item.type === 'profile_edit' ? 'accent' : 'neutral'}>
                                                    {item.type === 'profile_edit' ? 'edit' : 'new'}
                                                </Pill>
                                                {item.escalated && <div style={{ marginTop: 4 }}><Pill tone="breach">escalated</Pill></div>}
                                            </td>
                                            <td>{item.hoursInQueue}h</td>
                                            {!selected && <td style={{ textAlign: 'right' }}><Icon name="chevron" size={14} /></td>}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </Panel>

                    {selected && (
                        <div style={{ display: 'grid', gap: 18 }}>
                            <Panel
                                title={`${selected.userName} — ${selected.type === 'profile_edit' ? 'proposed edit' : 'new profile'}`}
                                action={<button className="btn btn-sm" onClick={() => setSelected(null)}><Icon name="close" size={13} /></button>}
                            >
                                {selected.liveVersionRemainsPublished && (
                                    <div style={{
                                        padding: '9px 13px', marginBottom: 16, borderRadius: 'var(--radius-sm)',
                                        background: 'var(--accent-soft)', fontSize: 12.5,
                                    }}>
                                        The previously approved profile is still live. Rejecting this leaves it live;
                                        approving replaces it.
                                    </div>
                                )}

                                <div style={{ display: 'grid', gap: 16 }}>
                                    {selected.diff.filter((d: any) => selected.type === 'new_profile' || d.changed).map((d: any) => (
                                        <div key={d.field}>
                                            <div className="eyebrow" style={{ marginBottom: 6 }}>
                                                {titleCase(d.field)} {d.changed && <span style={{ color: 'var(--color-accent)' }}>· changed</span>}
                                            </div>
                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                                                <DiffSide label="Approved" value={d.previous} muted />
                                                <DiffSide label="Proposed" value={d.proposed} highlight={d.changed} />
                                            </div>
                                        </div>
                                    ))}
                                </div>

                                {(selected.reportsAgainstUser > 0 || selected.history.length > 0) && (
                                    <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--border)', fontSize: 12.5, color: 'var(--muted)' }}>
                                        {selected.reportsAgainstUser > 0 && (
                                            <div>{selected.reportsAgainstUser} report(s) filed against this companion.</div>
                                        )}
                                        {selected.history.length > 0 && (
                                            <div style={{ marginTop: 5 }}>
                                                {selected.history.length} previous moderation decision(s)
                                                {selected.history.some((h: any) => h.status === 'rejected') && ' — including a rejection'}.
                                            </div>
                                        )}
                                    </div>
                                )}
                            </Panel>

                            {can('moderation:decide') && selected.status === 'pending' && (
                                <div className="panel" style={{ padding: 16, display: 'flex', gap: 10, alignItems: 'center' }}>
                                    <div style={{ flex: 1, fontSize: 12.5, color: 'var(--muted)' }}>
                                        The companion is told the outcome and the reason.
                                    </div>
                                    <button className="btn" onClick={() => setDialog('escalate')}>Escalate</button>
                                    <button className="btn btn-danger" onClick={() => setDialog('reject')}>Reject</button>
                                    <button className="btn btn-ok" onClick={() => setDialog('approve')}>
                                        <Icon name="check" size={14} /> Approve
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            {dialog === 'approve' && (
                <ReasonDialog
                    title="Approve this profile"
                    description="The proposed version becomes the live one immediately."
                    tone="ok" confirmLabel="Approve" busy={busy}
                    onCancel={() => setDialog(null)}
                    onConfirm={({ note }) => act('approve', { note })}
                />
            )}
            {dialog === 'reject' && (
                <ReasonDialog
                    title="Reject this profile"
                    description="Reasons aligned to the Community Guidelines hard lines. Some escalate to Super Admin automatically."
                    reasons={selected?.rejectionReasons}
                    tone="danger" confirmLabel="Reject" busy={busy}
                    onCancel={() => setDialog(null)}
                    onConfirm={({ reasonCode, note }) => act('reject', { reasonCode, note })}
                />
            )}
            {dialog === 'escalate' && (
                <ReasonDialog
                    title="Escalate to Super Admin"
                    description="Use this when you are not sure. The item stays in the queue and a Super Admin is alerted."
                    confirmLabel="Escalate" requireNote noteMinLength={10} busy={busy}
                    onCancel={() => setDialog(null)}
                    onConfirm={({ note }) => act('escalate', { note })}
                />
            )}
            {toast && <Toast message={toast} onDone={() => setToast(null)} />}
        </>
    );
}

function DiffSide({ label, value, muted, highlight }: { label: string; value: any; muted?: boolean; highlight?: boolean }) {
    const text = value == null ? '—' : Array.isArray(value) ? value.join(', ') : String(value);
    const isImage = typeof value === 'string' && /^https?:\/\/.*\.(jpg|jpeg|png|webp)$/i.test(value);

    return (
        <div>
            <div style={{ fontSize: 10.5, color: 'var(--muted-2)', marginBottom: 4, letterSpacing: '.06em' }}>
                {label.toUpperCase()}
            </div>
            <div style={{
                fontSize: 13, lineHeight: 1.55, padding: '9px 11px', borderRadius: 'var(--radius-sm)',
                background: highlight ? 'var(--accent-soft)' : 'var(--bg)',
                color: muted ? 'var(--muted)' : 'var(--text)',
                border: highlight ? '1px solid rgba(201,106,61,.25)' : '1px solid transparent',
                wordBreak: 'break-word',
            }}>
                {isImage ? <span className="mono" style={{ fontSize: 11 }}>{text}</span> : text}
            </div>
        </div>
    );
}
