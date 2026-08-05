/**
 * Finance — payouts, refunds, reconciliation (PRD §8.1, §8.2).
 *
 * §8.3 (tax) is deliberately not implemented. It is gated on the CA consultation
 * for 194-O TDS and GST TCS, and the PRD is explicit that the payout data model
 * is blocked on the same conversation. Building F-13..F-17 against a guess would
 * mean companions querying Form 16A figures that do not reconcile with what they
 * were paid. See taxController.js for the gate and what it needs.
 *
 * Two controls worth pointing at:
 *
 *  F-07 payout-mule detection. Bank accounts are stored with
 *       hash(account_number + IFSC); a collision across companion profiles is
 *       flagged on the payout, on the bank account, and on the dashboard.
 *  F-10 dual approval above a threshold. The *same admin* cannot request and
 *       approve — enforced by comparing adminIds, not by asking nicely.
 */

const { store, TABLES, ConflictError } = require('../lib/store');
const audit = require('../lib/audit');
const { randomId, hashBankAccount } = require('../lib/crypto');
const { maskFor } = require('../lib/mask');
const { alertSuperAdmin, notifyUser } = require('../lib/notify');
const {
    FINANCE, PAYOUT_HOLD_REASONS, REFUND_REASONS, PERM,
} = require('../config/constants');

const money = (paise) => Math.round(Number(paise) || 0);

// ─── F-01 — payout queue ─────────────────────────────────────────────────────

exports.payouts = async (req, res, next) => {
    try {
        const { status = 'all', companionId } = req.query;
        const payouts = await store.list(TABLES.PAYOUTS, {
            filter: (p) => (status === 'all' || p.status === status) && (!companionId || p.companionId === companionId),
        });

        const accounts = await store.list(TABLES.BANK_ACCOUNTS);
        const byHash = new Map();
        for (const a of accounts) {
            byHash.set(a.accountHash, [...(byHash.get(a.accountHash) ?? []), a.companionId]);
        }

        const data = await Promise.all(payouts
            .sort((a, b) => (b.requestedAt ?? '').localeCompare(a.requestedAt ?? ''))
            .map(async (p) => {
                const account = accounts.find((a) => a.bankAccountId === p.bankAccountId);
                const sharedWith = account ? [...new Set(byHash.get(account.accountHash) ?? [])] : [];
                return {
                    ...p,
                    // F-05 — the fund account behind the payout, masked per §4.
                    fundAccount: account
                        ? await maskFor(req.admin, {
                            bankAccountId: account.bankAccountId,
                            accountHolderName: account.accountHolderName,
                            accountNumber: account.accountNumber,
                            ifscCode: account.ifscCode,
                            bankName: account.bankName,
                            isVerified: account.isVerified,
                        }, { recordType: 'bank_account', recordId: account.bankAccountId })
                        : null,
                    // F-06 — bank details changed inside the cooling-off window.
                    coolingOff: coolingOffState(account),
                    // F-07 — one account, several companion profiles.
                    muleSignal: sharedWith.length > 1
                        ? { sharedWithProfiles: sharedWith.filter((id) => id !== p.companionId) }
                        : null,
                };
            }));

        return res.json({
            success: true,
            data,
            meta: {
                total: data.length,
                requested: data.filter((p) => p.status === 'requested').length,
                processing: data.filter((p) => p.status === 'processing').length,
                paid: data.filter((p) => p.status === 'paid').length,
                failed: data.filter((p) => p.status === 'failed').length,
                held: data.filter((p) => p.status === 'held').length,
                muleFlagged: data.filter((p) => p.muleSignal).length,
                coolingOff: data.filter((p) => p.coolingOff?.active).length,
                totalPendingPaise: data
                    .filter((p) => ['requested', 'processing'].includes(p.status))
                    .reduce((sum, p) => sum + money(p.amount), 0),
            },
        });
    } catch (err) {
        return next(err);
    }
};

/** F-06 — 48-hour cooling-off after a bank detail change (v2.0 M-10). */
function coolingOffState(account) {
    if (!account?.detailsChangedAt) return { active: false };
    const endsAt = Date.parse(account.detailsChangedAt) + FINANCE.BANK_CHANGE_COOLING_HOURS * 3_600_000;
    const active = Date.now() < endsAt;
    return {
        active,
        changedAt: account.detailsChangedAt,
        endsAt: new Date(endsAt).toISOString(),
        remainingHours: active ? Math.ceil((endsAt - Date.now()) / 3_600_000) : 0,
    };
}

