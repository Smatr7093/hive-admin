/**
 * Grievance SLA queue (PRD §6.3).
 *
 * This is the tooling that makes the published grievance commitments real. Two
 * things in here are load-bearing and easy to accidentally undo later:
 *
 *  - G-02: the 24-hour acknowledgement is automatic. `runAcknowledgementSweep`
 *    is idempotent and is called on every list request as well as by a timer, so
 *    the clock does not depend on anyone being awake.
 *  - G-06: urgent-track tickets cannot be filtered out of view. The list
 *    endpoint applies filters to the standard track only and always unions the
 *    open urgent tickets back in. There is no query string that hides them.
 */

const { store, TABLES, ConflictError } = require('../lib/store');
const audit = require('../lib/audit');
const { randomId } = require('../lib/crypto');
const { computeSla, summarise } = require('../lib/sla');
const { notifyUser } = require('../lib/notify');
const {
    URGENT_GRIEVANCE_CATEGORIES, STANDARD_GRIEVANCE_CATEGORIES,
    GRIEVANCE_CHANNELS, SLA,
} = require('../config/constants');

const URGENT_IDS = new Set(URGENT_GRIEVANCE_CATEGORIES.map((c) => c.id));

// ─── G-02 — automatic acknowledgement ────────────────────────────────────────

/**
 * Acknowledge anything unacknowledged. Idempotent: a ticket already carrying
 * `acknowledgedAt` is skipped, so calling this on every request is safe.
 *
 * Deliberately acknowledges immediately rather than at the 23rd hour. The
 * commitment is "within 24 hours" and a complainant waiting a day for a receipt
 * assumes they were ignored.
 */
async function runAcknowledgementSweep() {
    const pending = await store.list(TABLES.GRIEVANCES, { filter: (g) => !g.acknowledgedAt });
    const acknowledged = [];
    for (const g of pending) {
        const at = new Date().toISOString();
        await store.patch(TABLES.GRIEVANCES, g.grievanceId, {
            acknowledgedAt: at,
            acknowledgedBy: 'system',
        });
        await notifyUser({
            userId: g.complainantUserId,
            email: g.complainantEmail,
            channel: 'grievance',
            title: `We have received your complaint — ${g.reference}`,
            body: [
                `Your complaint was received on ${new Date(g.receivedAt).toUTCString()}.`,
                `Reference: ${g.reference}.`,
                `We will resolve it within ${SLA.RESOLVE_DAYS} days.`,
                g.isUrgent ? 'Because of its nature, it is being actioned within 24 hours.' : '',
            ].filter(Boolean).join(' '),
            relatedType: 'grievance',
            relatedId: g.grievanceId,
            automatic: true,
        });
        await audit.record({
            actor: { adminId: 'system', role: 'system', email: 'system' },
            action: audit.ACTIONS.GRIEVANCE_ACKNOWLEDGED,
            targetType: 'grievance',
            targetId: g.grievanceId,
            reason: 'Automatic acknowledgement within the 24-hour commitment (G-02)',
            after: { acknowledgedAt: at },
        });
        acknowledged.push(g.grievanceId);
    }
    return acknowledged;
}

function decorate(g, now = Date.now()) {
    return { ...g, sla: computeSla(g, now) };
}

// ─── GET /admin/grievances ───────────────────────────────────────────────────

exports.list = async (req, res, next) => {
    try {
        await runAcknowledgementSweep();

        const { state, assignedTo, channel, category, from, to, includeResolved } = req.query;
        const now = Date.now();
        const all = await store.list(TABLES.GRIEVANCES);

        const matches = (g) => {
            if (!includeResolved && g.resolvedAt) return false;
            if (assignedTo === 'unassigned' && g.assignedTo) return false;
            if (assignedTo && assignedTo !== 'unassigned' && g.assignedTo !== assignedTo) return false;
            if (channel && g.channel !== channel) return false;
            if (category && g.category !== category) return false;
            if (from && g.receivedAt < from) return false;
            if (to && g.receivedAt > to) return false;
            if (state) {
                const sla = computeSla(g, now);
                if (state === 'breached' ? !sla.breached : sla.worstState !== state) return false;
            }
            return true;
        };

        const filtered = all.filter(matches);

        // G-06 — every open urgent ticket is in the result regardless of the
        // filters. `pinnedByUrgency` tells the console to render it as a pinned
        // row so it is obvious the filter did not apply to it.
        const urgentOpen = all.filter((g) => g.isUrgent && !g.resolvedAt);
        const byId = new Map(filtered.map((g) => [g.grievanceId, g]));
        const forcedIn = [];
        for (const g of urgentOpen) {
            if (!byId.has(g.grievanceId)) {
                byId.set(g.grievanceId, g);
                forcedIn.push(g.grievanceId);
            }
        }

        const items = [...byId.values()]
            .map((g) => ({
                ...decorate(g, now),
                pinnedByUrgency: forcedIn.includes(g.grievanceId),
            }))
            // Urgent first, then oldest receipt first.
            .sort((a, b) => {
                if (a.isUrgent !== b.isUrgent) return a.isUrgent ? -1 : 1;
                return a.receivedAt.localeCompare(b.receivedAt);
            });

        return res.json({
            success: true,
            data: items,
            meta: {
                ...summarise(all, now),
                urgentAlwaysShown: true,
                forcedIntoView: forcedIn.length,
            },
        });
    } catch (err) {
        return next(err);
    }
};

