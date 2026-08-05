'use client';

/**
 * User management and the deletion queue (PRD §9).
 *
 * The deletion tab leads with what is blocking each request rather than with the
 * request itself. U-06 exists because "why hasn't my account been deleted" is a
 * question with a specific answer — a pending payout, an open dispute — and that
 * answer should be on screen before anyone opens the record.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { PiiField } from '@/components/MaskedValue';
import {
    PageHeader, Panel, Pill, Loading, ErrorNote, Empty, Icon, Modal, Toast, Field,
} from '@/components/ui';
import { relativeTime, dateTime, titleCase } from '@/lib/format';

export default function UsersPage() {
    const { can } = useSession();
    const [tab, setTab] = useState<'search' | 'deletions'>('search');

    return (
        <>
            <PageHeader
                title="Users"
                subtitle="Search anyone by name, phone, email or ID. Contact details are masked for Support and every reveal is logged."
            >
                <div style={{ display: 'flex', gap: 6 }}>
                    <button className={`btn${tab === 'search' ? ' btn-primary' : ''}`} onClick={() => setTab('search')}>Search</button>
                    {can('deletion:process') && (
                        <button className={`btn${tab === 'deletions' ? ' btn-primary' : ''}`} onClick={() => setTab('deletions')}>
                            Deletion queue
                        </button>
                    )}
                </div>
            </PageHeader>

            {tab === 'search' ? <UserSearch /> : <DeletionQueue />}
        </>
    );
}

function UserSearch() {
    const [q, setQ] = useState('');
    const [role, setRole] = useState('');
    const [data, setData] = useState<any>(null);
    const [reasons, setReasons] = useState<any[]>([]);
    const [error, setError] = useState<string | null>(null);

    const load = () => {
        setError(null);
        const params = new URLSearchParams();
        if (q) params.set('q', q);
        if (role) params.set('role', role);
        api<any>(`/users?${params}`).then(setData).catch((e) => setError(e.message));
    };

    useEffect(load, []);
    useEffect(() => { api<any>('/pii/reasons').then((r) => setReasons(r.data)).catch(() => {}); }, []);

    return (
        <>
            <form onSubmit={(e) => { e.preventDefault(); load(); }} style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, phone, email or user ID" style={{ flex: 1 }} />
                <select value={role} onChange={(e) => setRole(e.target.value)} style={{ width: 150 }}>
                    <option value="">Everyone</option>
                    <option value="companion">Companions</option>
                    <option value="seeker">Seekers</option>
                </select>
                <button className="btn btn-primary"><Icon name="search" size={14} /> Search</button>
            </form>

            {error && <ErrorNote error={error} onRetry={load} />}
            {!data && !error && <Panel><Loading /></Panel>}

            {data && (
                <Panel padded={false}>
                    {data.data.length === 0 ? (
                        <Empty message="No users match" />
                    ) : (
                        <table>
                            <thead>
                                <tr><th>Name</th><th>Phone</th><th>Email</th><th>Type</th><th>Status</th><th>Joined</th><th /></tr>
                            </thead>
                            <tbody>
                                {data.data.map((u: any) => (
                                    <tr key={u.userId}>
                                        <td>
                                            <div style={{ fontWeight: 600 }}>{u.name ?? '—'}</div>
                                            <div className="mono" style={{ color: 'var(--muted-2)', fontSize: 11 }}>{u.userId}</div>
                                        </td>
                                        <td><PiiField record={u} field="phone" recordType="user" recordId={u.userId} reasons={reasons} /></td>
                                        <td><PiiField record={u} field="email" recordType="user" recordId={u.userId} reasons={reasons} /></td>
                                        <td>
                                            {u.isCompanion ? (
                                                <>
                                                    <Pill tone="accent">companion</Pill>
                                                    {u.isKycVerified === false && (
                                                        <div style={{ marginTop: 4 }}><Pill tone="warning">no KYC</Pill></div>
                                                    )}
                                                </>
                                            ) : <Pill tone="neutral">seeker</Pill>}
                                        </td>
                                        <td>
                                            <Pill tone={u.accountStatus === 'active' ? 'ok' : u.accountStatus === 'suspended' ? 'warning' : 'breach'}>
                                                {u.accountStatus}
                                            </Pill>
                                        </td>
                                        <td style={{ fontSize: 12, color: 'var(--muted)' }}>{relativeTime(u.createdAt)}</td>
                                        <td style={{ textAlign: 'right' }}>
                                            <Link href={`/users/${encodeURIComponent(u.userId)}`}>
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

function DeletionQueue() {
    const [data, setData] = useState<any>(null);
    const [selected, setSelected] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);
    const [toast, setToast] = useState<string | null>(null);

    const load = () => {
        setError(null);
        api<any>('/users/deletions').then(setData).catch((e) => setError(e.message));
    };

    useEffect(load, []);

    const open = async (requestId: string) => {
        const res = await api<any>(`/users/deletions/${requestId}`);
        setSelected(res.data);
    };

    if (error) return <ErrorNote error={error} onRetry={load} />;
    if (!data) return <Panel><Loading /></Panel>;

    return (
        <>
            {!data.meta.kycPolicyResolved && (
                <div className="panel" style={{
                    padding: 16, marginBottom: 18,
                    borderColor: 'rgba(217,149,91,.35)', background: 'rgba(217,149,91,.05)',
                }}>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                        <span style={{ color: 'var(--color-warning)', marginTop: 1 }}><Icon name="alert" size={18} /></span>
                        <div style={{ fontSize: 12.5, lineHeight: 1.6 }}>
                            <strong>KYC retention is unresolved.</strong> tryhive.in/privacy says KYC data is deleted
                            on account deletion; tryhive.in/delete-account says it is retained up to 8 years for
                            financial compliance. Any deletion involving a KYC record will refuse to complete until
                            this is settled — U-07 requires the record to state which basis applied, and there is no
                            correct answer to record yet.
                        </div>
                    </div>
                </div>
            )}

            <Panel padded={false}>
                {data.data.length === 0 ? (
                    <Empty message="No deletion requests pending" />
                ) : (
                    <table>
                        <thead>
                            <tr><th>User</th><th>Requested</th><th>Waiting</th><th>Blockers</th><th /></tr>
                        </thead>
                        <tbody>
                            {data.data.map((d: any) => (
                                <tr key={d.requestId} className={d.blocked ? 'row-warning' : ''}>
                                    <td>
                                        <div style={{ fontWeight: 600 }}>{d.userName}</div>
                                        <div className="mono" style={{ color: 'var(--muted-2)', fontSize: 11 }}>{d.userId}</div>
                                    </td>
                                    <td style={{ fontSize: 12 }}>{dateTime(d.requestedAt)}</td>
                                    <td>{d.daysWaiting}d</td>
                                    <td>
                                        {d.blocked ? (
                                            <div style={{ display: 'grid', gap: 4 }}>
                                                {d.blockers.map((b: any) => (
                                                    <Pill key={b.type} tone="warning">{b.detail}</Pill>
                                                ))}
                                            </div>
                                        ) : <Pill tone="ok">Clear to process</Pill>}
                                    </td>
                                    <td style={{ textAlign: 'right' }}>
                                        <button className="btn btn-sm" onClick={() => open(d.requestId)}>Review</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </Panel>

            {selected && (
                <DeletionDialog
                    request={selected}
                    onClose={() => setSelected(null)}
                    onDone={(m) => { setSelected(null); load(); setToast(m); }}
                />
            )}
            {toast && <Toast message={toast} onDone={() => setToast(null)} />}
        </>
    );
}

/** U-07 — what gets deleted, what gets kept, and under what basis. */
function DeletionDialog({ request, onClose, onDone }: { request: any; onClose: () => void; onDone: (m: string) => void }) {
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function process() {
        setBusy(true);
        setError(null);
        try {
            await api(`/users/deletions/${request.requestId}/process`, { method: 'POST', body: { note } });
            onDone('Deletion processed and the retention record written.');
        } catch (err: any) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }

    const unresolved = request.unresolvedPolicyItems ?? [];

    return (
        <Modal title={`Delete ${request.userName}'s account`} onClose={onClose} width={620}>
            {request.blocked && (
                <div style={{
                    padding: '11px 14px', marginBottom: 16, borderRadius: 'var(--radius-sm)',
                    background: 'rgba(217,149,91,.08)', border: '1px solid rgba(217,149,91,.3)', fontSize: 12.5,
                }}>
                    <strong>Blocked.</strong> This deletion cannot proceed yet:
                    <ul style={{ margin: '7px 0 0 18px', display: 'grid', gap: 4 }}>
                        {request.blockers.map((b: any) => <li key={b.type}>{b.detail}</li>)}
                    </ul>
                </div>
            )}

            {unresolved.length > 0 && (
                <div style={{
                    padding: '11px 14px', marginBottom: 16, borderRadius: 'var(--radius-sm)',
                    background: 'rgba(179,53,44,.06)', border: '1px solid rgba(179,53,44,.28)', fontSize: 12.5, lineHeight: 1.6,
                }}>
                    <strong>Retention policy unresolved.</strong> {unresolved[0].detail}
                </div>
            )}

            <div className="eyebrow" style={{ marginBottom: 10 }}>Retention plan</div>
            <table style={{ marginBottom: 18 }}>
                <thead><tr><th>Data</th><th style={{ width: 110 }}>Action</th><th>Basis</th></tr></thead>
                <tbody>
                    {request.retentionPlan.map((r: any) => (
                        <tr key={r.item}>
                            <td style={{ fontSize: 12.5 }}>{r.item}</td>
                            <td>
                                <Pill tone={r.action === 'delete' ? 'ok' : r.action === 'unresolved' ? 'breach' : 'neutral'}>
                                    {r.action}
                                </Pill>
                            </td>
                            <td style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                                {r.basis ? titleCase(r.basis) : '—'}
                                {r.detail && r.action === 'unresolved' && (
                                    <div style={{ color: 'var(--color-breach)', marginTop: 3 }}>{r.detail}</div>
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>

            <div style={{ marginBottom: 16 }}>
                <label htmlFor="note">Note</label>
                <textarea id="note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>

            {error && <p style={{ color: 'var(--color-breach)', fontSize: 12.5, marginBottom: 14 }}>{error}</p>}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn" onClick={onClose} disabled={busy}>Close</button>
                <button
                    className="btn btn-danger"
                    onClick={process}
                    disabled={busy || request.blocked || unresolved.length > 0}
                >
                    {busy ? 'Processing…' : 'Process deletion'}
                </button>
            </div>
        </Modal>
    );
}
