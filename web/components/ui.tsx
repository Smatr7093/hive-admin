'use client';

/**
 * Shared primitives.
 *
 * Icons are inline SVG rather than an icon package: AR-09 rules out third-party
 * scripts, and a console with fifteen glyphs does not need a dependency to draw
 * them.
 */

import React, { useEffect, useState } from 'react';

// ─── Icons ───────────────────────────────────────────────────────────────────

const paths: Record<string, string> = {
    dashboard: 'M3 3h7v7H3zM14 3h7v4h-7zM14 10h7v11h-7zM3 13h7v8H3z',
    kyc: 'M4 4h16v16H4zM8 9h4M8 13h8M8 17h6',
    moderation: 'M12 3l8 4v6c0 4-3.5 7-8 8-4.5-1-8-4-8-8V7z',
    report: 'M12 2l10 18H2zM12 9v5M12 17.5v.5',
    grievance: 'M12 2a10 10 0 100 20 10 10 0 000-20zM12 7v6M12 16.5v.5',
    booking: 'M3 5h18v16H3zM3 10h18M8 3v4M16 3v4',
    finance: 'M3 6h18v12H3zM3 10h18M7 14h4',
    users: 'M16 20v-2a4 4 0 00-8 0v2M12 11a4 4 0 100-8 4 4 0 000 8M22 20v-2a4 4 0 00-3-3.87',
    audit: 'M4 3h12l4 4v14H4zM16 3v4h4M8 12h8M8 16h5',
    admins: 'M12 2l8 4v6c0 4-3.5 7-8 8-4.5-1-8-4-8-8V6zM9.5 12l2 2 3.5-4',
    search: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3',
    lock: 'M5 11h14v10H5zM8 11V7a4 4 0 018 0v4',
    eye: 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7zM12 15a3 3 0 100-6 3 3 0 000 6z',
    check: 'M4 12l5 5L20 6',
    close: 'M5 5l14 14M19 5L5 19',
    alert: 'M12 2l10 18H2zM12 9v5M12 17.5v.5',
    clock: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 6v6l4 2',
    chevron: 'M9 6l6 6-6 6',
    download: 'M12 3v12M7 11l5 5 5-5M4 20h16',
    refresh: 'M21 12a9 9 0 11-3-6.7M21 4v5h-5',
    logout: 'M9 21H5V3h4M16 17l5-5-5-5M21 12H9',
};

export function Icon({ name, size = 16, className = '' }: { name: keyof typeof paths | string; size?: number; className?: string }) {
    const d = paths[name] ?? paths.dashboard;
    return (
        <svg
            width={size} height={size} viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"
            className={className} aria-hidden="true"
        >
            {d.split('M').filter(Boolean).map((seg, i) => <path key={i} d={`M${seg}`} />)}
        </svg>
    );
}

// ─── Layout ──────────────────────────────────────────────────────────────────

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
    return (
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20, marginBottom: 20 }}>
            <div>
                <h1 style={{ fontSize: 24, letterSpacing: '-0.01em' }}>{title}</h1>
                {subtitle && <p style={{ color: 'var(--muted)', marginTop: 5, fontSize: 13, maxWidth: 680 }}>{subtitle}</p>}
            </div>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>{children}</div>
        </div>
    );
}

export function Panel({ title, action, children, padded = true }: {
    title?: string; action?: React.ReactNode; children: React.ReactNode; padded?: boolean;
}) {
    return (
        <section className="panel" style={{ overflow: 'hidden' }}>
            {title && (
                <header style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '14px 18px', borderBottom: '1px solid var(--border)',
                }}>
                    <h2 style={{ fontSize: 14, fontWeight: 700 }}>{title}</h2>
                    {action}
                </header>
            )}
            <div style={padded ? { padding: 18 } : undefined}>{children}</div>
        </section>
    );
}

export function Pill({ tone = 'neutral', children }: { tone?: string; children: React.ReactNode }) {
    return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function Empty({ message, hint }: { message: string; hint?: string }) {
    return (
        <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--muted-2)' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--muted)' }}>{message}</div>
            {hint && <div style={{ fontSize: 12, marginTop: 6 }}>{hint}</div>}
        </div>
    );
}

export function Loading({ rows = 5 }: { rows?: number }) {
    return (
        <div style={{ padding: 18, display: 'grid', gap: 10 }}>
            {Array.from({ length: rows }).map((_, i) => (
                <div key={i} className="skeleton" style={{ height: 38, opacity: 1 - i * 0.13 }} />
            ))}
        </div>
    );
}

export function ErrorNote({ error, onRetry }: { error: string; onRetry?: () => void }) {
    return (
        <div className="panel" style={{ padding: 18, borderColor: 'rgba(179,53,44,.3)', background: 'rgba(179,53,44,.04)' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <Icon name="alert" size={18} />
                <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, marginBottom: 3 }}>Something went wrong</div>
                    <div style={{ color: 'var(--muted)', fontSize: 13 }}>{error}</div>
                </div>
                {onRetry && <button className="btn btn-sm" onClick={onRetry}>Retry</button>}
            </div>
        </div>
    );
}

// ─── Modal ───────────────────────────────────────────────────────────────────