exports.detail = async (req, res, next) => {
    try {
        const g = await store.get(TABLES.GRIEVANCES, req.params.grievanceId);
        if (!g) return res.status(404).json({ success: false, message: 'Grievance not found' });

        // M-12-style context: prior grievances involving either party.
        const related = await store.list(TABLES.GRIEVANCES, {
            filter: (o) =>
                o.grievanceId !== g.grievanceId &&
                ((g.complainantUserId && o.complainantUserId === g.complainantUserId) ||
                 (g.againstUserId && o.againstUserId === g.againstUserId)),
        });

        return res.json({
            success: true,
            data: {
                ...decorate(g),
                relatedGrievances: related
                    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
                    .map((o) => ({
                        grievanceId: o.grievanceId,
                        reference: o.reference,
                        category: o.category,
                        receivedAt: o.receivedAt,
                        resolvedAt: o.resolvedAt,
                        outcome: o.resolution?.outcome ?? null,
                    })),
            },
        });
    } catch (err) {
        return next(err);
    }
};

// ─── POST /admin/grievances ──────────────────────────────────────────────────
//
// G-01 — in-app, email and postal grievances all become tickets. The postal case
// is why `receivedAt` is a separate input: the SLA runs from the physical receipt
// date, not the date someone typed it in (PRD §12).

exports.create = async (req, res, next) => {
    try {
        const {
            channel, category, detail,
            complainantUserId, complainantEmail, complainantName,
            againstUserId, relatedBookingId,
            receivedAt, // required for postal
        } = req.body ?? {};

        if (!channel || !GRIEVANCE_CHANNELS.some((c) => c.id === channel)) {
            return res.status(400).json({ success: false, message: 'Valid channel is required', allowed: GRIEVANCE_CHANNELS });
        }
        const known = [...URGENT_GRIEVANCE_CATEGORIES, ...STANDARD_GRIEVANCE_CATEGORIES];
        if (!category || !known.some((c) => c.id === category)) {
            return res.status(400).json({ success: false, message: 'Valid category is required', allowed: known });
        }
        if (!detail || String(detail).trim().length < 10) {
            return res.status(400).json({ success: false, message: 'A description of the complaint is required' });
        }
        // §12 — the complainant need not be a Hive user; an email address is enough.
        if (!complainantUserId && !complainantEmail) {
            return res.status(400).json({ success: false, message: 'Either complainantUserId or complainantEmail is required' });
        }
        if (channel === 'postal' && !receivedAt) {
            return res.status(400).json({
                success: false,
                code: 'RECEIPT_DATE_REQUIRED',
                message: 'Postal grievances must carry the physical receipt date — the SLA runs from receipt, not entry (PRD §12)',
            });
        }

        const now = new Date().toISOString();
        const received = receivedAt ?? now;
        if (Date.parse(received) > Date.now() + 60_000) {
            return res.status(400).json({ success: false, message: 'receivedAt cannot be in the future' });
        }

        const grievance = {
            grievanceId: randomId('grv'),
            reference: `HIVE-GRV-${new Date(received).getUTCFullYear()}-${String(Date.now()).slice(-6)}`,
            channel,
            category,
            isUrgent: URGENT_IDS.has(category), // G-05
            detail,
            complainantUserId: complainantUserId ?? null,
            complainantEmail: complainantEmail ?? null,
            complainantName: complainantName ?? null,
            againstUserId: againstUserId ?? null,
            relatedBookingId: relatedBookingId ?? null,
            receivedAt: received,
            enteredAt: now,
            enteredBy: req.admin.adminId,
            acknowledgedAt: null,
            assignedTo: null,
            assignedAt: null,
            urgentActionedAt: null,
            resolvedAt: null,
            resolution: null,
            appeal: null,
            notes: [],
        };

        await store.put(TABLES.GRIEVANCES, grievance);

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.GRIEVANCE_CREATED,
            targetType: 'grievance',
            targetId: grievance.grievanceId,
            reason: `Grievance logged via ${channel}`,
            after: { reference: grievance.reference, category, isUrgent: grievance.isUrgent, receivedAt: received },
            metadata: received !== now ? { backdated: true, enteredAt: now } : null,
            request: req,
        });

        await runAcknowledgementSweep();

        const stored = await store.get(TABLES.GRIEVANCES, grievance.grievanceId);
        return res.status(201).json({ success: true, data: decorate(stored) });
    } catch (err) {
        return next(err);
    }
};

