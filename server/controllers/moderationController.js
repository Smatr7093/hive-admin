/**
 * Profile and listing moderation (PRD §6.1).
 *
 * The design point is M-02/M-03: an approved profile that can be silently edited
 * is a moderation hole, and bio/photo edits are the specific vector for
 * solicitation content appearing after approval. So an edit does not mutate the
 * live profile — it creates a pending moderation item holding the proposed
 * change, and the previously approved version stays live until someone approves
 * the new one (M-04).
 */

const { store, TABLES, ConflictError } = require('../lib/store');
const audit = require('../lib/audit');
const { randomId } = require('../lib/crypto');
const { notifyUser, alertSuperAdmin } = require('../lib/notify');
const { MODERATION_REJECTION_REASONS } = require('../config/constants');

const MODERATED_FIELDS = ['name', 'bio', 'shortTitle', 'about', 'profileImage', 'thumbnailImage', 'tags', 'interests', 'category'];

// ─── GET /admin/moderation ───────────────────────────────────────────────────

exports.queue = async (req, res, next) => {
    try {
        const { type = 'all', status = 'pending' } = req.query;
        const items = await store.list(TABLES.MODERATION_ITEMS, {
            filter: (i) =>
                (status === 'all' || i.status === status) &&
                (type === 'all' || i.type === type),
        });

        items.sort((a, b) => {
            // Escalated first — M-06 items are the ones that must not sit.
            if (!!a.escalated !== !!b.escalated) return a.escalated ? -1 : 1;
            return a.createdAt.localeCompare(b.createdAt);
        });

        const now = Date.now();
        return res.json({
            success: true,
            data: items.map((i) => ({
                ...i,
                hoursInQueue: Math.round(((now - Date.parse(i.createdAt)) / 3_600_000) * 10) / 10,
                changedFields: i.type === 'profile_edit' ? changedFields(i) : null,
            })),
            meta: {
                total: items.length,
                newProfiles: items.filter((i) => i.type === 'new_profile').length,   // M-01
                edits: items.filter((i) => i.type === 'profile_edit').length,        // M-02
                escalated: items.filter((i) => i.escalated).length,
            },
        });
    } catch (err) {
        return next(err);
    }
};

function changedFields(item) {
    const before = item.previousVersion ?? {};
    const after = item.proposedVersion ?? {};
    return MODERATED_FIELDS.filter((f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]));
}

/**
 * M-03 — the reviewer sees a side-by-side diff of the approved version and the
 * proposed change, not a form with the new values already filled in. Reviewing
 * only what changed is the entire point.
 */
exports.detail = async (req, res, next) => {
    try {
        const item = await store.get(TABLES.MODERATION_ITEMS, req.params.itemId);
        if (!item) return res.status(404).json({ success: false, message: 'Moderation item not found' });

        const fields = item.type === 'profile_edit' ? changedFields(item) : MODERATED_FIELDS;
        const diff = fields.map((field) => ({
            field,
            previous: item.previousVersion?.[field] ?? null,
            proposed: item.proposedVersion?.[field] ?? null,
            changed: JSON.stringify(item.previousVersion?.[field]) !== JSON.stringify(item.proposedVersion?.[field]),
        }));

        // Moderation history for this companion — a second solicitation attempt
        // reads very differently from a first one.
        const history = await store.list(TABLES.MODERATION_ITEMS, {
            filter: (i) => i.userId === item.userId && i.itemId !== item.itemId,
        });
        const reports = await store.list(TABLES.REPORTS, { filter: (r) => r.reportedUserId === item.userId });

        return res.json({
            success: true,
            data: {
                ...item,
                diff,
                // M-04 — spelled out for the reviewer so nobody assumes the
                // profile is currently down while it waits.
                liveVersionRemainsPublished: item.type === 'profile_edit',
                history: history
                    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                    .map((h) => ({
                        itemId: h.itemId, type: h.type, status: h.status,
                        createdAt: h.createdAt, reasonCode: h.decision?.reasonCode ?? null,
                    })),
                reportsAgainstUser: reports.length,
                rejectionReasons: MODERATION_REJECTION_REASONS,
            },
        });
    } catch (err) {
        return next(err);
    }
};

