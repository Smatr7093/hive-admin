/**
 * Bookings and disputes (PRD §7).
 *
 * B-09 deserves calling out: an alert when one party blocks the other during an
 * active booking is treated as a distress signal, not a routine event. It raises
 * a Super Admin alert and lands at the top of the dispute queue.
 */

const { store, TABLES, ConflictError } = require('../lib/store');
const audit = require('../lib/audit');
const { alertSuperAdmin, notifyUser } = require('../lib/notify');
const { maskFor } = require('../lib/mask');
const { BOOKING_FORCE_REASONS, REFUND_REASONS } = require('../config/constants');
const { randomId } = require('../lib/crypto');

const DISPUTE_WINDOW_MS = 24 * 3_600_000; // v2.0 dispute window

// ─── B-01 — search ───────────────────────────────────────────────────────────

exports.search = async (req, res, next) => {
    try {
        const { q, userId, companionId, status, from, to, limit = 100 } = req.query;
        const needle = q ? String(q).toLowerCase() : null;

        const items = await store.list(TABLES.BOOKINGS, {
            filter: (b) => {
                if (userId && b.userId !== userId) return false;
                if (companionId && b.companionId !== companionId) return false;
                if (status && b.status !== status) return false;
                if (from && b.selectedDate < from) return false;
                if (to && b.selectedDate > to) return false;
                if (needle) {
                    const hay = [b.bookingId, b.userId, b.companionId, b.companionName, b.serviceTitle]
                        .join(' ').toLowerCase();
                    if (!hay.includes(needle)) return false;
                }
                return true;
            },
        });

        items.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
        return res.json({ success: true, data: items.slice(0, Number(limit)), meta: { total: items.length } });
    } catch (err) {
        return next(err);
    }
};

// ─── B-02 — the timeline ─────────────────────────────────────────────────────

/**
 * requested → accepted → paid → checked in → completed, with timestamps.
 *
 * Stages the booking never reached are returned as `pending: true` rather than
 * omitted, so the console renders the gap. "Paid but never checked in" is the
 * shape of most disputes and it should be visible at a glance.
 */
function buildTimeline(booking) {
    const t = booking.timeline ?? {};
    const stages = [
        { id: 'requested', label: 'Requested', at: t.requestedAt ?? booking.createdAt },
        { id: 'accepted', label: 'Accepted by companion', at: t.acceptedAt ?? null },
        { id: 'paid', label: 'Payment captured', at: t.paidAt ?? null },
        { id: 'checked_in', label: 'Checked in', at: t.checkedInAt ?? null },
        { id: 'completed', label: 'Completed', at: t.completedAt ?? null },
    ];
    if (booking.status === 'cancelled') {
        stages.push({ id: 'cancelled', label: 'Cancelled', at: t.cancelledAt ?? booking.updatedAt });
    }
    return stages.map((s) => ({ ...s, reached: !!s.at, pending: !s.at }));
}