// ─── F-02 / F-03 — hold and release ──────────────────────────────────────────

exports.holdPayout = async (req, res, next) => {
    try {
        const { payoutId } = req.params;
        const { reasonCode, note } = req.body;
        const reason = PAYOUT_HOLD_REASONS.find((r) => r.id === reasonCode);

        const payout = await store.get(TABLES.PAYOUTS, payoutId);
        if (!payout) return res.status(404).json({ success: false, message: 'Payout not found' });
        if (payout.status === 'paid') {
            return res.status(409).json({ success: false, message: 'This payout has already been paid — use reconciliation instead' });
        }
        if (payout.status === 'held') {
            return res.status(409).json({ success: false, message: 'Already held' });
        }

        const now = new Date().toISOString();
        const updated = await store.patch(
            TABLES.PAYOUTS,
            payoutId,
            {
                status: 'held',
                previousStatus: payout.status,
                holdReasonCode: reasonCode,
                holdReason: reason.label,
                holdNote: note ?? null,
                heldBy: req.admin.adminId,
                heldAt: now,
            },
            { expectedVersion: req.expectedVersion }
        );

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.PAYOUT_HELD,
            targetType: 'payout',
            targetId: payoutId,
            reason: note ? `${reason.label} — ${note}` : reason.label,
            reasonCode,
            before: { status: payout.status },
            after: { status: 'held' },
            metadata: { companionId: payout.companionId, amount: payout.amount },
            request: req,
        });

        return res.json({ success: true, data: updated });
    } catch (err) {
        if (err instanceof ConflictError) return res.status(409).json({ success: false, code: 'VERSION_CONFLICT', message: 'Actioned by another admin' });
        return next(err);
    }
};

exports.releasePayout = async (req, res, next) => {
    try {
        const { payoutId } = req.params;
        const { note } = req.body ?? {};
        if (!note || String(note).trim().length < 10) {
            return res.status(400).json({ success: false, message: 'Releasing a held payout requires a written reason' });
        }

        const payout = await store.get(TABLES.PAYOUTS, payoutId);
        if (!payout) return res.status(404).json({ success: false, message: 'Payout not found' });
        if (payout.status !== 'held') return res.status(409).json({ success: false, message: 'This payout is not held' });

        const account = payout.bankAccountId ? await store.get(TABLES.BANK_ACCOUNTS, payout.bankAccountId) : null;
        const cooling = coolingOffState(account);
        if (cooling.active && !req.body.overrideCoolingOff) {
            return res.status(409).json({
                success: false,
                code: 'COOLING_OFF_ACTIVE',
                message: `Bank details changed ${cooling.remainingHours}h ago — the ${FINANCE.BANK_CHANGE_COOLING_HOURS}h cooling-off is still running. Pass overrideCoolingOff with a reason to release anyway.`,
                coolingOff: cooling,
            });
        }

        const now = new Date().toISOString();
        const updated = await store.patch(
            TABLES.PAYOUTS,
            payoutId,
            {
                status: payout.previousStatus ?? 'requested',
                holdReasonCode: null,
                holdReason: null,
                releasedBy: req.admin.adminId,
                releasedAt: now,
                releaseNote: note,
            },
            { expectedVersion: req.expectedVersion }
        );

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.PAYOUT_RELEASED,
            targetType: 'payout',
            targetId: payoutId,
            reason: note,
            before: { status: 'held', holdReason: payout.holdReason },
            after: { status: updated.status },
            metadata: {
                companionId: payout.companionId,
                amount: payout.amount,
                coolingOffOverridden: cooling.active,
            },
            request: req,
        });

        if (cooling.active) {
            await alertSuperAdmin({
                kind: 'cooling_off_override',
                severity: 'warning',
                title: 'Payout released inside the bank-change cooling-off window',
                body: `${req.admin.email} released payout ${payoutId} with ${cooling.remainingHours}h of cooling-off remaining. Reason: ${note}`,
                relatedType: 'payout',
                relatedId: payoutId,
            });
        }

        return res.json({ success: true, data: updated });
    } catch (err) {
        if (err instanceof ConflictError) return res.status(409).json({ success: false, code: 'VERSION_CONFLICT', message: 'Actioned by another admin' });
        return next(err);
    }
};

// ─── F-04 — failed payouts ───────────────────────────────────────────────────

