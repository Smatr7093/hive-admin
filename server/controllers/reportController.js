/**
 * Report queue (PRD §6.2).
 *
 * M-09 is the one that shapes the whole module: the reporter's identity is never
 * disclosed to the reported party. So reporter identity is stripped from every
 * response that could be shown to, forwarded to, or quoted at the reported user,
 * and the enforcement notice sent to the reported party is composed here rather
 * than being a free-text field an admin might paste the reporter's name into.
 */

const { store, TABLES, ConflictError } = require('../lib/store');
const audit = require('../lib/audit');
const { notifyUser, alertSuperAdmin } = require('../lib/notify');
const { maskFor } = require('../lib/mask');
const { ENFORCEMENT_ACTIONS, REPORT_CATEGORIES } = require('../config/constants');

const ACTION_BY_ID = new Map(ENFORCEMENT_ACTIONS.map((a) => [a.id, a]));

exports.queue = async (req, res, next) => {
    try {
        const { status = 'open', category, severity } = req.query;
        const now = Date.now();

        const items = await store.list(TABLES.REPORTS, {
            filter: (r) => {
                if (status !== 'all' && r.status !== status) return false;
                if (category && r.category !== category) return false;
                if (severity && r.severity !== severity) return false;
                return true;
            },
        });

        items.sort((a, b) => {
            const rank = { high: 0, medium: 1, low: 2 };
            if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity];
            return a.createdAt.localeCompare(b.createdAt);
        });

        const data = await Promise.all(items.map(async (r) => ({
            reportId: r.reportId,
            createdAt: r.createdAt,
            hoursOpen: Math.round(((now - Date.parse(r.createdAt)) / 3_600_000) * 10) / 10,
            category: r.category,
            severity: r.severity,
            status: r.status,
            reportedUserId: r.reportedUserId,
            reportedUserName: r.reportedUserName,
            relatedBookingId: r.relatedBookingId ?? null,
            assignedTo: r.assignedTo ?? null,
            priorReportsAgainst: await countPriorReports(r.reportedUserId, r.reportId),
            version: r.version,
        })));

        return res.json({
            success: true,
            data,
            meta: {
                total: data.length,
                high: data.filter((d) => d.severity === 'high').length,
                medium: data.filter((d) => d.severity === 'medium').length,
                low: data.filter((d) => d.severity === 'low').length,
            },
        });
    } catch (err) {
        return next(err);
    }
};

async function countPriorReports(userId, excludeReportId) {
    const all = await store.list(TABLES.REPORTS, {
        filter: (r) => r.reportedUserId === userId && r.reportId !== excludeReportId,
    });
    return all.length;
}

exports.detail = async (req, res, next) => {
    try {
        const report = await store.get(TABLES.REPORTS, req.params.reportId);
        if (!report) return res.status(404).json({ success: false, message: 'Report not found' });

        // M-12 — the full history of prior reports involving *either* party. A
        // serial reporter and a serial offender look identical on one ticket.
        const involving = await store.list(TABLES.REPORTS, {
            filter: (r) =>
                r.reportId !== report.reportId &&
                [r.reporterUserId, r.reportedUserId].some((id) =>
                    id === report.reporterUserId || id === report.reportedUserId),
        });

        const booking = report.relatedBookingId
            ? await store.get(TABLES.BOOKINGS, report.relatedBookingId)
            : null;

        const masked = await maskFor(req.admin, report, { recordType: 'report', recordId: report.reportId });

        return res.json({
            success: true,
            data: {
                ...masked,
                // M-09 — carried on the payload so any surface rendering this
                // object knows the constraint without having to look it up.
                reporterIdentityDisclosable: false,
                relatedBooking: booking
                    ? {
                        bookingId: booking.bookingId,
                        status: booking.status,
                        selectedDate: booking.selectedDate,
                        selectedTime: booking.selectedTime,
                        totalAmount: booking.totalAmount,
                    }
                    : null,
                history: involving
                    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                    .map((r) => ({
                        reportId: r.reportId,
                        createdAt: r.createdAt,
                        category: r.category,
                        status: r.status,
                        outcome: r.resolution?.actionId ?? null,
                        // Which side of the prior report each party was on, without
                        // naming any third party.
                        reportedPartyWasThisUser: r.reportedUserId === report.reportedUserId,
                        reporterWasThisReporter: r.reporterUserId === report.reporterUserId,
                    })),
                enforcementActions: ENFORCEMENT_ACTIONS,
            },
        });
    } catch (err) {
        return next(err);
    }
};

