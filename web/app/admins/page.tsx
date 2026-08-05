'use client';

/**
 * Admin accounts and sessions (PRD §3, §12) — Super Admin only.
 *
 * The two incident-response actions live here and are deliberately one click
 * from the account row: revoking every session for a compromised admin, and
 * resetting a lost authenticator. When a laptop goes missing, nobody should be
 * hunting through a settings tree.
 *
 * The break-glass warning is shown whenever there is only one Super Admin,
 * because resetAdminMfa refuses to act on the caller's own account — with one
 * Super Admin and a lost phone, there is no recovery path from this console.
 */

import React, { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import {
    PageHeader, Panel, Pill, Loading, ErrorNote, Empty, Icon, Modal, ReasonDialog, Toast, Field, FieldGrid,
} from '@/components/ui';
import { dateTime, relativeTime, ROLE_LABELS } from '@/lib/format';

const ROLE_SUMMARY: Record<string, string> = {
    super_admin: 'Everything, including creating admins and assigning roles',
    ops: 'KYC, moderation, reports, disputes, suspensions — sees PII unmasked',
    support: 'Tickets and goodwill credits — PII masked by default',
    finance: 'Payouts, refunds, reconciliation, bank details',
    read_only: 'Dashboard counters only — no PII, no actions',
};

export default function AdminsPage() {
    const { admin: me } = useSession();
    const [admins, setAdmins] = useState<any[] | null>(null);
    const [sessions, setSessions] = useState<any[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [dialog, setDialog] = useState<{ kind: 'revoke' | 'reset' | 'disable' | 'enable'; target: any } | null>(null);
    const [created, setCreated] = useState<any>(null);
    const [busy, setBusy] = useState(false);
    const [toast, setToast] = useState<string | null>(null);

    const load = () => {
        setError(null);
        api<any>('/admins').then((r) => setAdmins(r.data)).catch((e) => setError(e.message));
        api<any>('/sessions').then((r) => setSessions(r.data)).catch(() => {});
    };

    useEffect(load, []);

    if (error) return <ErrorNote error={error} onRetry={load} />;
    if (!admins) return <Loading rows={5} />;

    const superAdmins = admins.filter((a) => a.role === 'super_admin' && a.status !== 'disabled');

    async function act(path: string, body: Record<string, unknown>, method = 'POST') {
        setBusy(true);
        try {
            await api(path, { method, body });
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
            <PageHeader
                title="Admin accounts"
                subtitle="Accounts are created here and nowhere else — there is no self-registration and no invite link that grants access on click. Every new account must bind an authenticator before it can do anything."
            >
                <button className="btn btn-primary" onClick={() => setCreating(true)}>Create an admin</button>
            </PageHeader>

            {superAdmins.length < 2 && (
                <div className="panel" style={{
                    padding: 16, marginBottom: 18,
                    borderColor: 'rgba(179,53,44,.32)', background: 'rgba(179,53,44,.05)',
                }}>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                        <span style={{ color: 'var(--color-breach)', marginTop: 1 }}><Icon name="alert" size={18} /></span>
                        <div style={{ fontSize: 12.5, lineHeight: 1.6 }}>
                            <strong>Only one active Super Admin.</strong> Resetting a lost 2FA device requires a
                            different Super Admin — a Super Admin cannot reset their own. With one, a lost phone
                            means no way back in short of editing the database directly. Create a second Super Admin
                            and write down the break-glass procedure before this goes live
                            (PRD §12, open question 1).
                        </div>
                    </div>
                </div>
            )}

            <Panel padded={false}>
                <table>
                    <thead>
                        <tr><th>Admin</th><th>Role</th><th>Status</th><th>2FA</th><th>Last sign-in</th><th>Sessions</th><th /></tr>
                    </thead>
                    <tbody>
                        {admins.map((a) => (
                            <tr key={a.adminId} className={a.status === 'disabled' ? '' : a.status === 'pending_enrolment' ? 'row-warning' : ''}>
                                <td>
                                    <div style={{ fontWeight: 600 }}>{a.name}</div>
                                    <div style={{ fontSize: 11.5, color: 'var(--muted-2)' }}>{a.email}</div>
                                </td>
                                <td>
                                    <select
                                        value={a.role}
                                        disabled={a.adminId === me?.adminId}
                                        onChange={(e) => act(`/admins/${a.adminId}/role`, { role: e.target.value, reason: 'Role changed from the admin console' }, 'PATCH')}
                                        style={{ width: 145, fontSize: 12 }}
                                    >
                                        {Object.entries(ROLE_LABELS).map(([id, label]) => (
                                            <option key={id} value={id}>{label}</option>
                                        ))}
                                    </select>
                                    <div style={{ fontSize: 10.5, color: 'var(--muted-2)', marginTop: 4, maxWidth: 210, lineHeight: 1.4 }}>
                                        {ROLE_SUMMARY[a.role]}
                                    </div>
                                </td>
                                <td>
                                    <Pill tone={a.status === 'active' ? 'ok' : a.status === 'disabled' ? 'breach' : 'warning'}>
                                        {a.status.replace('_', ' ')}
                                    </Pill>
                                </td>
                                <td>
                                    {a.mfaEnrolled
                                        ? <Pill tone="ok">enrolled</Pill>
                                        : <Pill tone="warning">not bound</Pill>}
                                </td>
                                <td style={{ fontSize: 12, color: 'var(--muted)' }}>
                                    {a.lastLoginAt ? relativeTime(a.lastLoginAt) : 'never'}
                                </td>
                                <td>
                                    {a.activeSessions > 0
                                        ? <Pill tone="accent">{a.activeSessions} live</Pill>
                                        : <span style={{ color: 'var(--muted-2)' }}>—</span>}
                                </td>
                                <td style={{ textAlign: 'right' }}>
                                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                                        {a.activeSessions > 0 && (
                                            <button className="btn btn-sm" onClick={() => setDialog({ kind: 'revoke', target: a })}>
                                                Revoke sessions
                                            </button>
                                        )}
                                        {a.adminId !== me?.adminId && a.mfaEnrolled && (
                                            <button className="btn btn-sm" onClick={() => setDialog({ kind: 'reset', target: a })}>
                                                Reset 2FA
                                            </button>
                                        )}
                                        {a.adminId !== me?.adminId && (
                                            <button
                                                className={`btn btn-sm${a.status === 'disabled' ? '' : ' btn-danger'}`}
                                                onClick={() => setDialog({ kind: a.status === 'disabled' ? 'enable' : 'disable', target: a })}
                                            >
                                                {a.status === 'disabled' ? 'Enable' : 'Disable'}
                                            </button>
                                        )}
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </Panel>

            {sessions && sessions.length > 0 && (
                <div style={{ marginTop: 22 }}>
                    <Panel title="Sessions" padded={false}>
                        <table>
                            <thead><tr><th>Admin</th><th>Started</th><th>Last seen</th><th>IP</th><th>State</th></tr></thead>
                            <tbody>
                                {sessions.slice(0, 25).map((s) => (
                                    <tr key={s.sessionId}>
                                        <td style={{ fontSize: 12.5 }}>{s.adminName ?? s.adminId}</td>
                                        <td style={{ fontSize: 12 }}>{dateTime(s.createdAt)}</td>
                                        <td style={{ fontSize: 12 }}>{relativeTime(s.lastSeenAt)}</td>
                                        <td className="mono" style={{ fontSize: 11 }}>{s.ip ?? '—'}</td>
                                        <td>
                                            {s.active
                                                ? <Pill tone="ok">live</Pill>
                                                : <Pill tone="neutral">{s.revokeReason ?? 'ended'}</Pill>}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </Panel>
                </div>
            )}

            {creating && (
                <CreateDialog
                    onClose={() => setCreating(false)}
                    onDone={(result) => { setCreating(false); setCreated(result); load(); }}
                />
            )}

            {created && (
                <Modal title="Admin account created" onClose={() => setCreated(null)}>
                    <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 16 }}>
                        Give this password to {created.data.name} out of band — not by email to the address you just
                        registered. They will be asked to bind an authenticator on their first sign-in and cannot do
                        anything until they have.
                    </p>
                    <FieldGrid columns={2}>
                        <Field label="Email">{created.data.email}</Field>
                        <Field label="Role">{ROLE_LABELS[created.data.role]}</Field>
                    </FieldGrid>
                    {created.temporaryPassword && (
                        <div style={{ marginTop: 16 }}>
                            <div className="eyebrow" style={{ marginBottom: 5 }}>Temporary password — shown once</div>
                            <div className="mono" style={{
                                padding: 12, background: 'var(--bg)', borderRadius: 'var(--radius-sm)',
                                fontSize: 14, wordBreak: 'break-all',
                            }}>
                                {created.temporaryPassword}
                            </div>
                        </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
                        <button className="btn btn-primary" onClick={() => setCreated(null)}>I have copied it</button>
                    </div>
                </Modal>
            )}

            {dialog?.kind === 'revoke' && (
                <ReasonDialog
                    title={`Revoke every session for ${dialog.target.name}`}
                    description="Every device signed in as this admin is signed out immediately. Use this the moment a laptop or phone is reported lost."
                    tone="danger" confirmLabel="Revoke all sessions" requireNote noteMinLength={5} busy={busy}
                    onCancel={() => setDialog(null)}
                    onConfirm={({ note }) => act(`/admins/${dialog.target.adminId}/revoke-sessions`, { reason: note })}
                />
            )}
            {dialog?.kind === 'reset' && (
                <ReasonDialog
                    title={`Reset 2FA for ${dialog.target.name}`}
                    description="Their authenticator and recovery codes are cleared and every session ends. They will enrol a new authenticator on their next sign-in. Confirm their identity by a channel other than the one you are being asked through."
                    tone="danger" confirmLabel="Reset 2FA" requireNote noteMinLength={10} busy={busy}
                    onCancel={() => setDialog(null)}
                    onConfirm={({ note }) => act(`/admins/${dialog.target.adminId}/reset-mfa`, { reason: note })}
                />
            )}
            {(dialog?.kind === 'disable' || dialog?.kind === 'enable') && (
                <ReasonDialog
                    title={dialog.kind === 'disable' ? `Disable ${dialog.target.name}` : `Enable ${dialog.target.name}`}
                    description={dialog.kind === 'disable'
                        ? 'The account cannot sign in and every live session ends. The audit history stays.'
                        : 'The account can sign in again.'}
                    tone={dialog.kind === 'disable' ? 'danger' : 'ok'}
                    confirmLabel={dialog.kind === 'disable' ? 'Disable' : 'Enable'}
                    requireNote noteMinLength={5} busy={busy}
                    onCancel={() => setDialog(null)}
                    onConfirm={({ note }) => act(
                        `/admins/${dialog.target.adminId}/status`,
                        { status: dialog.kind === 'disable' ? 'disabled' : 'active', reason: note },
                        'PATCH'
                    )}
                />
            )}

            {toast && <Toast message={toast} onDone={() => setToast(null)} />}
        </>
    );
}

function CreateDialog({ onClose, onDone }: { onClose: () => void; onDone: (result: any) => void }) {
    const [form, setForm] = useState({ email: '', name: '', role: 'support', reason: '' });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function submit() {
        setBusy(true);
        setError(null);
        try {
            const res = await api<any>('/admins', { method: 'POST', body: form });
            onDone(res);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal title="Create an admin account" onClose={onClose}>
            <div style={{ display: 'grid', gap: 14 }}>
                <div>
                    <label htmlFor="name">Full name</label>
                    <input id="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div>
                    <label htmlFor="email">Work email</label>
                    <input id="email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@tryhive.in" />
                </div>
                <div>
                    <label htmlFor="role">Role</label>
                    <select id="role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                        {Object.entries(ROLE_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                    </select>
                    <p style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
                        {ROLE_SUMMARY[form.role]}
                    </p>
                </div>
                <div>
                    <label htmlFor="reason">Why does this person need access?</label>
                    <input id="reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
                </div>

                {error && <p style={{ color: 'var(--color-breach)', fontSize: 12.5 }}>{error}</p>}

                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
                    <button className="btn btn-primary" onClick={submit} disabled={busy || !form.email || !form.name}>
                        {busy ? 'Creating…' : 'Create account'}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