exports.retryPayout = async (req, res, next) => {
    try {
        const { payoutId } = req.params;
        const { note } = req.body ?? {};
        const payout = await store.get(TABLES.PAYOUTS, payoutId);
        if (!payout) return res.status(404).json({ success: false, message: 'Payout not found' });
        if (payout.status !== 'failed') {
            return res.status(409).json({ success: false, message: 'Only a failed payout can be retried' });
        }

        const attempts = (payout.attempts ?? 1) + 1;
        const updated = await store.patch(
            TABLES.PAYOUTS,
            payoutId,
            {
                status: 'requested',
                attempts,
                lastRetryAt: new Date().toISOString(),
                lastRetryBy: req.admin.adminId,
                gatewayError: null,
            },
            { expectedVersion: req.expectedVersion }
        );

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.PAYOUT_RETRIED,
            targetType: 'payout',
            targetId: payoutId,
            reason: note ?? 'Failed payout retried',
            before: { status: 'failed', gatewayError: payout.gatewayError },
            after: { status: 'requested', attempts },
            request: req,
        });

        return res.json({ success: true, data: updated });
    } catch (err) {
        if (err instanceof ConflictError) return res.status(409).json({ success: false, code: 'VERSION_CONFLICT', message: 'Actioned by another admin' });
        return next(err);
    }
};

// ─── F-07 — mule detection across all accounts ───────────────────────────────

exports.bankAccountCollisions = async (_req, res, next) => {
    try {
        const accounts = await store.list(TABLES.BANK_ACCOUNTS);
        const groups = new Map();
        for (const a of accounts) {
            const hash = a.accountHash ?? hashBankAccount(a.accountNumber, a.ifscCode);
            groups.set(hash, [...(groups.get(hash) ?? []), a]);
        }
        const collisions = [...groups.entries()]
            .filter(([, list]) => new Set(list.map((a) => a.companionId)).size > 1)
            .map(([hash, list]) => ({
                accountHash: hash,
                bankName: list[0].bankName,
                profiles: list.map((a) => ({
                    companionId: a.companionId,
                    accountHolderName: a.accountHolderName,
                    bankAccountId: a.bankAccountId,
                    addedAt: a.createdAt,
                })),
            }));

        return res.json({ success: true, data: collisions, meta: { flagged: collisions.length } });
    } catch (err) {
        return next(err);
    }
};

// ─── F-08 — daily reconciliation ─────────────────────────────────────────────

/**
 * Gateway settlements against the internal ledger, per day. A discrepancy is any
 * payout where the two disagree on state or amount — including the §12 case where
 * the ledger says paid and the gateway says failed.
 */
exports.reconciliation = async (req, res, next) => {
    try {
        const { date } = req.query;
        const day = date ?? new Date().toISOString().slice(0, 10);

        const payouts = await store.list(TABLES.PAYOUTS, {
            filter: (p) => (p.settledAt ?? p.requestedAt ?? '').startsWith(day),
        });
        const settlements = await store.list(TABLES.RECONCILIATION, { filter: (r) => r.date === day });
        const byPayoutId = new Map(settlements.map((s) => [s.payoutId, s]));

        const rows = payouts.map((p) => {
            const gateway = byPayoutId.get(p.payoutId);
            const ledgerAmount = money(p.amount);
            const gatewayAmount = gateway ? money(gateway.amount) : null;

            let discrepancy = null;
            if (!gateway && ['paid', 'processing'].includes(p.status)) {
                discrepancy = { type: 'missing_settlement', detail: 'Ledger shows movement, gateway reported nothing' };
            } else if (gateway && gatewayAmount !== ledgerAmount) {
                discrepancy = { type: 'amount_mismatch', detail: `Ledger ${ledgerAmount} vs gateway ${gatewayAmount}` };
            } else if (gateway && gateway.status === 'failed' && p.status === 'paid') {
                // PRD §12 — payout failed after the ledger marked it paid.
                discrepancy = { type: 'failed_after_paid', detail: 'Gateway failed a payout the ledger records as paid' };
            } else if (gateway && gateway.status === 'paid' && p.status !== 'paid') {
                discrepancy = { type: 'paid_not_recorded', detail: `Gateway paid, ledger shows ${p.status}` };
            }

            return {
                payoutId: p.payoutId,
                companionId: p.companionId,
                ledgerStatus: p.status,
                ledgerAmount,
                gatewayStatus: gateway?.status ?? null,
                gatewayAmount,
                gatewayReference: gateway?.reference ?? null,
                discrepancy,
                resolvedAt: gateway?.resolvedAt ?? null,
            };
        });

        // Settlements the gateway reported that have no matching ledger row at all.
        for (const s of settlements) {
            if (!payouts.some((p) => p.payoutId === s.payoutId)) {
                rows.push({
                    payoutId: s.payoutId,
                    companionId: s.companionId ?? null,
                    ledgerStatus: null,
                    ledgerAmount: null,
                    gatewayStatus: s.status,
                    gatewayAmount: money(s.amount),
                    gatewayReference: s.reference,
                    discrepancy: { type: 'orphan_settlement', detail: 'Gateway settlement with no ledger entry' },
                    resolvedAt: s.resolvedAt ?? null,
                });
            }
        }

        const open = rows.filter((r) => r.discrepancy && !r.resolvedAt);
        return res.json({
            success: true,
            data: rows,
            meta: {
                date: day,
                rows: rows.length,
                discrepancies: open.length,
                ledgerTotalPaise: rows.reduce((s, r) => s + (r.ledgerAmount ?? 0), 0),
                gatewayTotalPaise: rows.reduce((s, r) => s + (r.gatewayAmount ?? 0), 0),
                balanced: open.length === 0,
            },
        });
    } catch (err) {
        return next(err);
    }
};