exports.assign = async (req, res, next) => {
    try {
        const { reportId } = req.params;
        const { assignedTo } = req.body ?? {};
        const updated = await store.patch(TABLES.REPORTS, reportId, {
            assignedTo: assignedTo ?? null,
            assignedAt: assignedTo ? new Date().toISOString() : null,
        });
        if (!updated) return res.status(404).json({ success: false, message: 'Report not found' });
        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.REPORT_ASSIGNED,
            targetType: 'report',
            targetId: reportId,
            reason: assignedTo ? 'Assigned' : 'Unassigned',
            after: { assignedTo: assignedTo ?? null },
            request: req,
        });
        return res.json({ success: true, data: updated });
    } catch (err) {
        return next(err);
    }
};

// ─── M-10 / M-11 — enforcement ───────────────────────────────────────────────

exports.act = async (req, res, next) => {
    try {
        const { reportId } = req.params;
        const { actionId, note, suspensionDays } = req.body;

        const action = ACTION_BY_ID.get(actionId);
        if (!action) {
            return res.status(400).json({ success: false, message: 'Unknown enforcement action', allowed: ENFORCEMENT_ACTIONS });
        }
        // M-11 — every action requires a reason. The ladder rung is not the
        // reason; "why this rung, on this report" is.
        if (!note || String(note).trim().length < 10) {
            return res.status(400).json({
                success: false,
                code: 'REASON_REQUIRED',
                message: 'An enforcement action requires a written reason of at least 10 characters (M-11)',
            });
        }
        if (action.id === 'temp_suspension' && !Number.isInteger(Number(suspensionDays))) {
            return res.status(400).json({ success: false, message: 'suspensionDays is required for a temporary suspension' });
        }

        const report = await store.get(TABLES.REPORTS, reportId);
        if (!report) return res.status(404).json({ success: false, message: 'Report not found' });
        if (report.status === 'resolved') {
            return res.status(409).json({ success: false, message: 'This report has already been resolved' });
        }

        const now = new Date().toISOString();
        const resolution = {
            actionId: action.id,
            actionLabel: action.label,
            severity: action.severity,
            note,
            suspensionDays: action.id === 'temp_suspension' ? Number(suspensionDays) : null,
            by: req.admin.adminId,
            byEmail: req.admin.email,
            at: now,
        };

        const updated = await store.patch(
            TABLES.REPORTS,
            reportId,
            { status: 'resolved', resolution },
            { expectedVersion: req.expectedVersion }
        );

        await applyEnforcement({ action, report, resolution, admin: req.admin, req });

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.REPORT_ACTIONED,
            targetType: 'report',
            targetId: reportId,
            reason: note,
            reasonCode: action.id,
            before: { status: report.status },
            after: { status: 'resolved', action: action.id },
            metadata: {
                reportedUserId: report.reportedUserId,
                severity: action.severity,
                suspensionDays: resolution.suspensionDays,
            },
            request: req,
        });

        return res.json({ success: true, data: updated });
    } catch (err) {
        if (err instanceof ConflictError) return res.status(409).json({ success: false, code: 'VERSION_CONFLICT', message: 'Actioned by another admin' });
        return next(err);
    }
};

/**
 * Carry the enforcement decision into the systems it affects.
 *
 * Every notice composed here is written from the platform's voice and never
 * references who reported (M-09).
 */