exports.detail = async (req, res, next) => {
    try {
        const booking = await store.get(TABLES.BOOKINGS, req.params.bookingId);
        if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

        const [seeker, companion, dispute, payouts, refunds, reports] = await Promise.all([
            store.get(TABLES.USERS, booking.userId),
            store.get(TABLES.COMPANIONS, booking.companionId),
            store.list(TABLES.DISPUTES, { filter: (d) => d.bookingId === booking.bookingId }).then((d) => d[0] ?? null),
            store.list(TABLES.PAYOUTS, { filter: (p) => p.bookingIds?.includes(booking.bookingId) }),
            store.list(TABLES.REFUNDS, { filter: (r) => r.bookingId === booking.bookingId }),
            store.list(TABLES.REPORTS, { filter: (r) => r.relatedBookingId === booking.bookingId }),
        ]);

        return res.json({
            success: true,
            data: {
                ...booking,
                timeline: buildTimeline(booking),
                seeker: seeker ? await maskFor(req.admin, {
                    userId: seeker.userId, name: seeker.name, phone: seeker.phone, email: seeker.email,
                    accountStatus: seeker.accountStatus ?? 'active',
                    reliabilityScore: seeker.reliabilityScore ?? null,
                }, { recordType: 'user', recordId: seeker.userId }) : null,
                companion: companion ? await maskFor(req.admin, {
                    userId: companion.userId, name: companion.name, phone: companion.phone,
                    isKycVerified: companion.isKycVerified ?? false,
                    reliabilityScore: companion.reliabilityScore ?? null,
                }, { recordType: 'user', recordId: companion.userId }) : null,
                dispute,
                checkInFailure: booking.checkInFailure ?? null, // B-05, from v2.0 B-17
                noShowReports: booking.noShowReports ?? [],     // B-06
                relatedPayouts: payouts,
                relatedRefunds: refunds,
                relatedReports: reports.map((r) => ({ reportId: r.reportId, category: r.category, status: r.status })),
                forceReasons: BOOKING_FORCE_REASONS,
                refundReasons: REFUND_REASONS,
            },
        });
    } catch (err) {
        return next(err);
    }
};

// ─── B-03 / B-04 — force complete and force cancel ───────────────────────────

exports.forceComplete = async (req, res, next) => {
    try {
        const { bookingId } = req.params;
        const { reasonCode, note } = req.body;
        const reason = BOOKING_FORCE_REASONS.find((r) => r.id === reasonCode);

        const booking = await store.get(TABLES.BOOKINGS, bookingId);
        if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
        if (booking.status === 'completed') {
            return res.status(409).json({ success: false, message: 'Booking is already completed' });
        }

        const now = new Date().toISOString();
        const updated = await store.patch(
            TABLES.BOOKINGS,
            bookingId,
            {
                status: 'completed',
                updatedAt: now,
                timeline: { ...(booking.timeline ?? {}), completedAt: now },
                forcedCompletion: { by: req.admin.adminId, byEmail: req.admin.email, at: now, reasonCode, reasonLabel: reason.label, note: note ?? null },
            },
            { expectedVersion: req.expectedVersion }
        );

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.BOOKING_FORCE_COMPLETED,
            targetType: 'booking',
            targetId: bookingId,
            reason: note ? `${reason.label} — ${note}` : reason.label,
            reasonCode,
            before: { status: booking.status },
            after: { status: 'completed' },
            metadata: { userId: booking.userId, companionId: booking.companionId, amount: booking.totalAmount },
            request: req,
        });

        return res.json({ success: true, data: updated });
    } catch (err) {
        if (err instanceof ConflictError) return res.status(409).json({ success: false, code: 'VERSION_CONFLICT', message: 'Actioned by another admin' });
        return next(err);
    }
};