// ─── POST /admin/moderation/:itemId/approve ──────────────────────────────────

exports.approve = async (req, res, next) => {
    try {
        const item = await store.get(TABLES.MODERATION_ITEMS, req.params.itemId);
        if (!item) return res.status(404).json({ success: false, message: 'Moderation item not found' });
        if (item.status !== 'pending') {
            return res.status(409).json({ success: false, message: `Already ${item.status}` });
        }

        const now = new Date().toISOString();
        const updated = await store.patch(
            TABLES.MODERATION_ITEMS,
            item.itemId,
            {
                status: 'approved',
                decision: { outcome: 'approved', by: req.admin.adminId, byEmail: req.admin.email, at: now, note: req.body?.note ?? null },
            },
            { expectedVersion: req.expectedVersion }
        );

        // Only now does the proposed version become the live one.
        const patch = {};
        for (const field of MODERATED_FIELDS) {
            if (item.proposedVersion?.[field] !== undefined) patch[field] = item.proposedVersion[field];
        }
        patch.moderationStatus = 'approved';
        patch.moderatedAt = now;
        await store.patch(TABLES.COMPANIONS, item.userId, patch);

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.PROFILE_APPROVED,
            targetType: 'moderation_item',
            targetId: item.itemId,
            reason: req.body?.note ?? 'Profile change approved',
            before: item.previousVersion,
            after: item.proposedVersion,
            metadata: { userId: item.userId, type: item.type },
            request: req,
        });

        await notifyUser({
            userId: item.userId,
            channel: 'moderation',
            title: item.type === 'new_profile' ? 'Your profile is live' : 'Your profile changes are live',
            body: 'Your profile has been reviewed and published.',
            relatedType: 'moderation_item',
            relatedId: item.itemId,
        });

        return res.json({ success: true, data: updated });
    } catch (err) {
        if (err instanceof ConflictError) return res.status(409).json({ success: false, code: 'VERSION_CONFLICT', message: 'Actioned by another admin' });
        return next(err);
    }
};

// ─── POST /admin/moderation/:itemId/reject ───────────────────────────────────