async function applyEnforcement({ action, report, resolution, admin, req }) {
    const userId = report.reportedUserId;
    const now = new Date().toISOString();

    const notice = {
        warn: 'We have reviewed activity on your account and issued a formal warning.',
        remove_content: 'Content on your profile has been removed for breaching our Community Guidelines.',
        temp_suspension: `Your account has been suspended for ${resolution.suspensionDays} day(s) for breaching our Community Guidelines.`,
        withhold_payout: 'A payout on your account has been placed on hold pending review.',
        permanent_removal: 'Your account has been permanently removed for breaching our Community Guidelines.',
        law_enforcement: 'Activity on your account has been referred to the relevant authorities.',
    }[action.id];

    switch (action.id) {
        case 'temp_suspension':
            await store.patch(TABLES.USERS, userId, {
                accountStatus: 'suspended',
                suspendedAt: now,
                suspendedUntil: new Date(Date.now() + resolution.suspensionDays * 86_400_000).toISOString(),
                suspensionReason: action.label,
            });
            break;

        case 'permanent_removal':
            await store.patch(TABLES.USERS, userId, {
                accountStatus: 'removed',
                removedAt: now,
                removalReason: action.label,
            });
            await store.patch(TABLES.COMPANIONS, userId, { availabilityStatus: 'removed', isVerified: false });
            break;

        case 'withhold_payout': {
            const payouts = await store.list(TABLES.PAYOUTS, {
                filter: (p) => p.companionId === userId && ['requested', 'processing'].includes(p.status),
            });
            for (const p of payouts) {
                await store.patch(TABLES.PAYOUTS, p.payoutId, {
                    status: 'held',
                    holdReasonCode: 'open_dispute',
                    holdReason: `Enforcement action on report ${report.reportId}`,
                    heldBy: admin.adminId,
                    heldAt: now,
                });
            }
            break;
        }

        case 'remove_content':
            await store.patch(TABLES.COMPANIONS, userId, {
                bio: '',
                profileImage: null,
                thumbnailImage: null,
                moderationStatus: 'content_removed',
                moderatedAt: now,
            });
            break;

        case 'law_enforcement':
            await alertSuperAdmin({
                kind: 'law_enforcement_referral',
                severity: 'critical',
                title: 'Report referred to law enforcement',
                body: `${admin.email} referred report ${report.reportId} (user ${userId}) to law enforcement. Reason: ${resolution.note}`,
                relatedType: 'report',
                relatedId: report.reportId,
            });
            break;

        default:
            break; // warn — the notification below is the whole action
    }

    await notifyUser({
        userId,
        channel: 'enforcement',
        title: 'Action taken on your Hive account',
        body: notice,
        relatedType: 'report',
        relatedId: report.reportId,
    });
}

exports.dismiss = async (req, res, next) => {
    try {
        const { reportId } = req.params;
        const { note } = req.body ?? {};
        if (!note || String(note).trim().length < 10) {
            return res.status(400).json({ success: false, message: 'A reason is required to dismiss a report' });
        }
        const report = await store.get(TABLES.REPORTS, reportId);
        if (!report) return res.status(404).json({ success: false, message: 'Report not found' });

        const updated = await store.patch(
            TABLES.REPORTS,
            reportId,
            {
                status: 'dismissed',
                resolution: { actionId: 'dismissed', note, by: req.admin.adminId, byEmail: req.admin.email, at: new Date().toISOString() },
            },
            { expectedVersion: req.expectedVersion }
        );

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.REPORT_DISMISSED,
            targetType: 'report',
            targetId: reportId,
            reason: note,
            before: { status: report.status },
            after: { status: 'dismissed' },
            request: req,
        });

        return res.json({ success: true, data: updated });
    } catch (err) {
        if (err instanceof ConflictError) return res.status(409).json({ success: false, code: 'VERSION_CONFLICT', message: 'Actioned by another admin' });
        return next(err);
    }
};

exports.meta = (_req, res) => res.json({
    success: true,
    data: { categories: REPORT_CATEGORIES, actions: ENFORCEMENT_ACTIONS },
});