// ─── G-07 — assignment ───────────────────────────────────────────────────────

exports.assign = async (req, res, next) => {
    try {
        const { grievanceId } = req.params;
        const { assignedTo } = req.body ?? {};
        const g = await store.get(TABLES.GRIEVANCES, grievanceId);
        if (!g) return res.status(404).json({ success: false, message: 'Grievance not found' });

        const target = assignedTo ? await store.get(TABLES.ADMIN_USERS, assignedTo) : null;
        if (assignedTo && !target) return res.status(400).json({ success: false, message: 'Unknown admin' });

        const updated = await store.patch(
            TABLES.GRIEVANCES,
            grievanceId,
            {
                assignedTo: assignedTo ?? null,
                assignedToName: target?.name ?? null,
                assignedAt: assignedTo ? new Date().toISOString() : null,
            },
            { expectedVersion: req.expectedVersion }
        );

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.GRIEVANCE_ASSIGNED,
            targetType: 'grievance',
            targetId: grievanceId,
            reason: req.body?.note ?? (assignedTo ? `Assigned to ${target.email}` : 'Unassigned'),
            before: { assignedTo: g.assignedTo },
            after: { assignedTo: assignedTo ?? null },
            request: req,
        });

        return res.json({ success: true, data: decorate(updated) });
    } catch (err) {
        if (err instanceof ConflictError) return res.status(409).json({ success: false, code: 'VERSION_CONFLICT', message: 'Actioned by another admin' });
        return next(err);
    }
};

/**
 * G-05 — record that the urgent 24-hour action has been taken. Separate from
 * resolution: taking the image down stops the clock even though the wider
 * complaint may take another week to close out.
 */
exports.markUrgentActioned = async (req, res, next) => {
    try {
        const { grievanceId } = req.params;
        const { note } = req.body ?? {};
        const g = await store.get(TABLES.GRIEVANCES, grievanceId);
        if (!g) return res.status(404).json({ success: false, message: 'Grievance not found' });
        if (!g.isUrgent) return res.status(400).json({ success: false, message: 'This is not an urgent-track grievance' });
        if (!note) return res.status(400).json({ success: false, message: 'Describe the action taken' });

        const at = new Date().toISOString();
        const updated = await store.patch(
            TABLES.GRIEVANCES,
            grievanceId,
            { urgentActionedAt: at, urgentActionNote: note, urgentActionedBy: req.admin.adminId },
            { expectedVersion: req.expectedVersion }
        );

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.GRIEVANCE_RESOLVED,
            targetType: 'grievance',
            targetId: grievanceId,
            reason: `Urgent-track action taken: ${note}`,
            after: { urgentActionedAt: at },
            request: req,
        });

        return res.json({ success: true, data: decorate(updated) });
    } catch (err) {
        if (err instanceof ConflictError) return res.status(409).json({ success: false, code: 'VERSION_CONFLICT', message: 'Actioned by another admin' });
        return next(err);
    }
};

// ─── G-08, G-09 — resolution ─────────────────────────────────────────────────

