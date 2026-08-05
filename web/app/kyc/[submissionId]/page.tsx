'use client';

/**
 * KYC review screen (PRD §5).
 *
 * K-02 asks for the document preview, the extracted fields, and the profile
 * fields side by side. The layout takes that literally: document on the left,
 * comparison on the right, and the three computed checks — age, duplicates,
 * attempts — stacked above the decision buttons where they cannot be scrolled
 * past on the way to Approve.
 *
 * The preview is fetched as watermarked SVG composed by the server (P-04). The
 * raw image never reaches this page.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api, fetchDocument, downloadDocument } from '@/lib/api';
import { useSession } from '@/lib/session';
import {
    PageHeader, Panel, Pill, Loading, ErrorNote, Icon, ReasonDialog, Field, FieldGrid, Toast,
} from '@/components/ui';
import { dateOnly, dateTime, relativeTime } from '@/lib/format';

type Action = 'approve' | 'reject' | 'resubmit' | null;

export default function KycDetailPage() {
    const { submissionId } = useParams<{ submissionId: string }>();
    const router = useRouter();
    const { can } = useSession();

    const [data, setData] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);
    const [action, setAction] = useState<Action>(null);
    const [busy, setBusy] = useState(false);
    const [toast, setToast] = useState<{ message: string; tone: 'ok' | 'breach' } | null>(null);
    const [ageOverride, setAgeOverride] = useState('');

    const load = () => {
        setError(null);
        api<any>(`/kyc/${submissionId}`).then((r) => setData(r.data)).catch((e) => setError(e.message));
    };

    useEffect(load, [submissionId]);

    if (error) return <ErrorNote error={error} onRetry={load} />;
    if (!data) return <Loading rows={6} />;

    const canDecide = can('kyc:decide') && ['pending', 'manual_review'].includes(data.status);
    const failsAge = !data.ageCheck.passes;

    async function submit(path: string, body: Record<string, unknown>) {
        setBusy(true);
        try {
            await api(`/kyc/${submissionId}/${path}`, { method: 'POST', body: { ...body, expectedVersion: data.version } });
            setToast({ message: 'Decision recorded and the companion has been notified.', tone: 'ok' });
            setAction(null);
            setTimeout(() => router.push('/kyc'), 900);
        } catch (err: any) {
            setToast({
                message: err.code === 'VERSION_CONFLICT'
                    ? 'Another admin actioned this while you had it open. Reloading.'
                    : err.message,
                tone: 'breach',
            });
            if (err.code === 'VERSION_CONFLICT') load();
            setAction(null);
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            <div style={{ marginBottom: 14 }}>
                <Link href="/kyc" style={{ fontSize: 12.5, color: 'var(--muted)' }}>← Back to the queue</Link>
            </div>

            <PageHeader
                title={data.profileSnapshot?.name ?? 'KYC review'}
                subtitle={`Submitted ${relativeTime(data.submittedAt)} · attempt ${data.attempts.current} of ${data.attempts.max} · ${data.documentType}`}
            >
                <Pill tone={data.status === 'manual_review' ? 'warning' : 'neutral'}>{data.status.replace('_', ' ')}</Pill>
            </PageHeader>

            {/* The three computed checks, above the fold, before any button. */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 20 }}>
                <CheckCard
                    label="Age check"
                    tone={data.ageCheck.indeterminate ? 'warning' : failsAge ? 'breach' : 'ok'}
                    headline={data.ageCheck.indeterminate ? 'Cannot compute' : `${data.ageCheck.documentAge} years`}
                    detail={data.ageCheck.indeterminate
                        ? 'No readable date of birth on the document'
                        : failsAge
                            ? `Below the minimum of ${data.ageCheck.minimum}`
                            : `At or above the minimum of ${data.ageCheck.minimum}`}
                />
                <CheckCard
                    label="Duplicate identity"
                    tone={data.duplicates.length ? 'breach' : 'ok'}
                    headline={data.duplicates.length ? `${data.duplicates.length} match` : 'No match'}
                    detail={data.duplicates.length
                        ? 'The hashed ID number appears on another account'
                        : 'This ID number is not on any other account'}
                />
                <CheckCard
                    label="Submission attempts"
                    tone={data.attempts.total >= 3 ? 'warning' : 'ok'}
                    headline={`${data.attempts.current} of ${data.attempts.max}`}
                    detail={data.attempts.total >= 3
                        ? 'Further rejections move this account to manual review, not a block'
                        : `${data.attempts.max - data.attempts.total} attempt(s) left in the ${data.attempts.windowDays}-day window`}
                />
            </div>

            {data.duplicates.length > 0 && (
                <div className="panel" style={{ padding: 16, marginBottom: 20, borderColor: 'rgba(179,53,44,.3)', background: 'rgba(179,53,44,.04)' }}>
                    <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>
                        This ID number is already on {data.duplicates.length} other account{data.duplicates.length === 1 ? '' : 's'}
                    </div>
                    <div style={{ display: 'grid', gap: 6 }}>
                        {data.duplicates.map((d: any) => (
                            <div key={d.submissionId} style={{ display: 'flex', gap: 12, fontSize: 12.5 }}>
                                <Link href={`/users/${encodeURIComponent(d.userId)}`} style={{ fontWeight: 600, textDecoration: 'underline' }}>
                                    {d.name ?? d.userId}
                                </Link>
                                <span className="mono" style={{ color: 'var(--muted-2)' }}>{d.userId}</span>
                                <Pill tone="neutral">{d.status}</Pill>
                                <span style={{ color: 'var(--muted-2)' }}>{dateOnly(d.submittedAt)}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 18, marginBottom: 20 }}>
                <DocumentPreview submissionId={submissionId} canDownload={data.canDownload} />

                <div style={{ display: 'grid', gap: 18, alignContent: 'start' }}>
                    <Panel title="Document vs profile">
                        <div style={{ display: 'grid', gap: 14 }}>
                            <Comparison label="Name" row={data.comparison.name} />
                            <Comparison label="Date of birth" row={data.comparison.dob} format={dateOnly} />
                            <Field label="ID number (from document)">
                                <span className="mono">{data.extracted?.idNumber ?? '—'}</span>
                            </Field>
                        </div>
                        <p style={{ marginTop: 14, fontSize: 11.5, color: 'var(--muted-2)', lineHeight: 1.55 }}>
                            A name difference caused by marriage is not on its own a rejection reason — accept a
                            supporting document and record the decision in the note.
                        </p>
                    </Panel>

                    <Panel title="Previous attempts">
                        {data.attempts.history.length <= 1 ? (
                            <p style={{ color: 'var(--muted-2)', fontSize: 13 }}>This is the first submission.</p>
                        ) : (
                            <div style={{ display: 'grid', gap: 9 }}>
                                {data.attempts.history.map((h: any) => (
                                    <div
                                        key={h.submissionId}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5,
                                            opacity: h.submissionId === submissionId ? 1 : 0.72,
                                        }}
                                    >
                                        <span style={{ fontWeight: 600, minWidth: 62 }}>Attempt {h.attemptNumber}</span>
                                        <Pill tone={h.status === 'approved' ? 'ok' : h.status === 'rejected' ? 'breach' : 'neutral'}>
                                            {h.status.replace('_', ' ')}
                                        </Pill>
                                        <span style={{ color: 'var(--muted-2)' }}>{dateOnly(h.submittedAt)}</span>
                                        {h.reasonCode && <span style={{ color: 'var(--muted)' }}>{h.reasonCode.replace(/_/g, ' ')}</span>}
                                    </div>
                                ))}
                            </div>
                        )}
                    </Panel>
                </div>
            </div>

            {data.decision && (
                <Panel title="Decision">
                    <FieldGrid columns={4}>
                        <Field label="Outcome"><Pill tone={data.decision.outcome === 'approved' ? 'ok' : 'breach'}>{data.decision.outcome}</Pill></Field>
                        <Field label="Reason">{data.decision.reasonLabel ?? '—'}</Field>
                        <Field label="By">{data.decision.byEmail}</Field>
                        <Field label="At">{dateTime(data.decision.at)}</Field>
                    </FieldGrid>
                    {data.decision.note && (
                        <div style={{ marginTop: 14 }}>
                            <Field label="Note">{data.decision.note}</Field>
                        </div>
                    )}
                    <p style={{ marginTop: 14, fontSize: 11.5, color: 'var(--muted-2)' }}>
                        This record is immutable. A correction creates a new record linked to this one.
                    </p>
                </Panel>
            )}

            {canDecide && (
                <div className="panel" style={{ padding: 18, position: 'sticky', bottom: 18, display: 'flex', gap: 10, alignItems: 'center', boxShadow: 'var(--elevation-2)' }}>
                    <div style={{ flex: 1, fontSize: 12.5, color: 'var(--muted)' }}>
                        The companion is notified of the decision and the reason immediately.
                    </div>
                    <button className="btn" onClick={() => setAction('resubmit')}>Request resubmission</button>
                    <button className="btn btn-danger" onClick={() => setAction('reject')}>Reject</button>
                    <button className="btn btn-ok" onClick={() => setAction('approve')}>
                        <Icon name="check" size={14} /> Approve
                    </button>
                </div>
            )}

            {action === 'approve' && (
                <ReasonDialog
                    title="Approve this verification"
                    description={failsAge
                        ? 'This applicant does not pass the age check. Approving requires a written justification, which is recorded against your name.'
                        : 'The companion becomes verified and can start accepting bookings.'}
                    tone="ok"
                    confirmLabel="Approve"
                    busy={busy}
                    extra={failsAge ? (
                        <div style={{ marginBottom: 14 }}>
                            <label htmlFor="override">Age override justification (required)</label>
                            <textarea
                                id="override" rows={2} value={ageOverride}
                                onChange={(e) => setAgeOverride(e.target.value)}
                                placeholder="Why is this approval correct despite the age check?"
                            />
                        </div>
                    ) : undefined}
                    onCancel={() => setAction(null)}
                    onConfirm={({ note }) => {
                        if (failsAge && ageOverride.trim().length < 15) {
                            setToast({ message: 'The age override needs a real justification.', tone: 'breach' });
                            return;
                        }
                        return submit('approve', {
                            note,
                            ...(failsAge ? { ageOverrideJustification: ageOverride } : {}),
                        });
                    }}
                />
            )}

            {action === 'reject' && (
                <ReasonDialog
                    title="Reject this verification"
                    description="Pick the reason that matches. The fixed list is what makes rejection patterns queryable later — add anything specific in the note."
                    reasons={data.rejectionReasons}
                    tone="danger"
                    confirmLabel="Reject"
                    busy={busy}
                    onCancel={() => setAction(null)}
                    onConfirm={({ reasonCode, note }) => submit('reject', { reasonCode, note })}
                />
            )}

            {action === 'resubmit' && (
                <ReasonDialog
                    title="Request a new document"
                    description="The companion is asked to submit again and told why. This does not count as a rejection."
                    reasons={data.rejectionReasons}
                    confirmLabel="Request resubmission"
                    busy={busy}
                    onCancel={() => setAction(null)}
                    onConfirm={({ reasonCode, note }) => submit('request-resubmission', { reasonCode, note })}
                />
            )}

            {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
        </>
    );
}