exports.forceCancel = async (req, res, next) => {
    try {
        const { bookingId } = req.params;
        const { reasonCode, note, refund = true, refundAmount } = req.body;
        const reason = BOOKING_FORCE_REASONS.find((r) => r.id === reasonCode);

        const booking = await store.get(TABLES.BOOKINGS, bookingId);
        if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
        if (booking.status === 'cancelled') {
            return res.status(409).json({ success: false, message: 'Booking is already cancelled' });
        }

        const now = new Date().toISOString();
        const updated = await store.patch(
            TABLES.BOOKINGS,
            bookingId,
            {
                status: 'cancelled',
                updatedAt: now,
                cancelReason: reason.label,
                timeline: { ...(booking.timeline ?? {}), cancelledAt: now },
                forcedCancellation: { by: req.admin.adminId, byEmail: req.admin.email, at: now, reasonCode, reasonLabel: reason.label, note: note ?? null },
            },
            { expectedVersion: req.expectedVersion }
        );

        let refundRecord = null;
        if (refund) {
            // Server-side authority on the amount (carried from the v1 security
            // review): a refund can never exceed what was actually collected,
            // whatever the client sends.
            const requested = refundAmount != null ? Number(refundAmount) : booking.totalAmount;
            const amount = Math.min(Math.max(0, requested), booking.totalAmount ?? 0);

            refundRecord = {
                refundId: randomId('rfd'),
                bookingId,
                userId: booking.userId,
                companionId: booking.companionId,
                amount,
                currency: booking.currency ?? 'INR',
                reasonCode: 'technical_failure',
                note: note ?? reason.label,
                status: 'pending_approval',
                requestedBy: req.admin.adminId,
                requestedAt: now,
                source: 'force_cancel',
            };
            await store.put(TABLES.REFUNDS, refundRecord);
        }

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.BOOKING_FORCE_CANCELLED,
            targetType: 'booking',
            targetId: bookingId,
            reason: note ? `${reason.label} — ${note}` : reason.label,
            reasonCode,
            before: { status: booking.status },
            after: { status: 'cancelled' },
            metadata: { refundId: refundRecord?.refundId ?? null, refundAmount: refundRecord?.amount ?? 0 },
            request: req,
        });

        await notifyUser({
            userId: booking.userId,
            channel: 'booking',
            title: 'Your booking was cancelled',
            body: refundRecord
                ? `Reason: ${reason.label}. A refund of ${booking.symbol ?? '₹'}${refundRecord.amount} is being processed.`
                : `Reason: ${reason.label}.`,
            relatedType: 'booking',
            relatedId: bookingId,
        });

        return res.json({ success: true, data: updated, refund: refundRecord });
    } catch (err) {
        if (err instanceof ConflictError) return res.status(409).json({ success: false, code: 'VERSION_CONFLICT', message: 'Actioned by another admin' });
        return next(err);
    }
};

// ─── B-07 — reliability score adjustment ─────────────────────────────────────

exports.adjustReliability = async (req, res, next) => {
    try {
        const { userId } = req.params;
        const { delta, absolute, note } = req.body ?? {};
        if (!note || String(note).trim().length < 10) {
            return res.status(400).json({ success: false, message: 'A written reason of at least 10 characters is required' });
        }
        if (delta == null && absolute == null) {
            return res.status(400).json({ success: false, message: 'Provide either delta or absolute' });
        }

        const table = (await store.get(TABLES.COMPANIONS, userId)) ? TABLES.COMPANIONS : TABLES.USERS;
        const record = await store.get(table, userId);
        if (!record) return res.status(404).json({ success: false, message: 'User not found' });

        const before = record.reliabilityScore ?? 100;
        const after = Math.max(0, Math.min(100, absolute != null ? Number(absolute) : before + Number(delta)));

        const updated = await store.patch(table, userId, {
            reliabilityScore: after,
            reliabilityAdjustedAt: new Date().toISOString(),
            reliabilityAdjustedBy: req.admin.adminId,
        });

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.RELIABILITY_ADJUSTED,
            targetType: 'user',
            targetId: userId,
            reason: note,
            before: { reliabilityScore: before },
            after: { reliabilityScore: after },
            request: req,
        });

        return res.json({ success: true, data: { userId, before, after, record: updated } });
    } catch (err) {
        return next(err);
    }
};

// ─── B-08 — dispute queue ────────────────────────────────────────────────────

exports.disputes = async (req, res, next) => {
    try {
        const { status = 'open' } = req.query;
        const now = Date.now();
        const items = await store.list(TABLES.DISPUTES, {
            filter: (d) => status === 'all' || d.status === status,
        });

        const data = items.map((d) => {
            const opened = Date.parse(d.openedAt);
            const windowClosesAt = opened + DISPUTE_WINDOW_MS;
            const remainingMs = windowClosesAt - now;
            return {
                ...d,
                // B-08 — the 24-hour window state is the thing the queue is
                // sorted and coloured by.
                window: {
                    closesAt: new Date(windowClosesAt).toISOString(),
                    remainingMs,
                    state: remainingMs <= 0 ? 'closed' : remainingMs < 4 * 3_600_000 ? 'critical' : 'open',
                },
            };
        });

        data.sort((a, b) => {
            if (!!a.blockSignal !== !!b.blockSignal) return a.blockSignal ? -1 : 1; // B-09 first
            return a.window.remainingMs - b.window.remainingMs;
        });

        return res.json({
            success: true,
            data,
            meta: {
                total: data.length,
                windowClosing: data.filter((d) => d.window.state === 'critical').length,
                distressSignals: data.filter((d) => d.blockSignal).length,
            },
        });
    } catch (err) {
        return next(err);
    }
};