/** §12 — a reconciliation correction is itself dual-approved. */
exports.resolveDiscrepancy = async (req, res, next) => {
    try {
        const { reconId } = req.params;
        const { note, correctedStatus } = req.body ?? {};
        if (!note || String(note).trim().length < 15) {
            return res.status(400).json({ success: false, message: 'A written explanation of the correction is required' });
        }
        const recon = await store.get(TABLES.RECONCILIATION, reconId);
        if (!recon) return res.status(404).json({ success: false, message: 'Reconciliation row not found' });

        if (!recon.correctionRequestedBy) {
            const updated = await store.patch(TABLES.RECONCILIATION, reconId, {
                correctionRequestedBy: req.admin.adminId,
                correctionRequestedAt: new Date().toISOString(),
                correctionNote: note,
                proposedStatus: correctedStatus ?? null,
            });
            await audit.record({
                actor: req.admin,
                action: audit.ACTIONS.RECON_DISCREPANCY_RESOLVED,
                targetType: 'reconciliation',
                targetId: reconId,
                reason: `Correction proposed: ${note}`,
                request: req,
            });
            return res.json({ success: true, stage: 'awaiting_second_approval', data: updated });
        }

        if (recon.correctionRequestedBy === req.admin.adminId) {
            return res.status(403).json({
                success: false,
                code: 'DUAL_APPROVAL_SAME_ADMIN',
                message: 'A second admin must approve this correction',
            });
        }

        const updated = await store.patch(TABLES.RECONCILIATION, reconId, {
            resolvedAt: new Date().toISOString(),
            resolvedBy: req.admin.adminId,
            status: recon.proposedStatus ?? recon.status,
            resolutionNote: note,
        });
        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.RECON_DISCREPANCY_RESOLVED,
            targetType: 'reconciliation',
            targetId: reconId,
            reason: note,
            before: { status: recon.status },
            after: { status: updated.status },
            metadata: { proposedBy: recon.correctionRequestedBy, approvedBy: req.admin.adminId },
            request: req,
        });
        return res.json({ success: true, stage: 'resolved', data: updated });
    } catch (err) {
        return next(err);
    }
};

// ─── F-09 / F-10 — refunds ───────────────────────────────────────────────────

exports.listRefunds = async (req, res, next) => {
    try {
        const { status = 'all', userId, companionId } = req.query;
        const refunds = await store.list(TABLES.REFUNDS, {
            filter: (r) =>
                (status === 'all' || r.status === status) &&
                (!userId || r.userId === userId) &&
                (!companionId || r.companionId === companionId),
        });
        return res.json({
            success: true,
            data: refunds.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)),
            meta: {
                total: refunds.length,
                awaitingApproval: refunds.filter((r) => r.status === 'pending_approval').length,
                threshold: FINANCE.DUAL_APPROVAL_THRESHOLD_PAISE,
            },
        });
    } catch (err) {
        return next(err);
    }
};

