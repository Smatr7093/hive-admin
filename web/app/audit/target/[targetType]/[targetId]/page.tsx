'use client';

/**
 * Everything that ever happened to one record, oldest first.
 *
 * This is the screen that answers "who let this account through" — the question
 * §1 of the PRD says currently has no answer. Given a KYC submission ID, it
 * returns the whole life of that record: who viewed the document, who unmasked
 * what, who decided, and why.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { PageHeader, Panel, Pill, Loading, ErrorNote, Empty } from '@/components/ui';
import { dateTime, relativeTime, titleCase, ROLE_LABELS } from '@/lib/format';

export default function AuditTargetPage() {
    const { targetType, targetId } = useParams<{ targetType: string; targetId: string }>();
    const decoded = decodeURIComponent(targetId);
    const [entries, setEntries] = useState<any[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = () => {
        setError(null);
        api<any>(`/audit/target/${targetType}/${encodeURIComponent(decoded)}`)
            .then((r) => setEntries(r.data))
            .catch((e) => setError(e.message));
    };

    useEffect(load, [targetType, decoded]);

    return (
        <>
            <div style={{ marginBottom: 14 }}>
                <Link href="/audit" style={{ fontSize: 12.5, color: 'var(--muted)' }}>← Back to the audit log</Link>
            </div>

            <PageHeader
                title={`History — ${titleCase(targetType)}`}
                subtitle={decoded}
            />

            {error && <ErrorNote error={error} onRetry={load} />}
            {!entries && !error && <Panel><Loading /></Panel>}

            {entries && (
                <Panel>
                    {entries.length === 0 ? (
                        <Empty message="Nothing recorded against this record" />
                    ) : (
                        <div style={{ display: 'grid', gap: 0 }}>
                            {entries.map((e, i) => (
                                <div key={e.eventId} style={{ display: 'flex', gap: 16 }}>
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 12 }}>
                                        <div style={{ width: 9, height: 9, borderRadius: 999, background: 'var(--color-accent)', flexShrink: 0, marginTop: 5 }} />
                                        {i < entries.length - 1 && (
                                            <div style={{ width: 2, flex: 1, minHeight: 32, background: 'var(--border-2)' }} />
                                        )}
                                    </div>
                                    <div style={{ paddingBottom: 22, flex: 1 }}>
                                        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                                            <span className="mono" style={{ fontWeight: 700, fontSize: 12.5 }}>{e.action}</span>
                                            <Pill tone="neutral">{ROLE_LABELS[e.actorRole] ?? e.actorRole ?? 'system'}</Pill>
                                            <span style={{ fontSize: 12, color: 'var(--muted-2)' }}>
                                                {e.actorEmail ?? 'system'} · {dateTime(e.at)} ({relativeTime(e.at)})
                                            </span>
                                        </div>
                                        {e.reason && (
                                            <div style={{ fontSize: 13, marginTop: 5, lineHeight: 1.55 }}>{e.reason}</div>
                                        )}
                                        {(e.before || e.after) && (
                                            <div className="mono" style={{ fontSize: 11, color: 'var(--muted-2)', marginTop: 5 }}>
                                                {e.before && <>from {JSON.stringify(e.before)} </>}
                                                {e.after && <>to {JSON.stringify(e.after)}</>}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </Panel>
            )}
        </>
    );
}