exports.reject = async (req, res, next) => {
    try {
        const item = await store.get(TABLES.MODERATION_ITEMS, req.params.itemId);
        if (!item) return res.status(404).json({ success: false, message: 'Moderation item not found' });
        if (item.status !== 'pending') {
            return res.status(409).json({ success: false, message: `Already ${item.status}` });
        }

        const { reasonCode, note } = req.body;
        const reason = MODERATION_REJECTION_REASONS.find((r) => r.id === reasonCode);
        const now = new Date().toISOString();

        const updated = await store.patch(
            TABLES.MODERATION_ITEMS,
            item.itemId,
            {
                status: 'rejected',
                // M-06 — the guideline hard lines carry `escalates`, so a
                // suspected-solicitation rejection escalates by construction
                // rather than by the reviewer remembering to tick a box.
                escalated: !!reason.escalates || !!item.escalated,
                escalatedReason: reason.escalates ? reason.label : item.escalatedReason ?? null,
                decision: {
                    outcome: 'rejected', reasonCode, reasonLabel: reason.label,
                    note: note ?? null, by: req.admin.adminId, byEmail: req.admin.email, at: now,
                },
            },
            { expectedVersion: req.expectedVersion }
        );

        // M-04 — on rejection of an edit the previously approved version simply
        // stays live; nothing needs undoing because nothing was applied.
        if (item.type === 'new_profile') {
            await store.patch(TABLES.COMPANIONS, item.userId, {
                moderationStatus: 'rejected',
                moderatedAt: now,
                moderationNote: reason.label,
            });
        }

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.PROFILE_REJECTED,
            targetType: 'moderation_item',
            targetId: item.itemId,
            reason: note ? `${reason.label} — ${note}` : reason.label,
            reasonCode,
            before: { status: 'pending' },
            after: { status: 'rejected' },
            metadata: { userId: item.userId, type: item.type, escalated: !!reason.escalates },
            request: req,
        });

        if (reason.escalates) {
            await alertSuperAdmin({
                kind: 'moderation_escalation',
                severity: 'critical',
                title: `Escalated: ${reason.label}`,
                body: `Companion ${item.userId} — ${item.type} rejected as ${reason.label}.`,
                relatedType: 'moderation_item',
                relatedId: item.itemId,
            });
            await audit.record({
                actor: req.admin,
                action: audit.ACTIONS.PROFILE_ESCALATED,
                targetType: 'moderation_item',
                targetId: item.itemId,
                reason: `Escalated to Super Admin: ${reason.label}`,
                metadata: { userId: item.userId },
                request: req,
            });
        }

        await notifyUser({
            userId: item.userId,
            channel: 'moderation',
            title: item.type === 'new_profile' ? 'Your profile was not approved' : 'Your profile changes were not approved',
            body: `Reason: ${reason.label}${note ? ` — ${note}` : ''}. Please review the Community Guidelines and try again.`,
            relatedType: 'moderation_item',
            relatedId: item.itemId,
        });

        return res.json({ success: true, data: updated, escalated: !!reason.escalates });
    } catch (err) {
        if (err instanceof ConflictError) return res.status(409).json({ success: false, code: 'VERSION_CONFLICT', message: 'Actioned by another admin' });
        return next(err);
    }
};

/** M-06 — escalate without deciding, for anything a reviewer is unsure about. */
exports.escalate = async (req, res, next) => {
    try {
        const { itemId } = req.params;
        const { note } = req.body ?? {};
        if (!note) return res.status(400).json({ success: false, message: 'Say why you are escalating' });

        const item = await store.get(TABLES.MODERATION_ITEMS, itemId);
        if (!item) return res.status(404).json({ success: false, message: 'Moderation item not found' });

        const updated = await store.patch(TABLES.MODERATION_ITEMS, itemId, {
            escalated: true,
            escalatedReason: note,
            escalatedBy: req.admin.adminId,
            escalatedAt: new Date().toISOString(),
        });

        await alertSuperAdmin({
            kind: 'moderation_escalation',
            severity: 'critical',
            title: 'Moderation item escalated',
            body: `${req.admin.email} escalated ${itemId}: ${note}`,
            relatedType: 'moderation_item',
            relatedId: itemId,
        });

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.PROFILE_ESCALATED,
            targetType: 'moderation_item',
            targetId: itemId,
            reason: note,
            request: req,
        });

        return res.json({ success: true, data: updated });
    } catch (err) {
        return next(err);
    }
};

/**
 * Called by the consumer app when a companion edits an approved profile (v2.0
 * D-16). Included here so the moderation hole M-02 describes is closed by an
 * actual code path rather than a note saying it should be.
 */
exports.submitEdit = async (userId, proposedVersion) => {
    const companion = await store.get(TABLES.COMPANIONS, userId);
    if (!companion) throw new Error('Companion not found');

    const previousVersion = {};
    for (const field of MODERATED_FIELDS) previousVersion[field] = companion[field] ?? null;

    const item = {
        itemId: randomId('mod'),
        type: 'profile_edit',
        userId,
        userName: companion.name,
        status: 'pending',
        previousVersion,
        proposedVersion,
        createdAt: new Date().toISOString(),
        escalated: false,
    };
    await store.put(TABLES.MODERATION_ITEMS, item);
    return item;
};

exports.reasons = (_req, res) => res.json({ success: true, data: MODERATION_REJECTION_REASONS });