exports.requestRefund = async (req, res, next) => {
    try {
        const { bookingId, amount, reasonCode, note, partial } = req.body;
        const reason = REFUND_REASONS.find((r) => r.id === reasonCode);
        if (!reason) {
            return res.status(400).json({ success: false, message: 'A valid reasonCode is required', allowed: REFUND_REASONS });
        }

        const booking = await store.get(TABLES.BOOKINGS, bookingId);
        if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

        // Server-side authority on money (carried from the v1 security review).
        // The client proposes; the server decides what is refundable.
        const alreadyRefunded = (await store.list(TABLES.REFUNDS, {
            filter: (r) => r.bookingId === bookingId && ['approved', 'issued'].includes(r.status),
        })).reduce((s, r) => s + money(r.amount), 0);

        const refundable = money(booking.totalAmount) - alreadyRefunded;
        const requested = money(amount);

        if (requested <= 0) return res.status(400).json({ success: false, message: 'Amount must be positive' });
        if (requested > refundable) {
            return res.status(400).json({
                success: false,
                code: 'EXCEEDS_REFUNDABLE',
                message: `Only ${refundable} remains refundable on this booking`,
                refundable, alreadyRefunded, bookingTotal: money(booking.totalAmount),
            });
        }

        const needsDualApproval = requested > FINANCE.DUAL_APPROVAL_THRESHOLD_PAISE; // F-10

        const refund = {
            refundId: randomId('rfd'),
            bookingId,
            userId: booking.userId,
            companionId: booking.companionId,
            amount: requested,
            currency: booking.currency ?? 'INR',
            partial: !!partial || requested < money(booking.totalAmount),
            reasonCode,
            reasonLabel: reason.label,
            note: note ?? null,
            status: needsDualApproval ? 'pending_approval' : 'approved',
            requestedBy: req.admin.adminId,
            requestedByEmail: req.admin.email,
            requestedAt: new Date().toISOString(),
            approvedBy: needsDualApproval ? null : req.admin.adminId,
            approvedAt: needsDualApproval ? null : new Date().toISOString(),
            threshold: FINANCE.DUAL_APPROVAL_THRESHOLD_PAISE,
        };
        await store.put(TABLES.REFUNDS, refund);

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.REFUND_REQUESTED,
            targetType: 'refund',
            targetId: refund.refundId,
            reason: note ? `${reason.label} — ${note}` : reason.label,
            reasonCode,
            after: { amount: requested, status: refund.status, bookingId },
            metadata: { needsDualApproval },
            request: req,
        });

        return res.status(201).json({ success: true, data: refund, needsDualApproval });
    } catch (err) {
        return next(err);
    }
};

/** F-10 — the second signature. The requester's own is not accepted. */
exports.approveRefund = async (req, res, next) => {
    try {
        const { refundId } = req.params;
        const { note } = req.body ?? {};
        const refund = await store.get(TABLES.REFUNDS, refundId);
        if (!refund) return res.status(404).json({ success: false, message: 'Refund not found' });
        if (refund.status !== 'pending_approval') {
            return res.status(409).json({ success: false, message: `Refund is ${refund.status}` });
        }
        if (refund.requestedBy === req.admin.adminId) {
            return res.status(403).json({
                success: false,
                code: 'DUAL_APPROVAL_SAME_ADMIN',
                message: `Refunds above ${FINANCE.DUAL_APPROVAL_THRESHOLD_PAISE} require a second admin's approval (F-10)`,
            });
        }

        const now = new Date().toISOString();
        const updated = await store.patch(
            TABLES.REFUNDS,
            refundId,
            { status: 'approved', approvedBy: req.admin.adminId, approvedByEmail: req.admin.email, approvedAt: now, approvalNote: note ?? null },
            { expectedVersion: req.expectedVersion }
        );

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.REFUND_APPROVED,
            targetType: 'refund',
            targetId: refundId,
            reason: note ?? 'Second approval given',
            before: { status: 'pending_approval' },
            after: { status: 'approved' },
            metadata: { amount: refund.amount, requestedBy: refund.requestedBy },
            request: req,
        });

        await notifyUser({
            userId: refund.userId,
            channel: 'refund',
            title: 'Your refund has been approved',
            body: `A refund of ₹${(refund.amount / 100).toFixed(2)} is on its way. Reason: ${refund.reasonLabel}.`,
            relatedType: 'refund',
            relatedId: refundId,
        });

        return res.json({ success: true, data: updated });
    } catch (err) {
        if (err instanceof ConflictError) return res.status(409).json({ success: false, code: 'VERSION_CONFLICT', message: 'Actioned by another admin' });
        return next(err);
    }
};