exports.resolveDispute = async (req, res, next) => {
    try {
        const { disputeId } = req.params;
        const { outcome, note } = req.body ?? {};
        if (!['seeker_favoured', 'companion_favoured', 'split', 'no_action'].includes(outcome)) {
            return res.status(400).json({
                success: false,
                message: 'outcome must be one of: seeker_favoured, companion_favoured, split, no_action',
            });
        }
        if (!note || String(note).trim().length < 10) {
            return res.status(400).json({ success: false, message: 'A written reason is required' });
        }

        const dispute = await store.get(TABLES.DISPUTES, disputeId);
        if (!dispute) return res.status(404).json({ success: false, message: 'Dispute not found' });
        if (dispute.status === 'resolved') return res.status(409).json({ success: false, message: 'Already resolved' });

        const updated = await store.patch(
            TABLES.DISPUTES,
            disputeId,
            {
                status: 'resolved',
                resolution: { outcome, note, by: req.admin.adminId, byEmail: req.admin.email, at: new Date().toISOString() },
            },
            { expectedVersion: req.expectedVersion }
        );

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.DISPUTE_RESOLVED,
            targetType: 'dispute',
            targetId: disputeId,
            reason: note,
            reasonCode: outcome,
            before: { status: dispute.status },
            after: { status: 'resolved', outcome },
            metadata: { bookingId: dispute.bookingId },
            request: req,
        });

        return res.json({ success: true, data: updated });
    } catch (err) {
        if (err instanceof ConflictError) return res.status(409).json({ success: false, code: 'VERSION_CONFLICT', message: 'Actioned by another admin' });
        return next(err);
    }
};

/**
 * B-09 — called by the consumer app when either party blocks the other while a
 * booking is active. Someone blocking their companion mid-booking is a person in
 * trouble, so this opens a dispute *and* pages the Super Admin rather than
 * incrementing a counter.
 */
exports.recordBlockDuringBooking = async ({ bookingId, blockerUserId, blockedUserId }) => {
    const booking = await store.get(TABLES.BOOKINGS, bookingId);
    if (!booking) return null;

    const dispute = {
        disputeId: randomId('dsp'),
        bookingId,
        raisedBy: blockerUserId,
        against: blockedUserId,
        category: 'block_during_active_booking',
        detail: 'One party blocked the other while the booking was active',
        blockSignal: true,
        status: 'open',
        openedAt: new Date().toISOString(),
    };
    await store.put(TABLES.DISPUTES, dispute);

    await alertSuperAdmin({
        kind: 'block_during_booking',
        severity: 'critical',
        title: 'Block during an active booking',
        body: `User ${blockerUserId} blocked ${blockedUserId} during booking ${bookingId}. Treat as a safety signal.`,
        relatedType: 'booking',
        relatedId: bookingId,
    });

    await audit.record({
        actor: { adminId: 'system', role: 'system', email: 'system' },
        action: audit.ACTIONS.DISPUTE_RESOLVED,
        targetType: 'dispute',
        targetId: dispute.disputeId,
        reason: 'Distress signal: block during an active booking (B-09)',
        after: dispute,
    });

    return dispute;
};

exports.meta = (_req, res) => res.json({
    success: true,
    data: { forceReasons: BOOKING_FORCE_REASONS, refundReasons: REFUND_REASONS },
});
