/**
 * Audit log surface (PRD §10) and the anomaly detection behind L-07.
 *
 * Nothing here can write. The only write path into the audit table is
 * lib/audit.record, and the store refuses updates and deletes on it outright.
 */

const { store, TABLES } = require('../lib/store');
const audit = require('../lib/audit');
const { unmaskVolumeByAdmin } = require('../lib/mask');
const { SLA } = require('../config/constants');

// ─── L-03 — search ───────────────────────────────────────────────────────────

exports.search = async (req, res, next) => {
    try {
        const { actorId, targetId, targetType, action, actionPrefix, from, to, limit = 200, offset = 0 } = req.query;

        const entries = await store.list(TABLES.AUDIT_LOG, {
            filter: (e) => {
                if (actorId && e.actorId !== actorId) return false;
                if (targetId && e.targetId !== targetId) return false;
                if (targetType && e.targetType !== targetType) return false;
                if (action && e.action !== action) return false;
                if (actionPrefix && !String(e.action).startsWith(actionPrefix)) return false;
                if (from && e.at < from) return false;
                if (to && e.at > `${to}￿`) return false;
                return true;
            },
        });

        entries.sort((a, b) => b.seq - a.seq);
        const page = entries.slice(Number(offset), Number(offset) + Number(limit));

        return res.json({
            success: true,
            data: page,
            meta: {
                total: entries.length,
                offset: Number(offset),
                limit: Number(limit),
                retentionDays: SLA.AUDIT_RETENTION_DAYS,
                appendOnly: true,
            },
        });
    } catch (err) {
        return next(err);
    }
};

/** Everything that ever happened to one record, oldest first. */
exports.forTarget = async (req, res, next) => {
    try {
        const { targetType, targetId } = req.params;
        const entries = await store.list(TABLES.AUDIT_LOG, {
            filter: (e) => e.targetType === targetType && e.targetId === targetId,
        });
        return res.json({ success: true, data: entries.sort((a, b) => a.seq - b.seq) });
    } catch (err) {
        return next(err);
    }
};

/** Chain integrity — see lib/audit.verifyChain for what this proves and does not. */
exports.verify = async (_req, res, next) => {
    try {
        return res.json({ success: true, data: await audit.verifyChain() });
    } catch (err) {
        return next(err);
    }
};

// ─── L-07 — anomaly detection ────────────────────────────────────────────────

/**
 * Three signals, all cheap and all things that showed up in the PRD:
 * bulk actions, out-of-hours access, and unusual unmask volume.
 *
 * These are advisory. They surface on the Super Admin dashboard for a human to
 * look at; nothing here suspends an admin automatically.
 */