exports.rejectRefund = async (req, res, next) => {
    try {
        const { refundId } = req.params;
        const { note } = req.body ?? {};
        if (!note) return res.status(400).json({ success: false, message: 'A reason is required' });
        const refund = await store.get(TABLES.REFUNDS, refundId);
        if (!refund) return res.status(404).json({ success: false, message: 'Refund not found' });

        const updated = await store.patch(TABLES.REFUNDS, refundId, {
            status: 'rejected',
            rejectedBy: req.admin.adminId,
            rejectedAt: new Date().toISOString(),
            rejectionNote: note,
        });
        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.REFUND_REJECTED,
            targetType: 'refund',
            targetId: refundId,
            reason: note,
            before: { status: refund.status },
            after: { status: 'rejected' },
            request: req,
        });
        return res.json({ success: true, data: updated });
    } catch (err) {
        return next(err);
    }
};

// ─── F-11 — refund history ───────────────────────────────────────────────────

exports.refundHistory = async (req, res, next) => {
    try {
        const { userId } = req.params;
        const asSeeker = await store.list(TABLES.REFUNDS, { filter: (r) => r.userId === userId });
        const asCompanion = await store.list(TABLES.REFUNDS, { filter: (r) => r.companionId === userId });
        return res.json({
            success: true,
            data: {
                asSeeker: asSeeker.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)),
                asCompanion: asCompanion.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)),
                totals: {
                    asSeekerPaise: asSeeker.filter((r) => ['approved', 'issued'].includes(r.status)).reduce((s, r) => s + money(r.amount), 0),
                    asCompanionPaise: asCompanion.filter((r) => ['approved', 'issued'].includes(r.status)).reduce((s, r) => s + money(r.amount), 0),
                },
            },
        });
    } catch (err) {
        return next(err);
    }
};

// ─── F-12 — goodwill credit, Support below a low ceiling ─────────────────────

exports.issueGoodwill = async (req, res, next) => {
    try {
        const { userId, amount, note } = req.body ?? {};
        const value = money(amount);
        if (!userId || value <= 0) {
            return res.status(400).json({ success: false, message: 'userId and a positive amount are required' });
        }
        if (!note) return res.status(400).json({ success: false, message: 'A reason is required' });

        // The ceiling applies to anyone without full refund authority — which is
        // what makes it a Support tool rather than a second refund path.
        const uncapped = req.admin.permissions.includes(PERM.REFUND_APPROVE);
        if (!uncapped && value > FINANCE.GOODWILL_MAX_PAISE) {
            return res.status(403).json({
                success: false,
                code: 'GOODWILL_LIMIT',
                message: `Goodwill credits are capped at ₹${FINANCE.GOODWILL_MAX_PAISE / 100} for your role`,
                limit: FINANCE.GOODWILL_MAX_PAISE,
            });
        }

        const credit = {
            refundId: randomId('gwc'),
            userId,
            bookingId: req.body.bookingId ?? null,
            companionId: null,
            amount: value,
            currency: 'INR',
            reasonCode: 'goodwill',
            reasonLabel: 'Goodwill',
            note,
            status: 'approved',
            type: 'goodwill_credit',
            requestedBy: req.admin.adminId,
            requestedByEmail: req.admin.email,
            requestedAt: new Date().toISOString(),
            approvedBy: req.admin.adminId,
            approvedAt: new Date().toISOString(),
        };
        await store.put(TABLES.REFUNDS, credit);

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.GOODWILL_ISSUED,
            targetType: 'user',
            targetId: userId,
            reason: note,
            after: { amount: value },
            request: req,
        });

        await notifyUser({
            userId,
            channel: 'refund',
            title: 'A credit has been added to your account',
            body: `₹${(value / 100).toFixed(2)} has been credited. ${note}`,
            relatedType: 'goodwill_credit',
            relatedId: credit.refundId,
        });

        return res.status(201).json({ success: true, data: credit });
    } catch (err) {
        return next(err);
    }
};

exports.meta = (_req, res) => res.json({
    success: true,
    data: {
        holdReasons: PAYOUT_HOLD_REASONS,
        refundReasons: REFUND_REASONS,
        dualApprovalThresholdPaise: FINANCE.DUAL_APPROVAL_THRESHOLD_PAISE,
        goodwillMaxPaise: FINANCE.GOODWILL_MAX_PAISE,
        coolingOffHours: FINANCE.BANK_CHANGE_COOLING_HOURS,
    },
});
