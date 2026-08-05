/**
 * Operational dashboard (PRD §11).
 *
 * Counters only. The PRD is explicit that this is not BI, and the temptation to
 * add "revenue this month" to an operations screen is exactly how an operations
 * screen stops being looked at by operators.
 *
 * Every tile answers one question: is there work outstanding, and how late is it.
 */

const { store, TABLES } = require('../lib/store');
const { computeSla, summarise } = require('../lib/sla');
const { ROLES, FINANCE } = require('../config/constants');

exports.overview = async (req, res, next) => {
    try {
        const now = Date.now();

        const [kyc, grievances, reports, payouts, disputes, deletions, moderation, audit] = await Promise.all([
            store.list(TABLES.KYC_SUBMISSIONS, { filter: (k) => ['pending', 'manual_review'].includes(k.status) && !k.supersededBy }),
            store.list(TABLES.GRIEVANCES),
            store.list(TABLES.REPORTS, { filter: (r) => r.status === 'open' }),
            store.list(TABLES.PAYOUTS),
            store.list(TABLES.DISPUTES, { filter: (d) => d.status === 'open' }),
            store.list(TABLES.DELETION_REQUESTS, { filter: (d) => d.status === 'pending' }),
            store.list(TABLES.MODERATION_ITEMS, { filter: (m) => m.status === 'pending' }),
            store.list(TABLES.AUDIT_LOG, { filter: (e) => Date.parse(e.at) > now - 86_400_000 }),
        ]);

        // Deletion blockers are computed per request; cheap enough at queue size.
        const { deletionBlockers } = require('./userController');
        const deletionsWithBlockers = await Promise.all(
            deletions.map(async (d) => ({ ...d, blockers: await deletionBlockers(d.userId) }))
        );

        const oldestKyc = kyc.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))[0];
        const grievanceSummary = summarise(grievances, now);

        const actionsByRole = {};
        for (const e of audit) {
            if (!e.actorRole || e.actorRole === 'system') continue;
            actionsByRole[e.actorRole] = (actionsByRole[e.actorRole] ?? 0) + 1;
        }

        const tiles = {
            kyc: {
                label: 'KYC queue',
                open: kyc.length,
                oldestHours: oldestKyc ? Math.round(((now - Date.parse(oldestKyc.submittedAt)) / 3_600_000) * 10) / 10 : 0,
                // The PRD's own target: median decision under 12h.
                breachingTarget: kyc.filter((k) => now - Date.parse(k.submittedAt) > 12 * 3_600_000).length,
                href: '/kyc',
            },
            grievances: {
                label: 'Grievances',
                open: grievanceSummary.open,
                breached: grievanceSummary.breached,
                critical: grievanceSummary.critical,
                warning: grievanceSummary.warning,
                awaitingAcknowledgement: grievanceSummary.awaitingAcknowledgement,
                unassignedFlagged: grievanceSummary.unassignedFlagged,
                href: '/grievances',
            },
            urgentTrack: {
                label: 'Urgent track',
                outstanding: grievanceSummary.urgentOpen,
                breached: grievances.filter((g) => g.isUrgent && !g.resolvedAt && computeSla(g, now).urgentAction?.state === 'breached').length,
                href: '/grievances?state=urgent',
            },
            reports: {
                label: 'Open reports',
                open: reports.length,
                high: reports.filter((r) => r.severity === 'high').length,
                medium: reports.filter((r) => r.severity === 'medium').length,
                low: reports.filter((r) => r.severity === 'low').length,
                href: '/reports',
            },
            moderation: {
                label: 'Moderation queue',
                open: moderation.length,
                newProfiles: moderation.filter((m) => m.type === 'new_profile').length,
                edits: moderation.filter((m) => m.type === 'profile_edit').length,
                escalated: moderation.filter((m) => m.escalated).length,
                href: '/moderation',
            },
            payouts: {
                label: 'Payouts',
                pending: payouts.filter((p) => ['requested', 'processing'].includes(p.status)).length,
                failed: payouts.filter((p) => p.status === 'failed').length,
                held: payouts.filter((p) => p.status === 'held').length,
                pendingValuePaise: payouts
                    .filter((p) => ['requested', 'processing'].includes(p.status))
                    .reduce((s, p) => s + (Number(p.amount) || 0), 0),
                href: '/finance/payouts',
            },
            disputes: {
                label: 'Bookings in dispute',
                open: disputes.length,
                windowClosing: disputes.filter((d) => Date.parse(d.openedAt) + 24 * 3_600_000 - now < 4 * 3_600_000).length,
                distressSignals: disputes.filter((d) => d.blockSignal).length,
                href: '/bookings/disputes',
            },
            deletions: {
                label: 'Deletion requests',
                pending: deletionsWithBlockers.length,
                blocked: deletionsWithBlockers.filter((d) => d.blockers.length > 0).length,
                href: '/users/deletions',
            },
            adminActivity: {
                label: 'Admin actions (24h)',
                total: audit.filter((e) => e.actorRole && e.actorRole !== 'system').length,
                byRole: actionsByRole,
                href: '/audit',
            },
        };

        // Super Admin gets the "who is watching the watchers" tile. Open question
        // #5 in the PRD is unanswered; the least this can do is make the activity
        // visible rather than invisible.
        let superAdminTiles = null;
        if (req.admin.role === ROLES.SUPER_ADMIN) {
            const { unmaskVolumeByAdmin } = require('../lib/mask');
            const unmasks = await unmaskVolumeByAdmin({ sinceMs: 24 * 3_600_000 });
            const admins = await store.list(TABLES.ADMIN_USERS);
            const sessions = await store.list(TABLES.ADMIN_SESSIONS, {
                filter: (s) => !s.revokedAt && Date.parse(s.absoluteExpiresAt) > now,
            });
            const emailById = new Map(admins.map((a) => [a.adminId, a.email]));
            superAdminTiles = {
                unmaskVolume: unmasks.slice(0, 5).map((u) => ({ ...u, email: emailById.get(u.adminId) ?? null })),
                flaggedUnmaskers: unmasks.filter((u) => u.count >= 10).length,
                activeSessions: sessions.length,
                adminAccounts: {
                    total: admins.length,
                    active: admins.filter((a) => a.status === 'active').length,
                    pendingEnrolment: admins.filter((a) => a.status === 'pending_enrolment').length,
                    disabled: admins.filter((a) => a.status === 'disabled').length,
                    superAdmins: admins.filter((a) => a.role === ROLES.SUPER_ADMIN && a.status !== 'disabled').length,
                },
                // Open question #1 — a single-Super-Admin setup has no recovery
                // path without a documented break-glass process, so say so.
                breakGlassRisk: admins.filter((a) => a.role === ROLES.SUPER_ADMIN && a.status === 'active').length < 2,
            };
        }

        return res.json({
            success: true,
            data: {
                tiles,
                superAdmin: superAdminTiles,
                config: {
                    dualApprovalThresholdPaise: FINANCE.DUAL_APPROVAL_THRESHOLD_PAISE,
                    kycRetentionPolicyResolved: (process.env.ADMIN_KYC_RETENTION_POLICY ?? 'unresolved') !== 'unresolved',
                    taxModuleEnabled: false, // §8.3 gated on the CA consultation
                },
                generatedAt: new Date().toISOString(),
            },
        });
    } catch (err) {
        return next(err);
    }
};
