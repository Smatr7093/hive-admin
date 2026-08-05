'use client';

/**
 * A masked PII value with the unmask flow attached (P-01 … P-04).
 *
 * The component never receives the real value as a prop — the server sends
 * `••••••1234` and nothing else. Revealing it costs a round trip carrying a
 * reason code, which is what makes P-02's audit event unavoidable rather than
 * best-effort. Nothing here can be defeated by opening dev tools, because there
 * is nothing in the page to find.
 */

import React, { useState } from 'react';
import { api } from '@/lib/api';
import { Icon, Modal } from './ui';

type Reason = { id: string; label: string };

export function MaskedValue({
    value,
    field,
    recordType,
    recordId,
    masked,
    reasons,
    onUnmasked,
}: {
    value: string | null;
    field: string;
    recordType: string;
    recordId: string;
    masked: boolean;
    reasons: Reason[];
    onUnmasked?: (field: string, real: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const [reasonCode, setReasonCode] = useState('');
    const [revealed, setRevealed] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [expiresAt, setExpiresAt] = useState<string | null>(null);

    if (!masked || revealed) {
        return (
            <span className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {revealed ?? value ?? '—'}
                {revealed && (
                    <span
                        className="pill pill-warning"
                        title={`Unmasked by you. This grant expires at ${expiresAt ? new Date(expiresAt).toLocaleTimeString() : 'the end of your session'} and was logged.`}
                    >
                        unmasked
                    </span>
                )}
            </span>
        );
    }

    async function unmask() {
        setBusy(true);
        setError(null);
        try {
            const res = await api<{ data: { values: Record<string, string>; expiresAt: string } }>('/pii/unmask', {
                method: 'POST',
                body: { recordType, recordId, fields: [field], reasonCode },
            });
            const real = res.data.values[field];
            setRevealed(real ?? '—');
            setExpiresAt(res.data.expiresAt);
            onUnmasked?.(field, real);
            setOpen(false);
        } catch (err: any) {
            setError(err.message ?? 'Could not unmask');
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <span className="masked">{value ?? '••••••'}</span>
                <button
                    className="btn btn-sm"
                    onClick={() => setOpen(true)}
                    title="Reveal this value — requires a reason and is logged"
                    style={{ padding: '2px 7px' }}
                >
                    <Icon name="eye" size={12} />
                </button>
            </span>

            {open && (
                <Modal title="Reveal personal data" onClose={() => setOpen(false)} width={460}>
                    <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 16 }}>
                        You are about to reveal <strong>{field}</strong> on this record. The value, your name and
                        the reason below are written to the audit log. The grant covers this field on this record
                        only, and expires in 15 minutes.
                    </p>

                    <label htmlFor="unmask-reason">Why do you need it?</label>
                    <select id="unmask-reason" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
                        <option value="">Choose a reason…</option>
                        {reasons.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                    </select>

                    {error && (
                        <p style={{ marginTop: 12, fontSize: 12, color: 'var(--color-breach)' }}>{error}</p>
                    )}

                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
                        <button className="btn" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
                        <button className="btn btn-primary" onClick={unmask} disabled={!reasonCode || busy}>
                            {busy ? 'Revealing…' : 'Reveal and log'}
                        </button>
                    </div>
                </Modal>
            )}
        </>
    );
}

/**
 * Renders a field that may or may not be masked depending on the caller's role,
 * using the `_masked` array the API attaches to every object carrying PII.
 */
export function PiiField({
    record, field, recordType, recordId, reasons, label,
}: {
    record: Record<string, any>;
    field: string;
    recordType: string;
    recordId: string;
    reasons: Reason[];
    label?: string;
}) {
    const masked = Array.isArray(record._masked) && record._masked.includes(field);
    return (
        <div>
            {label && <div className="eyebrow" style={{ marginBottom: 4 }}>{label}</div>}
            <MaskedValue
                value={record[field] ?? null}
                field={field}
                recordType={recordType}
                recordId={recordId}
                masked={masked}
                reasons={reasons}
            />
        </div>
    );
}