function CheckCard({ label, tone, headline, detail }: { label: string; tone: string; headline: string; detail: string }) {
    const accent = {
        breach: 'var(--color-breach)',
        warning: 'var(--color-warning)',
        ok: 'var(--color-ok)',
    }[tone] ?? 'var(--border-2)';

    return (
        <div className="panel" style={{ padding: 16, borderLeft: `3px solid ${accent}` }}>
            <div className="eyebrow">{label}</div>
            <div style={{ fontSize: 19, fontWeight: 700, fontFamily: 'var(--font-display)', marginTop: 5, color: accent }}>
                {headline}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>{detail}</div>
        </div>
    );
}

function Comparison({ label, row, format }: { label: string; row: any; format?: (v: string) => string }) {
    const show = (v: string | null) => (v ? (format ? format(v) : v) : '—');
    return (
        <div>
            <div className="eyebrow" style={{ marginBottom: 6 }}>{label}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 10, alignItems: 'center' }}>
                <div style={{ fontSize: 13 }}>
                    <div style={{ fontSize: 10.5, color: 'var(--muted-2)', marginBottom: 2 }}>DOCUMENT</div>
                    {show(row.document)}
                </div>
                <div style={{ color: row.matches ? 'var(--color-ok)' : 'var(--color-warning)' }}>
                    <Icon name={row.matches ? 'check' : 'alert'} size={15} />
                </div>
                <div style={{ fontSize: 13 }}>
                    <div style={{ fontSize: 10.5, color: 'var(--muted-2)', marginBottom: 2 }}>PROFILE</div>
                    {show(row.profile)}
                </div>
            </div>
        </div>
    );
}