exports.resolve = async (req, res, next) => {
    try {
        const { grievanceId } = req.params;
        const { outcome, reasoning, actionsTaken } = req.body ?? {};

        if (!outcome || !['upheld', 'partially_upheld', 'not_upheld', 'no_action_required'].includes(outcome)) {
            return res.status(400).json({
                success: false,
                message: "outcome must be one of: upheld, partially_upheld, not_upheld, no_action_required",
            });
        }
        // G-08 — resolution requires a recorded decision *and* reasoning. A
        // one-word outcome is not a record of how a complaint was handled.
        if (!reasoning || String(reasoning).trim().length < 20) {
            return res.status(400).json({
                success: false,
                code: 'REASONING_REQUIRED',
                message: 'Resolution requires recorded reasoning of at least 20 characters (G-08)',
            });
        }

        const g = await store.get(TABLES.GRIEVANCES, grievanceId);
        if (!g) return res.status(404).json({ success: false, message: 'Grievance not found' });
        if (g.resolvedAt) return res.status(409).json({ success: false, message: 'Already resolved' });

        const at = new Date().toISOString();
        const resolution = {
            outcome,
            reasoning,
            actionsTaken: actionsTaken ?? [],
            by: req.admin.adminId,
            byEmail: req.admin.email,
            at,
        };

        const updated = await store.patch(
            TABLES.GRIEVANCES,
            grievanceId,
            { resolvedAt: at, resolution },
            { expectedVersion: req.expectedVersion }
        );

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.GRIEVANCE_RESOLVED,
            targetType: 'grievance',
            targetId: grievanceId,
            reason: reasoning,
            reasonCode: outcome,
            before: { resolvedAt: null },
            after: { resolvedAt: at, outcome },
            metadata: { sla: computeSla(updated) },
            request: req,
        });

        // G-09 — the complainant is told the outcome *and the reason for it*.
        await notifyUser({
            userId: g.complainantUserId,
            email: g.complainantEmail,
            channel: 'grievance',
            title: `Outcome of your complaint — ${g.reference}`,
            body: [
                `Outcome: ${outcome.replace(/_/g, ' ')}.`,
                reasoning,
                `If you disagree, you may appeal within ${SLA.APPEAL_WINDOW_DAYS} days quoting ${g.reference}.`,
            ].join('\n\n'),
            relatedType: 'grievance',
            relatedId: grievanceId,
        });

        return res.json({ success: true, data: decorate(updated) });
    } catch (err) {
        if (err instanceof ConflictError) return res.status(409).json({ success: false, code: 'VERSION_CONFLICT', message: 'Actioned by another admin' });
        return next(err);
    }
};

// ─── G-10 — appeals ──────────────────────────────────────────────────────────

exports.recordAppeal = async (req, res, next) => {
    try {
        const { grievanceId } = req.params;
        const { grounds } = req.body ?? {};
        const g = await store.get(TABLES.GRIEVANCES, grievanceId);
        if (!g) return res.status(404).json({ success: false, message: 'Grievance not found' });
        if (!g.resolvedAt) return res.status(400).json({ success: false, message: 'Nothing to appeal — not yet resolved' });

        const sla = computeSla(g);
        if (!sla.appeal.open) {
            return res.status(409).json({
                success: false,
                code: 'APPEAL_WINDOW_CLOSED',
                message: `The ${SLA.APPEAL_WINDOW_DAYS}-day appeal window closed on ${sla.appeal.closesAt}`,
            });
        }
        if (!grounds) return res.status(400).json({ success: false, message: 'Grounds for appeal are required' });

        const appeal = {
            receivedAt: new Date().toISOString(),
            grounds,
            recordedBy: req.admin.adminId,
            decidedAt: null,
            decision: null,
        };
        const updated = await store.patch(TABLES.GRIEVANCES, grievanceId, { appeal });

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.GRIEVANCE_APPEALED,
            targetType: 'grievance',
            targetId: grievanceId,
            reason: grounds,
            after: { appeal },
            request: req,
        });

        return res.json({ success: true, data: decorate(updated) });
    } catch (err) {
        return next(err);
    }
};

exports.decideAppeal = async (req, res, next) => {
    try {
        const { grievanceId } = req.params;
        const { decision, reasoning } = req.body ?? {};
        if (!['upheld', 'rejected'].includes(decision)) {
            return res.status(400).json({ success: false, message: "decision must be 'upheld' or 'rejected'" });
        }
        if (!reasoning || String(reasoning).trim().length < 20) {
            return res.status(400).json({ success: false, message: 'Reasoning of at least 20 characters is required' });
        }
        const g = await store.get(TABLES.GRIEVANCES, grievanceId);
        if (!g?.appeal) return res.status(404).json({ success: false, message: 'No appeal on this grievance' });

        const updated = await store.patch(TABLES.GRIEVANCES, grievanceId, {
            appeal: { ...g.appeal, decidedAt: new Date().toISOString(), decision, reasoning, decidedBy: req.admin.adminId },
        });

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.GRIEVANCE_APPEALED,
            targetType: 'grievance',
            targetId: grievanceId,
            reason: reasoning,
            reasonCode: decision,
            after: { appealDecision: decision },
            request: req,
        });

        await notifyUser({
            userId: g.complainantUserId,
            email: g.complainantEmail,
            channel: 'grievance',
            title: `Appeal outcome — ${g.reference}`,
            body: `Your appeal was ${decision}.\n\n${reasoning}`,
            relatedType: 'grievance',
            relatedId: grievanceId,
        });

        return res.json({ success: true, data: decorate(updated) });
    } catch (err) {
        return next(err);
    }
};