export function Modal({ title, onClose, children, width = 520 }: {
    title: string; onClose: () => void; children: React.ReactNode; width?: number;
}) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        document.body.style.overflow = 'hidden';
        return () => {
            window.removeEventListener('keydown', onKey);
            document.body.style.overflow = '';
        };
    }, [onClose]);

    return (
        <div
            role="dialog" aria-modal="true" aria-label={title}
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
            style={{
                position: 'fixed', inset: 0, background: 'rgba(44,44,44,.45)',
                display: 'grid', placeItems: 'center', padding: 20, zIndex: 100,
            }}
        >
            <div className="panel" style={{ width, maxWidth: '100%', maxHeight: '86vh', display: 'flex', flexDirection: 'column', boxShadow: 'var(--elevation-2)' }}>
                <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '15px 18px', borderBottom: '1px solid var(--border)' }}>
                    <h2 style={{ fontSize: 15 }}>{title}</h2>
                    <button className="btn btn-sm" onClick={onClose} aria-label="Close"><Icon name="close" size={14} /></button>
                </header>
                <div style={{ padding: 18, overflowY: 'auto' }}>{children}</div>
            </div>
        </div>
    );
}

/**
 * The reason-capture dialog behind every privileged action.
 *
 * L-01 requires a reason on every one of them, and the fixed lists in K-07,
 * M-05, P-02 and the rest exist because free text produces decisions nobody can
 * audit. So: one component, a required code from a list, and an optional note —
 * used identically everywhere, which is what makes the log queryable.
 */
export function ReasonDialog({
    title, description, reasons, confirmLabel = 'Confirm', tone = 'primary',
    requireNote = false, noteMinLength = 0, extra, onCancel, onConfirm, busy,
}: {
    title: string;
    description?: string;
    reasons?: { id: string; label: string; escalates?: boolean }[];
    confirmLabel?: string;
    tone?: 'primary' | 'danger' | 'ok';
    requireNote?: boolean;
    noteMinLength?: number;
    extra?: React.ReactNode;
    onCancel: () => void;
    onConfirm: (payload: { reasonCode?: string; note: string }) => void | Promise<void>;
    busy?: boolean;
}) {
    const [reasonCode, setReasonCode] = useState('');
    const [note, setNote] = useState('');

    const selected = reasons?.find((r) => r.id === reasonCode);
    const noteOk = !requireNote || note.trim().length >= Math.max(1, noteMinLength);
    const canConfirm = (!reasons || !!reasonCode) && noteOk && !busy;

    return (
        <Modal title={title} onClose={onCancel}>
            {description && <p style={{ color: 'var(--muted)', marginBottom: 16, fontSize: 13 }}>{description}</p>}

            {reasons && (
                <div style={{ marginBottom: 14 }}>
                    <label htmlFor="reason">Reason (required)</label>
                    <select id="reason" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
                        <option value="">Choose a reason…</option>
                        {reasons.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                    </select>
                    {selected?.escalates && (
                        <p style={{ marginTop: 8, fontSize: 12, color: 'var(--color-breach)', fontWeight: 600 }}>
                            This reason escalates to Super Admin automatically.
                        </p>
                    )}
                </div>
            )}

            {extra}

            <div style={{ marginBottom: 16 }}>
                <label htmlFor="note">
                    Note {requireNote ? `(required, at least ${noteMinLength || 1} characters)` : '(optional)'}
                </label>
                <textarea
                    id="note" rows={3} value={note} onChange={(e) => setNote(e.target.value)}
                    placeholder={requireNote ? 'What happened, and why this decision?' : 'Anything the next reviewer should know'}
                />
                {requireNote && note.length > 0 && !noteOk && (
                    <p style={{ marginTop: 6, fontSize: 12, color: 'var(--muted-2)' }}>
                        {noteMinLength - note.trim().length} more character(s) needed.
                    </p>
                )}
            </div>

            <p style={{ fontSize: 12, color: 'var(--muted-2)', marginBottom: 16 }}>
                This action is recorded against your account with a timestamp and cannot be edited afterwards.
            </p>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
                <button
                    className={`btn btn-${tone}`}
                    disabled={!canConfirm}
                    onClick={() => onConfirm({ reasonCode: reasonCode || undefined, note })}
                >
                    {busy ? 'Working…' : confirmLabel}
                </button>
            </div>
        </Modal>
    );
}

// ─── Data display ────────────────────────────────────────────────────────────

export function Field({ label, children, mono = false }: { label: string; children: React.ReactNode; mono?: boolean }) {
    return (
        <div>
            <div className="eyebrow" style={{ marginBottom: 4 }}>{label}</div>
            <div className={mono ? 'mono' : ''} style={{ fontSize: 13, wordBreak: 'break-word' }}>{children}</div>
        </div>
    );
}

export function FieldGrid({ columns = 2, children }: { columns?: number; children: React.ReactNode }) {
    return (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 16 }}>
            {children}
        </div>
    );
}

export function Toast({ message, tone = 'ok', onDone }: { message: string; tone?: 'ok' | 'breach'; onDone: () => void }) {
    useEffect(() => {
        const t = setTimeout(onDone, 4200);
        return () => clearTimeout(t);
    }, [onDone]);

    return (
        <div
            role="status"
            style={{
                position: 'fixed', bottom: 22, left: '50%', transform: 'translateX(-50%)',
                background: tone === 'ok' ? 'var(--color-ok)' : 'var(--color-breach)',
                color: '#fff', padding: '11px 18px', borderRadius: 999,
                fontSize: 13, fontWeight: 600, boxShadow: 'var(--elevation-2)', zIndex: 200,
                maxWidth: '90vw',
            }}
        >
            {message}
        </div>
    );
}
