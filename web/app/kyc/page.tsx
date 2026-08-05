'use client';

/**
 * KYC queue (PRD §5).
 *
 * Oldest first, always — the sort is not a control the reviewer can change,
 * because a sortable queue becomes a queue where the easy items get done and the
 * awkward ones age quietly.
 *
 * Age and duplicate flags appear in the list rather than only on the detail
 * screen, so a reviewer can see which items need care before they open one.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { PageHeader, Panel, Pill, Loading, ErrorNote, Empty, Icon } from '@/components/ui';
import { relativeTime } from '@/lib/format';

export default function KycQueuePage() {
    const [status, setStatus] = useState('open');
    const [data, setData] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);

    const load = () => {
        setData(null);
        setError(null);
        api<any>(`/kyc/queue?status=${status}`).then(setData).catch((e) => setError(e.message));
    };

    useEffect(load, [status]);

    return (
        <>
            <PageHeader
                title="KYC queue"
                subtitle="Oldest first. Age and duplicate-identity checks are computed for every item — an applicant who does not compute as 18 or over cannot be approved without an explicit override."
            >
                <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 180 }}>
                    <option value="open">Open (pending + manual review)</option>
                    <option value="pending">Pending only</option>
                    <option value="manual_review">Manual review</option>
                    <option value="rejected">Rejected</option>
                    <option value="approved">Approved</option>
                    <option value="all">All</option>
                </select>
                <button className="btn" onClick={load}><Icon name="refresh" size={14} /></button>
            </PageHeader>

            {error && <ErrorNote error={error} onRetry={load} />}
            {!data && !error && <Panel><Loading /></Panel>}

            {data && (
                <>
                    {data.meta.total > 0 && (
                        <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
                            <Pill tone="neutral">{data.meta.total} in queue</Pill>
                            <Pill tone={data.meta.oldestHours > 12 ? 'warning' : 'ok'}>
                                Oldest {data.meta.oldestHours}h — target is a decision within 12h
                            </Pill>
                            {data.meta.underageFlagged > 0 && (
                                <Pill tone="breach">{data.meta.underageFlagged} failing the age check</Pill>
                            )}
                            {data.meta.duplicatesFlagged > 0 && (
                                <Pill tone="critical">{data.meta.duplicatesFlagged} with a duplicate identity</Pill>
                            )}
                        </div>
                    )}

                    <Panel padded={false}>
                        {data.data.length === 0 ? (
                            <Empty message="Nothing in the queue" hint="Every submission has been decided." />
                        ) : (
                            <table>
                                <thead>
                                    <tr>
                                        <th>Applicant</th>
                                        <th>Waiting</th>
                                        <th>Attempt</th>
                                        <th>Age check</th>
                                        <th>Flags</th>
                                        <th>Status</th>
                                        <th />
                                    </tr>
                                </thead>
                                <tbody>
                                    {data.data.map((item: any) => {
                                        const failsAge = !item.ageCheck.passes;
                                        return (
                                            <tr
                                                key={item.submissionId}
                                                className={failsAge || item.duplicateCount > 0 ? 'row-breach' : item.hoursInQueue > 12 ? 'row-warning' : ''}
                                            >
                                                <td>
                                                    <div style={{ fontWeight: 600 }}>{item.name ?? '—'}</div>
                                                    <div className="mono" style={{ color: 'var(--muted-2)' }}>{item.userId}</div>
                                                </td>
                                                <td>
                                                    <span style={{ fontWeight: item.hoursInQueue > 12 ? 700 : 400 }}>
                                                        {item.hoursInQueue}h
                                                    </span>
                                                    <div style={{ fontSize: 11, color: 'var(--muted-2)' }}>{relativeTime(item.submittedAt)}</div>
                                                </td>
                                                <td>
                                                    {item.attemptNumber} of {3}
                                                    {item.rejectionCount > 0 && (
                                                        <div style={{ fontSize: 11, color: 'var(--muted-2)' }}>
                                                            {item.rejectionCount} rejected
                                                        </div>
                                                    )}
                                                </td>
                                                <td>
                                                    {item.ageCheck.indeterminate ? (
                                                        <Pill tone="warning">DOB unreadable</Pill>
                                                    ) : failsAge ? (
                                                        <Pill tone="breach">{item.ageCheck.documentAge} — under 18</Pill>
                                                    ) : (
                                                        <Pill tone="ok">{item.ageCheck.documentAge}</Pill>
                                                    )}
                                                </td>
                                                <td>
                                                    {item.duplicateCount > 0
                                                        ? <Pill tone="critical">{item.duplicateCount} duplicate ID</Pill>
                                                        : <span style={{ color: 'var(--muted-2)' }}>—</span>}
                                                </td>
                                                <td><Pill tone={item.status === 'manual_review' ? 'warning' : 'neutral'}>{item.status.replace('_', ' ')}</Pill></td>
                                                <td style={{ textAlign: 'right' }}>
                                                    <Link href={`/kyc/${item.submissionId}`}>
                                                        <span className="btn btn-sm">Review <Icon name="chevron" size={12} /></span>
                                                    </Link>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        )}
                    </Panel>
                </>
            )}
        </>
    );
}