exports.addNote = async (req, res, next) => {
    try {
        const { grievanceId } = req.params;
        const { note } = req.body ?? {};
        if (!note) return res.status(400).json({ success: false, message: 'note is required' });
        const g = await store.get(TABLES.GRIEVANCES, grievanceId);
        if (!g) return res.status(404).json({ success: false, message: 'Grievance not found' });

        const entry = { at: new Date().toISOString(), by: req.admin.adminId, byName: req.admin.name, note };
        const updated = await store.patch(TABLES.GRIEVANCES, grievanceId, { notes: [...(g.notes ?? []), entry] });
        return res.json({ success: true, data: decorate(updated) });
    } catch (err) {
        return next(err);
    }
};

// ─── G-11 — regulatory export ────────────────────────────────────────────────
//
// "We dealt with it" is not an answer to MeitY, a court, or law enforcement.
// This is.

exports.exportRange = async (req, res, next) => {
    try {
        const { from, to, format = 'json' } = req.query;
        if (!from || !to) {
            return res.status(400).json({ success: false, message: 'from and to (ISO dates) are required' });
        }

        const items = await store.list(TABLES.GRIEVANCES, {
            filter: (g) => g.receivedAt >= from && g.receivedAt <= `${to}￿`,
        });

        const rows = items
            .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
            .map((g) => {
                const sla = computeSla(g);
                return {
                    reference: g.reference,
                    channel: g.channel,
                    category: g.category,
                    urgentTrack: g.isUrgent,
                    receivedAt: g.receivedAt,
                    enteredAt: g.enteredAt,
                    acknowledgedAt: g.acknowledgedAt,
                    acknowledgementMet: sla.acknowledgement.met,
                    assignedTo: g.assignedToName ?? g.assignedTo,
                    urgentActionedAt: g.urgentActionedAt,
                    urgentActionMet: sla.urgentAction?.met ?? null,
                    resolvedAt: g.resolvedAt,
                    resolutionMet: sla.resolution.met,
                    outcome: g.resolution?.outcome ?? null,
                    reasoning: g.resolution?.reasoning ?? null,
                    appealReceivedAt: g.appeal?.receivedAt ?? null,
                    appealDecision: g.appeal?.decision ?? null,
                    // Complainant identity is included — a regulator asking how a
                    // complaint was handled needs to match it to the complaint
                    // they were told about. Access to this endpoint is logged.
                    complainant: g.complainantName ?? g.complainantEmail ?? g.complainantUserId,
                };
            });

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.GRIEVANCE_EXPORTED,
            targetType: 'grievance_export',
            targetId: `${from}..${to}`,
            reason: req.query.reason ?? 'Grievance activity exported for a date range',
            metadata: { from, to, rows: rows.length, format },
            request: req,
        });

        if (format === 'csv') {
            const headers = Object.keys(rows[0] ?? { reference: '' });
            const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
            const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h])).join(','))].join('\n');
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="hive-grievances-${from}-to-${to}.csv"`);
            return res.send(csv);
        }

        return res.json({
            success: true,
            meta: {
                from, to, rows: rows.length,
                generatedAt: new Date().toISOString(),
                generatedBy: req.admin.email,
                commitments: {
                    acknowledgementHours: SLA.ACK_HOURS,
                    resolutionDays: SLA.RESOLVE_DAYS,
                    urgentActionHours: SLA.URGENT_ACTION_HOURS,
                },
            },
            data: rows,
        });
    } catch (err) {
        return next(err);
    }
};

exports.categories = (_req, res) => res.json({
    success: true,
    data: {
        urgent: URGENT_GRIEVANCE_CATEGORIES,
        standard: STANDARD_GRIEVANCE_CATEGORIES,
        channels: GRIEVANCE_CHANNELS,
    },
});

exports.runAcknowledgementSweep = runAcknowledgementSweep;
