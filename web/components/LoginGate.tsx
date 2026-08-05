'use client';

/**
 * Sign-in (AR-05).
 *
 * Two stages, always. There is no "remember this device", no trusted-device
 * cookie, and no path from the password form to a session — the server would
 * refuse anyway, but the UI does not offer one, because a bypass people ask for
 * is a bypass someone eventually builds.
 *
 * First sign-in enrols an authenticator, showing both a QR code and the manual
 * key so a rendering failure never blocks it.
 */

import React, { useState } from 'react';
import { login, verifyMfa, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Icon } from './ui';
import { QrCode } from './QrCode';

type Stage =
    | { name: 'credentials' }
    | { name: 'mfa'; challengeToken: string }
    | { name: 'enrol'; challengeToken: string; secret: string; uri: string }
    | { name: 'recovery_codes'; codes: string[] };

export function LoginGate() {
    const { signIn, endedReason } = useSession();
    const [stage, setStage] = useState<Stage>({ name: 'credentials' });
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [code, setCode] = useState('');
    const [useRecovery, setUseRecovery] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [pending, setPending] = useState<{ admin: any; expiresAt: string; idle: number } | null>(null);

    async function submitCredentials(e: React.FormEvent) {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const res = await login(email, password);
            if (res.stage === 'authenticated') {
                // Demo configuration only — the server refuses to return this
                // stage when it is pointed at real data.
                signIn(res.admin, res.expiresAt, res.idleTimeoutSeconds, res.mfaBypassed);
            } else if (res.stage === 'enrol_mfa') {
                setStage({ name: 'enrol', challengeToken: res.challengeToken, secret: res.enrolment.secret, uri: res.enrolment.uri });
            } else {
                setStage({ name: 'mfa', challengeToken: res.challengeToken });
            }
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Sign-in failed');
        } finally {
            setBusy(false);
        }
    }

    async function submitCode(e: React.FormEvent) {
        e.preventDefault();
        if (stage.name !== 'mfa' && stage.name !== 'enrol') return;
        setBusy(true);
        setError(null);
        try {
            const res = await verifyMfa(
                stage.challengeToken,
                useRecovery ? '' : code,
                useRecovery ? code : undefined
            );
            if (res.recoveryCodes?.length) {
                // Shown exactly once — the server stores only hashes.
                setPending({ admin: res.admin, expiresAt: res.expiresAt, idle: res.idleTimeoutSeconds });
                setStage({ name: 'recovery_codes', codes: res.recoveryCodes });
            } else {
                signIn(res.admin, res.expiresAt, res.idleTimeoutSeconds);
            }
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Verification failed');
            setCode('');
        } finally {
            setBusy(false);
        }
    }

    return (
        <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20 }}>
            <div style={{ width: 420, maxWidth: '100%' }}>
                <div style={{ textAlign: 'center', marginBottom: 26 }}>
                    <div style={{
                        width: 40, height: 44, background: 'var(--color-accent)', margin: '0 auto 14px',
                        clipPath: 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)',
                    }} />
                    <h1 style={{ fontSize: 21 }}>Hive Admin</h1>
                    <p style={{ color: 'var(--muted-2)', fontSize: 12.5, marginTop: 5 }}>
                        Siante Technologies Private Limited
                    </p>
                </div>

                {endedReason && stage.name === 'credentials' && (
                    <div className="panel" style={{ padding: '11px 15px', marginBottom: 14, fontSize: 12.5, color: 'var(--muted)' }}>
                        {endedReason}
                    </div>
                )}

                <div className="panel" style={{ padding: 24 }}>
                    {stage.name === 'credentials' && (
                        <form onSubmit={submitCredentials}>
                            <div style={{ marginBottom: 14 }}>
                                <label htmlFor="email">Work email</label>
                                <input
                                    id="email" type="email" autoComplete="username" required autoFocus
                                    value={email} onChange={(e) => setEmail(e.target.value)}
                                    placeholder="you@tryhive.in"
                                />
                            </div>
                            <div style={{ marginBottom: 18 }}>
                                <label htmlFor="password">Password</label>
                                <input
                                    id="password" type="password" autoComplete="current-password" required
                                    value={password} onChange={(e) => setPassword(e.target.value)}
                                />
                            </div>
                            {error && <p style={{ color: 'var(--color-breach)', fontSize: 12.5, marginBottom: 14 }}>{error}</p>}
                            <button className="btn btn-primary" style={{ width: '100%' }} disabled={busy}>
                                {busy ? 'Checking…' : 'Continue'}
                            </button>
                            <p style={{ marginTop: 16, fontSize: 11.5, color: 'var(--muted-2)', textAlign: 'center' }}>
                                <Icon name="lock" size={11} /> Two-factor authentication is required on every sign-in.
                            </p>
                        </form>
                    )}

                    {stage.name === 'enrol' && (
                        <div>
                            <h2 style={{ fontSize: 16, marginBottom: 8 }}>Set up two-factor authentication</h2>
                            <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 18 }}>
                                Scan this with an authenticator app, then enter the six-digit code it shows.
                                You cannot use this account until an authenticator is bound.
                            </p>

                            <div style={{ display: 'grid', placeItems: 'center', marginBottom: 16 }}>
                                <div style={{ background: '#fff', padding: 12, border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                                    <QrCode text={stage.uri} size={168} />
                                </div>
                            </div>

                            <details style={{ marginBottom: 18 }}>
                                <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--muted)' }}>
                                    Can't scan? Enter the key manually
                                </summary>
                                <div className="mono" style={{
                                    marginTop: 8, padding: 10, background: 'var(--bg)',
                                    borderRadius: 'var(--radius-sm)', wordBreak: 'break-all', fontSize: 12,
                                }}>
                                    {stage.secret}
                                </div>
                            </details>

                            <form onSubmit={submitCode}>
                                <label htmlFor="enrol-code">Six-digit code</label>
                                <input
                                    id="enrol-code" inputMode="numeric" pattern="\d{6}" maxLength={6} required autoFocus
                                    value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                                    className="mono" style={{ letterSpacing: '.35em', textAlign: 'center', fontSize: 18 }}
                                />
                                {error && <p style={{ color: 'var(--color-breach)', fontSize: 12.5, marginTop: 12 }}>{error}</p>}
                                <button className="btn btn-primary" style={{ width: '100%', marginTop: 16 }} disabled={busy || code.length !== 6}>
                                    {busy ? 'Verifying…' : 'Bind authenticator'}
                                </button>
                            </form>
                        </div>
                    )}

                    {stage.name === 'mfa' && (
                        <form onSubmit={submitCode}>
                            <h2 style={{ fontSize: 16, marginBottom: 8 }}>Two-factor code</h2>
                            <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 18 }}>
                                {useRecovery
                                    ? 'Enter one of your recovery codes. Each can be used once.'
                                    : 'Enter the six-digit code from your authenticator.'}
                            </p>
                            <input
                                id="mfa-code"
                                inputMode={useRecovery ? 'text' : 'numeric'}
                                maxLength={useRecovery ? 24 : 6}
                                required autoFocus
                                value={code}
                                onChange={(e) => setCode(useRecovery ? e.target.value.toUpperCase() : e.target.value.replace(/\D/g, ''))}
                                className="mono"
                                style={{ letterSpacing: useRecovery ? '.1em' : '.35em', textAlign: 'center', fontSize: 18 }}
                            />
                            {error && <p style={{ color: 'var(--color-breach)', fontSize: 12.5, marginTop: 12 }}>{error}</p>}
                            <button
                                className="btn btn-primary" style={{ width: '100%', marginTop: 16 }}
                                disabled={busy || (useRecovery ? code.length < 4 : code.length !== 6)}
                            >
                                {busy ? 'Verifying…' : 'Sign in'}
                            </button>
                            <button
                                type="button"
                                onClick={() => { setUseRecovery(!useRecovery); setCode(''); setError(null); }}
                                style={{
                                    marginTop: 14, background: 'none', border: 'none', cursor: 'pointer',
                                    fontSize: 12, color: 'var(--muted)', width: '100%', fontFamily: 'inherit',
                                }}
                            >
                                {useRecovery ? 'Use my authenticator instead' : 'Lost your device? Use a recovery code'}
                            </button>
                        </form>
                    )}

                    {stage.name === 'recovery_codes' && (
                        <div>
                            <h2 style={{ fontSize: 16, marginBottom: 8 }}>Save your recovery codes</h2>
                            <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 16 }}>
                                These are shown once and are the only way back in if you lose your device.
                                Store them somewhere that is not the device running your authenticator.
                            </p>
                            <div className="mono" style={{
                                display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7,
                                padding: 14, background: 'var(--bg)', borderRadius: 'var(--radius-md)', marginBottom: 18,
                            }}>
                                {stage.codes.map((c) => <div key={c}>{c}</div>)}
                            </div>
                            <button
                                className="btn btn-primary" style={{ width: '100%' }}
                                onClick={() => pending && signIn(pending.admin, pending.expiresAt, pending.idle)}
                            >
                                I have saved them — continue
                            </button>
                        </div>
                    )}
                </div>

                <p style={{ textAlign: 'center', marginTop: 18, fontSize: 11.5, color: 'var(--muted-2)', lineHeight: 1.6 }}>
                    Every action in this console is recorded with your name, the time, and your reason.
                    <br />Sessions end after 8 hours, or 30 minutes of inactivity.
                </p>
            </div>
        </div>
    );
}
