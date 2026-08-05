'use client';

/**
 * Finance (PRD §8).
 *
 * Three tabs: payouts, refunds, reconciliation. §8.3 (tax) is shown as an
 * explicit blocked state rather than hidden — the gate is a decision someone
 * owes, and a missing tab reads as "not built yet" rather than "waiting on you".
 *
 * Two signals get prominence they would not get from a status column alone:
 * a bank account shared across companion profiles (F-07, the mule control) and
 * a payout being released inside the 48-hour bank-change window (F-06).
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { PiiField } from '@/components/MaskedValue';
import {
    PageHeader, Panel, Pill, Loading, ErrorNote, Empty, Icon, ReasonDialog, Toast, Field, FieldGrid,
} from '@/components/ui';
import { rupees, relativeTime, dateTime, titleCase } from '@/lib/format';

type Tab = 'payouts' | 'refunds' | 'reconciliation' | 'tax';

export default function FinancePage() {
    const [tab, setTab] = useState<Tab>('payouts');
    const [meta, setMeta] = useState<any>(null);
    const [piiReasons, setPiiReasons] = useState<any[]>([]);

    useEffect(() => {
        api<any>('/finance/meta').then((r) => setMeta(r.data)).catch(() => {});
        api<any>('/pii/reasons').then((r) => setPiiReasons(r.data)).catch(() => {});
    }, []);

    return (
        <>
            <PageHeader
                title="Finance"
                subtitle="Payouts, refunds and daily reconciliation. Bank details are masked by default and every reveal is logged."
            >
                <div style={{ display: 'flex', gap: 6 }}>
                    {(['payouts', 'refunds', 'reconciliation', 'tax'] as Tab[]).map((t) => (
                        <button key={t} className={`btn${tab === t ? ' btn-primary' : ''}`} onClick={() => setTab(t)}>
                            {titleCase(t)}
                        </button>
                    ))}
                </div>
            </PageHeader>

            {tab === 'payouts' && <Payouts meta={meta} piiReasons={piiReasons} />}
            {tab === 'refunds' && <Refunds meta={meta} />}
            {tab === 'reconciliation' && <Reconciliation />}
            {tab === 'tax' && <TaxGate />}
        </>
    );
}

// ─── Payouts ─────────────────────────────────────────────────────────────────

function Payouts({ meta, piiReasons }: { meta: any; piiReasons: any[] }) {
    const { can } = useSession();
    const [status, setStatus] = useState('all');
    const [data, setData] = useState<any>(null);
    const [collisions, setCollisions] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);
    const [dialog, setDialog] = useState<{ kind: 'hold' | 'release' | 'retry'; payout: any } | null>(null);
    const [busy, setBusy] = useState(false);
    const [toast, setToast] = useState<string | null>(null);

    const load = () => {
        setError(null);
        api<any>(`/finance/payouts?status=${status}`).then(setData).catch((e) => setError(e.message));
        api<any>('/finance/bank-collisions').then(setCollisions).catch(() => {});
    };

    useEffect(load, [status]);

    async function act(kind: string, payout: any, body: Record<string, unknown>) {
        setBusy(true);
        try {
            await api(`/finance/payouts/${payout.payoutId}/${kind}`, {
                method: 'POST', body: { ...body, expectedVersion: payout.version },
            });
            setToast('Done and logged.');
            setDialog(null);
            load();
        } catch (err: any) {
            setToast(err.code === 'COOLING_OFF_ACTIVE'
                ? `${err.message}`
                : err.message);
            setDialog(null);
        } finally {
            setBusy(false);
        }
    }

    if (error) return <ErrorNote error={error} onRetry={load} />;
    if (!data) return <Panel><Loading /></Panel>;

    return (
        <>
            {collisions?.meta?.flagged > 0 && (
                <div className="panel" style={{
                    padding: 16, marginBottom: 18,
                    borderColor: 'rgba(179,53,44,.32)', background: 'rgba(179,53,44,.05)',
                }}>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                        <span style={{ color: 'var(--color-breach)', marginTop: 1 }}><Icon name="alert" size={18} /></span>
                        <div>
                            <div style={{ fontWeight: 700, fontSize: 13 }}>
                                {collisions.meta.flagged} bank account(s) shared across companion profiles
                            </div>
                            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.55 }}>
                                One account receiving payouts for several profiles is the payout-mule pattern.
                                Hold the payouts and check the identities before releasing anything.
                            </div>
                            <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
                                {collisions.data.map((c: any) => (
                                    <div key={c.accountHash} style={{ fontSize: 12.5 }}>
                                        <strong>{c.bankName}</strong> —{' '}
                                        {c.profiles.map((p: any, i: number) => (
                                            <span key={p.bankAccountId}>
                                                {i > 0 && ', '}
                                                <Link href={`/users/${encodeURIComponent(p.companionId)}`} style={{ textDecoration: 'underline' }}>
                                                    {p.accountHolderName}
                                                </Link>
                                            </span>
                                        ))}
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 160 }}>
                    <option value="all">All payouts</option>
                    <option value="requested">Requested</option>
                    <option value="processing">Processing</option>
                    <option value="failed">Failed</option>
                    <option value="held">Held</option>
                    <option value="paid">Paid</option>
                </select>
                <Pill tone="neutral">{rupees(data.meta.totalPendingPaise)} pending</Pill>
                {data.meta.failed > 0 && <Pill tone="critical">{data.meta.failed} failed</Pill>}
                {data.meta.held > 0 && <Pill tone="warning">{data.meta.held} held</Pill>}
                <button className="btn btn-sm" onClick={load} style={{ marginLeft: 'auto' }}><Icon name="refresh" size={13} /></button>
            </div>

            <Panel padded={false}>
                {data.data.length === 0 ? (
                    <Empty message="No payouts match" />
                ) : (
                    <table>
                        <thead>
                            <tr><th>Companion</th><th>Amount</th><th>Fund account</th><th>Status</th><th>Flags</th><th /></tr>
                        </thead>
                        <tbody>
                            {data.data.map((p: any) => (
                                <tr key={p.payoutId} className={p.muleSignal ? 'row-breach' : p.status === 'failed' ? 'row-critical' : p.coolingOff?.active ? 'row-warning' : ''}>
                                    <td>
                                        <Link href={`/users/${encodeURIComponent(p.companionId)}`} style={{ fontWeight: 600, textDecoration: 'underline' }}>
                                            {p.companionName ?? p.companionId}
                                        </Link>
                                        <div style={{ fontSize: 11, color: 'var(--muted-2)' }}>{relativeTime(p.requestedAt)}</div>
                                    </td>
                                    <td style={{ fontWeight: 600 }}>{rupees(p.amount)}</td>
                                    <td>
                                        {p.fundAccount ? (
                                            <div style={{ fontSize: 12 }}>
                                                <div>{p.fundAccount.bankName}</div>
                                                <PiiField
                                                    record={p.fundAccount} field="accountNumber"
                                                    recordType="bank_account" recordId={p.fundAccount.bankAccountId}
                                                    reasons={piiReasons}
                                                />
                                            </div>
                                        ) : '—'}
                                    </td>
                                    <td>
                                        <Pill tone={
                                            p.status === 'failed' ? 'breach'
                                            : p.status === 'held' ? 'warning'
                                            : p.status === 'paid' ? 'ok' : 'neutral'
                                        }>{p.status}</Pill>
                                        {p.status === 'failed' && p.gatewayError && (
                                            <div className="mono" style={{ fontSize: 10.5, color: 'var(--color-breach)', marginTop: 4, maxWidth: 240 }}>
                                                {p.gatewayError}
                                            </div>
                                        )}
                                        {p.status === 'held' && p.holdReason && (
                                            <div style={{ fontSize: 11, color: 'var(--muted-2)', marginTop: 3 }}>{p.holdReason}</div>
                                        )}
                                    </td>
                                    <td>
                                        <div style={{ display: 'grid', gap: 4 }}>
                                            {p.muleSignal && <Pill tone="breach">shared account</Pill>}
                                            {p.coolingOff?.active && (
                                                <Pill tone="warning">cooling-off {p.coolingOff.remainingHours}h</Pill>
                                            )}
                                        </div>
                                    </td>
                                    <td style={{ textAlign: 'right' }}>
                                        {can('payout:action') && (
                                            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                                                {p.status === 'failed' && (
                                                    <button className="btn btn-sm" onClick={() => setDialog({ kind: 'retry', payout: p })}>Retry</button>
                                                )}
                                                {p.status === 'held' && (
                                                    <button className="btn btn-sm btn-ok" onClick={() => setDialog({ kind: 'release', payout: p })}>Release</button>
                                                )}
                                                {['requested', 'processing'].includes(p.status) && (
                                                    <button className="btn btn-sm" onClick={() => setDialog({ kind: 'hold', payout: p })}>Hold</button>
                                                )}
                                            </div>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </Panel>

            {dialog?.kind === 'hold' && (
                <ReasonDialog
                    title="Hold this payout"
                    description={`${rupees(dialog.payout.amount)} to ${dialog.payout.companionName}. The companion is not paid until it is released.`}
                    reasons={meta?.holdReasons} tone="danger" confirmLabel="Hold" busy={busy}
                    onCancel={() => setDialog(null)}
                    onConfirm={({ reasonCode, note }) => act('hold', dialog.payout, { reasonCode, note })}
                />
            )}
            {dialog?.kind === 'release' && (
                <ReasonDialog
                    title="Release this held payout"
                    description={
                        dialog.payout.coolingOff?.active
                            ? `Bank details changed ${dialog.payout.coolingOff.remainingHours}h ago. The 48-hour cooling-off is still running — releasing now needs an override, and a Super Admin is alerted.`
                            : `${rupees(dialog.payout.amount)} to ${dialog.payout.companionName} will be sent for processing.`
                    }
                    tone="ok" confirmLabel="Release" requireNote noteMinLength={10} busy={busy}
                    onCancel={() => setDialog(null)}
                    onConfirm={({ note }) => act('release', dialog.payout, {
                        note,
                        overrideCoolingOff: dialog.payout.coolingOff?.active ? true : undefined,
                    })}
                />
            )}
            {dialog?.kind === 'retry' && (
                <ReasonDialog
                    title="Retry this payout"
                    description={`Gateway error: ${dialog.payout.gatewayError ?? 'unknown'}. Confirm the fund account is correct before retrying.`}
                    confirmLabel="Retry" requireNote noteMinLength={5} busy={busy}
                    onCancel={() => setDialog(null)}
                    onConfirm={({ note }) => act('retry', dialog.payout, { note })}
                />
            )}
            {toast && <Toast message={toast} onDone={() => setToast(null)} />}
        </>
    );
}

// ─── Refunds ─────────────────────────────────────────────────────────────────

function Refunds({ meta }: { meta: any }) {
    const { can, admin } = useSession();
    const [data, setData] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);
    const [approving, setApproving] = useState<any>(null);
    const [toast, setToast] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const load = () => {
        setError(null);
        api<any>('/finance/refunds').then(setData).catch((e) => setError(e.message));
    };

    useEffect(load, []);

    if (error) return <ErrorNote error={error} onRetry={load} />;
    if (!data) return <Panel><Loading /></Panel>;

    return (
        <>
            <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
                {data.meta.awaitingApproval > 0 && (
                    <Pill tone="warning">{data.meta.awaitingApproval} awaiting a second approval</Pill>
                )}
                <span style={{ fontSize: 12, color: 'var(--muted-2)', marginLeft: 'auto' }}>
                    Refunds above {rupees(data.meta.threshold)} need two different admins.
                </span>
            </div>

            <Panel padded={false}>
                {data.data.length === 0 ? (
                    <Empty message="No refunds" />
                ) : (
                    <table>
                        <thead>
                            <tr><th>Amount</th><th>Booking</th><th>Reason</th><th>Requested by</th><th>Status</th><th /></tr>
                        </thead>
                        <tbody>
                            {data.data.map((r: any) => {
                                const isOwn = r.requestedBy === admin?.adminId;
                                return (
                                    <tr key={r.refundId} className={r.status === 'pending_approval' ? 'row-warning' : ''}>
                                        <td style={{ fontWeight: 600 }}>
                                            {rupees(r.amount)}
                                            {r.amount > data.meta.threshold && (
                                                <div style={{ fontSize: 10.5, color: 'var(--muted-2)' }}>over threshold</div>
                                            )}
                                        </td>
                                        <td>
                                            {r.bookingId ? (
                                                <Link href={`/bookings/${r.bookingId}`} className="mono" style={{ textDecoration: 'underline' }}>
                                                    {r.bookingId}
                                                </Link>
                                            ) : <span style={{ color: 'var(--muted-2)' }}>—</span>}
                                        </td>
                                        <td>
                                            <div>{r.reasonLabel}</div>
                                            {r.note && <div style={{ fontSize: 11.5, color: 'var(--muted-2)', maxWidth: 280 }}>{r.note}</div>}
                                        </td>
                                        <td style={{ fontSize: 12 }}>
                                            {r.requestedByEmail}
                                            <div style={{ fontSize: 11, color: 'var(--muted-2)' }}>{relativeTime(r.requestedAt)}</div>
                                        </td>
                                        <td>
                                            <Pill tone={
                                                r.status === 'approved' || r.status === 'issued' ? 'ok'
                                                : r.status === 'rejected' ? 'breach' : 'warning'
                                            }>{r.status.replace('_', ' ')}</Pill>
                                        </td>
                                        <td style={{ textAlign: 'right' }}>
                                            {can('refund:approve') && r.status === 'pending_approval' && (
                                                isOwn ? (
                                                    <span style={{ fontSize: 11.5, color: 'var(--muted-2)' }}>
                                                        You requested this — another admin must approve
                                                    </span>
                                                ) : (
                                                    <button className="btn btn-sm btn-ok" onClick={() => setApproving(r)}>Approve</button>
                                                )
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </Panel>

            {approving && (
                <ReasonDialog
                    title="Approve this refund"
                    description={`${rupees(approving.amount)} to the seeker. You are the second signature — ${approving.requestedByEmail} raised it.`}
                    tone="ok" confirmLabel="Approve refund" busy={busy}
                    onCancel={() => setApproving(null)}
                    onConfirm={async ({ note }) => {
                        setBusy(true);
                        try {
                            await api(`/finance/refunds/${approving.refundId}/approve`, {
                                method: 'POST', body: { note, expectedVersion: approving.version },
                            });
                            setToast('Refund approved and the seeker notified.');
                            load();
                        } catch (err: any) {
                            setToast(err.message);
                        } finally {
                            setBusy(false);
                            setApproving(null);
                        }
                    }}
                />
            )}
            {toast && <Toast message={toast} onDone={() => setToast(null)} />}
        </>
    );
}

// ─── Reconciliation ──────────────────────────────────────────────────────────

function Reconciliation() {
    const today = new Date().toISOString().slice(0, 10);
    const [date, setDate] = useState(today);
    const [data, setData] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);

    const load = () => {
        setError(null);
        setData(null);
        api<any>(`/finance/reconciliation?date=${date}`).then(setData).catch((e) => setError(e.message));
    };

    useEffect(load, [date]);

    if (error) return <ErrorNote error={error} onRetry={load} />;

    return (
        <>
            <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 175 }} />
                {data && (
                    <>
                        <Pill tone={data.meta.balanced ? 'ok' : 'breach'}>
                            {data.meta.balanced ? 'Balanced' : `${data.meta.discrepancies} discrepancy(ies)`}
                        </Pill>
                        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                            Ledger {rupees(data.meta.ledgerTotalPaise)} · gateway {rupees(data.meta.gatewayTotalPaise)}
                        </span>
                    </>
                )}
            </div>

            {!data && <Panel><Loading /></Panel>}

            {data && (
                <Panel padded={false}>
                    {data.data.length === 0 ? (
                        <Empty message="No settlements on this date" />
                    ) : (
                        <table>
                            <thead>
                                <tr><th>Payout</th><th>Ledger</th><th>Gateway</th><th>Discrepancy</th></tr>
                            </thead>
                            <tbody>
                                {data.data.map((r: any) => (
                                    <tr key={r.payoutId} className={r.discrepancy && !r.resolvedAt ? 'row-breach' : ''}>
                                        <td className="mono">{r.payoutId}</td>
                                        <td>
                                            {r.ledgerStatus ? <Pill tone="neutral">{r.ledgerStatus}</Pill> : <span style={{ color: 'var(--muted-2)' }}>absent</span>}
                                            <div style={{ fontSize: 12, marginTop: 3 }}>{r.ledgerAmount != null ? rupees(r.ledgerAmount) : '—'}</div>
                                        </td>
                                        <td>
                                            {r.gatewayStatus ? <Pill tone="neutral">{r.gatewayStatus}</Pill> : <span style={{ color: 'var(--muted-2)' }}>absent</span>}
                                            <div style={{ fontSize: 12, marginTop: 3 }}>{r.gatewayAmount != null ? rupees(r.gatewayAmount) : '—'}</div>
                                            {r.gatewayReference && <div className="mono" style={{ fontSize: 10.5, color: 'var(--muted-2)' }}>{r.gatewayReference}</div>}
                                        </td>
                                        <td>
                                            {r.discrepancy ? (
                                                <>
                                                    <Pill tone="breach">{titleCase(r.discrepancy.type)}</Pill>
                                                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4, maxWidth: 300 }}>
                                                        {r.discrepancy.detail}
                                                    </div>
                                                </>
                                            ) : <Pill tone="ok">Matches</Pill>}
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

// ─── §8.3 Tax gate ───────────────────────────────────────────────────────────

function TaxGate() {
    const [data, setData] = useState<any>(null);
    useEffect(() => { api<any>('/tax/status').then((r) => setData(r.data)).catch(() => {}); }, []);
    if (!data) return <Panel><Loading rows={3} /></Panel>;

    return (
        <div style={{ display: 'grid', gap: 18 }}>
            <div className="panel" style={{ padding: 20, borderColor: 'rgba(217,149,91,.35)', background: 'rgba(217,149,91,.05)' }}>
                <div style={{ display: 'flex', gap: 13, alignItems: 'flex-start' }}>
                    <span style={{ color: 'var(--color-warning)', marginTop: 1 }}><Icon name="lock" size={20} /></span>
                    <div>
                        <h2 style={{ fontSize: 15 }}>Blocked on the CA consultation</h2>
                        <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 7, lineHeight: 1.65, maxWidth: 720 }}>
                            Hive is likely an e-commerce operator under Indian tax law, which may bring Section
                            194-O TDS on payments to companions and GST TCS obligations. Whether they apply, at what
                            rate and above what threshold depends on Siante's structure and turnover.
                        </p>
                        <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 10, lineHeight: 1.65, maxWidth: 720 }}>
                            This is not waiting on engineering. Building against a guess would mean companions
                            querying Form 16A figures that do not reconcile with what they were paid — and the fix
                            after six months of live payouts is a manual reconstruction of every one of them.
                            <strong> The same conversation blocks the v2.0 payout data model, which is why it should
                            be resolved before payout code is written, not before v2.1.</strong>
                        </p>
                    </div>
                </div>
            </div>

            <Panel title="What is blocked">
                <table>
                    <thead><tr><th style={{ width: 70 }}>ID</th><th>Requirement</th></tr></thead>
                    <tbody>
                        {data.requirements.map((r: any) => (
                            <tr key={r.id}>
                                <td className="mono" style={{ fontWeight: 600 }}>{r.id}</td>
                                <td>{r.requirement}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </Panel>

            <Panel title="Questions for the CA">
                <ol style={{ paddingLeft: 20, display: 'grid', gap: 8, fontSize: 13, lineHeight: 1.55, color: 'var(--muted)' }}>
                    {data.questionsForTheCA.map((q: string) => <li key={q}>{q}</li>)}
                </ol>
            </Panel>
        </div>
    );
}