/**
 * P-04 / P-05 — the preview arrives already watermarked with the viewing admin's
 * identity. Download is a separate, separately-logged action available only to
 * roles holding kyc:doc:download.
 */
function DocumentPreview({ submissionId, canDownload }: { submissionId: string; canDownload: boolean }) {
    const [kind, setKind] = useState<'gov-id' | 'selfie'>('gov-id');
    const [svg, setSvg] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [downloading, setDownloading] = useState(false);
    const [downloadNote, setDownloadNote] = useState<string | null>(null);

    useEffect(() => {
        setSvg(null);
        setError(null);
        fetchDocument(submissionId, kind)
            .then(setSvg)
            .catch(() => setError('Could not load the document'));
    }, [submissionId, kind]);

    return (
        <Panel
            title="Document"
            action={
                <div style={{ display: 'flex', gap: 6 }}>
                    <button className={`btn btn-sm${kind === 'gov-id' ? ' btn-primary' : ''}`} onClick={() => setKind('gov-id')}>ID</button>
                    <button className={`btn btn-sm${kind === 'selfie' ? ' btn-primary' : ''}`} onClick={() => setKind('selfie')}>Selfie</button>
                </div>
            }
        >
            <div style={{
                background: 'var(--bg)', borderRadius: 'var(--radius-md)', overflow: 'hidden',
                minHeight: 300, display: 'grid', placeItems: 'center',
            }}>
                {error && <span style={{ color: 'var(--muted-2)', fontSize: 13 }}>{error}</span>}
                {!svg && !error && <div className="skeleton" style={{ width: '100%', height: 300 }} />}
                {svg && (
                    // The SVG is composed by our own server from our own S3 bucket and
                    // carries the watermark; rendering it inline is what keeps the
                    // watermark part of the image rather than a CSS overlay.
                    <div style={{ width: '100%' }} dangerouslySetInnerHTML={{ __html: svg }} />
                )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
                <p style={{ flex: 1, fontSize: 11.5, color: 'var(--muted-2)', lineHeight: 1.5 }}>
                    Watermarked with your ID and the time you opened it. This view is logged.
                </p>
                {canDownload && (
                    <button className="btn btn-sm" onClick={() => setDownloading(true)}>
                        <Icon name="download" size={13} /> Download
                    </button>
                )}
            </div>

            {downloading && (
                <ReasonDialog
                    title="Download the original document"
                    description="This hands you the unwatermarked file. The download is logged as its own event with your name, the reason below, and the time."
                    confirmLabel="Download"
                    requireNote
                    noteMinLength={12}
                    busy={false}
                    onCancel={() => setDownloading(false)}
                    onConfirm={async ({ note }) => {
                        try {
                            await downloadDocument(submissionId, kind, note);
                            setDownloadNote('Downloaded and logged.');
                        } catch (err: any) {
                            setDownloadNote(err.message ?? 'Download refused');
                        } finally {
                            setDownloading(false);
                        }
                    }}
                />
            )}

            {downloadNote && <Toast message={downloadNote} tone="ok" onDone={() => setDownloadNote(null)} />}
        </Panel>
    );
}