exports.anomalies = async (req, res, next) => {
    try {
        const windowHours = Number(req.query.hours ?? 24);
        const since = Date.now() - windowHours * 3_600_000;
        const entries = await store.list(TABLES.AUDIT_LOG, { filter: (e) => Date.parse(e.at) > since });

        const byActor = new Map();
        for (const e of entries) {
            if (!e.actorId || e.actorId === 'system') continue;
            const bucket = byActor.get(e.actorId) ?? {
                adminId: e.actorId, email: e.actorEmail, role: e.actorRole,
                total: 0, byAction: {}, outOfHours: 0, timestamps: [],
            };
            bucket.total += 1;
            bucket.byAction[e.action] = (bucket.byAction[e.action] ?? 0) + 1;
            // "Out of hours" in IST: before 07:00 or after 22:00 local.
            const istHour = (new Date(e.at).getUTCHours() + 5 + (new Date(e.at).getUTCMinutes() >= 30 ? 0.5 : 0)) % 24;
            if (istHour < 7 || istHour >= 22) bucket.outOfHours += 1;
            bucket.timestamps.push(Date.parse(e.at));
            byActor.set(e.actorId, bucket);
        }

        const anomalies = [];
        for (const actor of byActor.values()) {
            // Bulk action: more than 20 write-ish events inside any five minutes.
            actor.timestamps.sort((a, b) => a - b);
            let burst = 0;
            for (let i = 0; i < actor.timestamps.length; i++) {
                const windowEnd = actor.timestamps[i] + 300_000;
                const count = actor.timestamps.filter((t) => t >= actor.timestamps[i] && t <= windowEnd).length;
                burst = Math.max(burst, count);
            }
            if (burst >= 20) {
                anomalies.push({
                    kind: 'bulk_actions', severity: 'warning',
                    adminId: actor.adminId, email: actor.email,
                    detail: `${burst} actions inside a five-minute window`,
                });
            }
            if (actor.outOfHours >= 5) {
                anomalies.push({
                    kind: 'out_of_hours', severity: 'warning',
                    adminId: actor.adminId, email: actor.email,
                    detail: `${actor.outOfHours} actions outside 07:00–22:00 IST`,
                });
            }
            const failures = (actor.byAction[audit.ACTIONS.MFA_FAILED] ?? 0) + (actor.byAction[audit.ACTIONS.LOGIN_FAILED] ?? 0);
            if (failures >= 5) {
                anomalies.push({
                    kind: 'auth_failures', severity: 'critical',
                    adminId: actor.adminId, email: actor.email,
                    detail: `${failures} failed sign-in or 2FA attempts`,
                });
            }
        }

        // P-06 / L-07 — unusual unmask volume.
        const unmasks = await unmaskVolumeByAdmin({ sinceMs: windowHours * 3_600_000 });
        const admins = await store.list(TABLES.ADMIN_USERS);
        const emailById = new Map(admins.map((a) => [a.adminId, a.email]));
        for (const u of unmasks) {
            if (u.count >= 10) {
                anomalies.push({
                    kind: 'unmask_volume',
                    severity: u.count >= 25 ? 'critical' : 'warning',
                    adminId: u.adminId,
                    email: emailById.get(u.adminId) ?? null,
                    detail: `${u.count} PII unmasks in ${windowHours}h`,
                    breakdown: u.reasons,
                });
            }
        }

        return res.json({
            success: true,
            data: anomalies.sort((a, b) => (a.severity === 'critical' ? -1 : 1)),
            meta: {
                windowHours,
                actorsSeen: byActor.size,
                eventsScanned: entries.length,
                unmaskLeaderboard: unmasks.slice(0, 5).map((u) => ({ ...u, email: emailById.get(u.adminId) ?? null })),
            },
        });
    } catch (err) {
        return next(err);
    }
};

// ─── L-08 — export ───────────────────────────────────────────────────────────

exports.exportRange = async (req, res, next) => {
    try {
        const { from, to, format = 'json', reason } = req.query;
        if (!from || !to) return res.status(400).json({ success: false, message: 'from and to are required' });

        const entries = (await store.list(TABLES.AUDIT_LOG, {
            filter: (e) => e.at >= from && e.at <= `${to}￿`,
        })).sort((a, b) => a.seq - b.seq);

        // §12 — an export for a law enforcement request is itself a logged event.
        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.AUDIT_EXPORTED,
            targetType: 'audit_export',
            targetId: `${from}..${to}`,
            reason: reason ?? 'Audit log exported for a date range',
            metadata: { from, to, rows: entries.length, format },
            request: req,
        });

        if (format === 'csv') {
            const headers = ['seq', 'at', 'actorEmail', 'actorRole', 'action', 'targetType', 'targetId', 'reason', 'reasonCode', 'ip', 'entryHash'];
            const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
            const csv = [
                headers.join(','),
                ...entries.map((e) => headers.map((h) => escape(e[h])).join(',')),
            ].join('\n');
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="hive-audit-${from}-to-${to}.csv"`);
            return res.send(csv);
        }

        return res.json({
            success: true,
            meta: {
                from, to, rows: entries.length,
                generatedAt: new Date().toISOString(),
                generatedBy: req.admin.email,
                chain: await audit.verifyChain(),
            },
            data: entries,
        });
    } catch (err) {
        return next(err);
    }
};

exports.actions = (_req, res) => res.json({ success: true, data: Object.values(audit.ACTIONS).sort() });
