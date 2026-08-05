/**
 * /admin route namespace (AR-02).
 *
 * Mount into bond-srv's server.js:
 *
 *     const adminRouter = require('./admin/routes');
 *     app.use('/admin', adminRouter);
 *
 * Note what is *not* here: `verifyToken` from ../middleware/authMiddleware.
 * Every route below authenticates through requireAdmin, which uses a different
 * secret, issuer, audience and session store. The consumer middleware is never
 * in this chain — if it were, a consumer token would satisfy it (AR-03).
 */

const express = require('express');

const { requireAdmin, assertSecretsAreSeparate } = require('../middleware/adminAuth');
const {
    requirePermission, requireSuperAdmin, requireReason, requireVersion,
} = require('../middleware/rbac');
const {
    loginLimiter, mfaLimiter, apiLimiter, sensitiveLimiter, exportLimiter, ipAllowlist,
} = require('../middleware/rateLimit');
const { PERM, KYC_REJECTION_REASONS, MODERATION_REJECTION_REASONS, BOOKING_FORCE_REASONS, PAYOUT_HOLD_REASONS, SUSPENSION_REASONS } = require('../config/constants');

const auth = require('../controllers/authController');
const dashboard = require('../controllers/dashboardController');
const kyc = require('../controllers/kycController');
const moderation = require('../controllers/moderationController');
const reports = require('../controllers/reportController');
const grievances = require('../controllers/grievanceController');
const bookings = require('../controllers/bookingController');
const finance = require('../controllers/financeController');
const users = require('../controllers/userController');
const auditLog = require('../controllers/auditController');
const pii = require('../controllers/piiController');
const tax = require('../controllers/taxController');

// Boot-time assertions. If ADMIN_JWT_SECRET is missing, weak, or equal to the
// consumer secret, the process fails to start rather than serving a dashboard
// whose tokens a consumer flow could mint. Likewise if someone has asked for the
// demo 2FA bypass while pointing at real data.
assertSecretsAreSeparate();
auth.assertDemoBypassIsSafe();

const router = express.Router();

// AR-07 — off by default, applies to everything including login.
router.use(ipAllowlist);

// ─── Public (pre-authentication) ─────────────────────────────────────────────

router.post('/auth/login', loginLimiter, auth.login);
router.post('/auth/mfa', mfaLimiter, auth.verifyMfa);

router.get('/healthz', (_req, res) => res.json({ status: 'ok', surface: 'admin' }));

/**
 * G-02 on serverless.
 *
 * A long-lived process runs the acknowledgement sweep on a 5-minute interval in
 * index.js. Serverless has no interval, so a scheduled invoker calls this
 * instead — see server/vercel.json. The grievance list endpoint sweeps too, so
 * this only matters overnight, which is exactly when it matters: the 24-hour
 * clock runs whether or not anyone is awake.
 *
 * Not an admin route — the caller is a cron scheduler with no session — so it is
 * authenticated by a shared secret instead. Without CRON_SECRET set it is
 * disabled outright rather than left open, because an unauthenticated endpoint
 * that writes to grievance records and sends email is not something to leave
 * lying around on a default.
 */
async function acknowledgementSweepEndpoint(req, res, next) {
    try {
        const secret = process.env.CRON_SECRET;
        if (!secret) {
            return res.status(503).json({
                success: false,
                code: 'CRON_NOT_CONFIGURED',
                message: 'CRON_SECRET is not set, so the scheduled sweep endpoint is disabled',
            });
        }
        const presented = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        const { constantTimeEquals } = require('../lib/crypto');
        if (!constantTimeEquals(presented, secret)) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const { runAcknowledgementSweep } = require('../controllers/grievanceController');
        const acknowledged = await runAcknowledgementSweep();
        return res.json({ success: true, acknowledged: acknowledged.length });
    } catch (err) {
        return next(err);
    }
}

// Vercel Cron issues GET; other schedulers tend to POST. One handler, both verbs.
router.route('/internal/acknowledge-sweep')
    .get(acknowledgementSweepEndpoint)
    .post(acknowledgementSweepEndpoint);

// ─── Everything below requires an admin session ──────────────────────────────

router.use(requireAdmin, apiLimiter);

router.get('/auth/me', auth.me);
router.post('/auth/logout', auth.logout);
router.post('/auth/password', auth.changePassword);

// §11 — operational dashboard
router.get('/dashboard', requirePermission(PERM.DASHBOARD_VIEW), dashboard.overview);

// ─── §5 KYC ──────────────────────────────────────────────────────────────────

router.get('/kyc/reasons', requirePermission(PERM.KYC_VIEW), kyc.reasons);
router.get('/kyc/queue', requirePermission(PERM.KYC_VIEW), kyc.queue);
router.get('/kyc/:submissionId', requirePermission(PERM.KYC_VIEW), kyc.detail);
router.get('/kyc/:submissionId/document/:kind', requirePermission(PERM.KYC_VIEW), sensitiveLimiter, kyc.document);
router.post('/kyc/:submissionId/approve', requirePermission(PERM.KYC_DECIDE), requireVersion, kyc.approve);
router.post('/kyc/:submissionId/reject',
    requirePermission(PERM.KYC_DECIDE),
    requireReason({ allowedCodes: KYC_REJECTION_REASONS }), // K-07
    requireVersion,
    kyc.reject);
router.post('/kyc/:submissionId/request-resubmission',
    requirePermission(PERM.KYC_DECIDE),
    requireReason({ allowedCodes: KYC_REJECTION_REASONS }),
    requireVersion,
    kyc.requestResubmission);
router.post('/kyc/:submissionId/correct', requirePermission(PERM.KYC_DECIDE), kyc.correct); // K-12

// ─── §6.1 Moderation ─────────────────────────────────────────────────────────

router.get('/moderation/reasons', requirePermission(PERM.MODERATION_VIEW), moderation.reasons);
router.get('/moderation', requirePermission(PERM.MODERATION_VIEW), moderation.queue);
router.get('/moderation/:itemId', requirePermission(PERM.MODERATION_VIEW), moderation.detail);
router.post('/moderation/:itemId/approve', requirePermission(PERM.MODERATION_DECIDE), requireVersion, moderation.approve);
router.post('/moderation/:itemId/reject',
    requirePermission(PERM.MODERATION_DECIDE),
    requireReason({ allowedCodes: MODERATION_REJECTION_REASONS }), // M-05
    requireVersion,
    moderation.reject);
router.post('/moderation/:itemId/escalate', requirePermission(PERM.MODERATION_VIEW), moderation.escalate); // M-06

// ─── §6.2 Reports ────────────────────────────────────────────────────────────

router.get('/reports/meta', requirePermission(PERM.REPORT_VIEW), reports.meta);
router.get('/reports', requirePermission(PERM.REPORT_VIEW), reports.queue);
router.get('/reports/:reportId', requirePermission(PERM.REPORT_VIEW), reports.detail);
router.post('/reports/:reportId/assign', requirePermission(PERM.REPORT_ACTION), reports.assign);
router.post('/reports/:reportId/act', requirePermission(PERM.REPORT_ACTION), requireVersion, reports.act);
router.post('/reports/:reportId/dismiss', requirePermission(PERM.REPORT_ACTION), requireVersion, reports.dismiss);

// ─── §6.3 Grievances ─────────────────────────────────────────────────────────

router.get('/grievances/categories', requirePermission(PERM.GRIEVANCE_VIEW), grievances.categories);
router.get('/grievances/export', requirePermission(PERM.GRIEVANCE_EXPORT), exportLimiter, grievances.exportRange); // G-11
router.get('/grievances', requirePermission(PERM.GRIEVANCE_VIEW), grievances.list);
router.post('/grievances', requirePermission(PERM.GRIEVANCE_ACTION), grievances.create); // G-01
router.get('/grievances/:grievanceId', requirePermission(PERM.GRIEVANCE_VIEW), grievances.detail);
router.post('/grievances/:grievanceId/assign', requirePermission(PERM.GRIEVANCE_ACTION), requireVersion, grievances.assign);
router.post('/grievances/:grievanceId/urgent-action', requirePermission(PERM.GRIEVANCE_ACTION), requireVersion, grievances.markUrgentActioned); // G-05
router.post('/grievances/:grievanceId/resolve', requirePermission(PERM.GRIEVANCE_ACTION), requireVersion, grievances.resolve); // G-08
router.post('/grievances/:grievanceId/appeal', requirePermission(PERM.GRIEVANCE_ACTION), grievances.recordAppeal); // G-10
router.post('/grievances/:grievanceId/appeal/decide', requirePermission(PERM.GRIEVANCE_ACTION), grievances.decideAppeal);
router.post('/grievances/:grievanceId/note', requirePermission(PERM.GRIEVANCE_ACTION), grievances.addNote);

// ─── §7 Bookings and disputes ────────────────────────────────────────────────

router.get('/bookings/meta', requirePermission(PERM.BOOKING_VIEW), bookings.meta);
router.get('/bookings/disputes', requirePermission(PERM.BOOKING_VIEW), bookings.disputes); // B-08
router.post('/bookings/disputes/:disputeId/resolve', requirePermission(PERM.BOOKING_FORCE), requireVersion, bookings.resolveDispute);
router.get('/bookings', requirePermission(PERM.BOOKING_VIEW), bookings.search); // B-01
router.get('/bookings/:bookingId', requirePermission(PERM.BOOKING_VIEW), bookings.detail); // B-02
router.post('/bookings/:bookingId/force-complete',
    requirePermission(PERM.BOOKING_FORCE),
    requireReason({ allowedCodes: BOOKING_FORCE_REASONS }),
    requireVersion,
    bookings.forceComplete); // B-03
router.post('/bookings/:bookingId/force-cancel',
    requirePermission(PERM.BOOKING_FORCE),
    requireReason({ allowedCodes: BOOKING_FORCE_REASONS }),
    requireVersion,
    bookings.forceCancel); // B-04
router.post('/users/:userId/reliability', requirePermission(PERM.BOOKING_RELIABILITY_ADJUST), bookings.adjustReliability); // B-07

// ─── §8 Finance ──────────────────────────────────────────────────────────────

router.get('/finance/meta', requirePermission(PERM.PAYOUT_VIEW), finance.meta);
router.get('/finance/payouts', requirePermission(PERM.PAYOUT_VIEW), finance.payouts); // F-01
router.post('/finance/payouts/:payoutId/hold',
    requirePermission(PERM.PAYOUT_ACTION),
    requireReason({ allowedCodes: PAYOUT_HOLD_REASONS }),
    requireVersion,
    finance.holdPayout); // F-02
router.post('/finance/payouts/:payoutId/release', requirePermission(PERM.PAYOUT_ACTION), requireVersion, finance.releasePayout); // F-03
router.post('/finance/payouts/:payoutId/retry', requirePermission(PERM.PAYOUT_ACTION), requireVersion, finance.retryPayout); // F-04
router.get('/finance/bank-collisions', requirePermission(PERM.PAYOUT_VIEW), finance.bankAccountCollisions); // F-07
router.get('/finance/reconciliation', requirePermission(PERM.RECON_VIEW), finance.reconciliation); // F-08
router.post('/finance/reconciliation/:reconId/resolve', requirePermission(PERM.RECON_VIEW), finance.resolveDiscrepancy);

router.get('/finance/refunds', requirePermission(PERM.PAYOUT_VIEW), finance.listRefunds);
router.post('/finance/refunds', requirePermission(PERM.REFUND_ISSUE), finance.requestRefund); // F-09
router.post('/finance/refunds/:refundId/approve', requirePermission(PERM.REFUND_APPROVE), requireVersion, finance.approveRefund); // F-10
router.post('/finance/refunds/:refundId/reject', requirePermission(PERM.REFUND_APPROVE), finance.rejectRefund);
router.get('/finance/refunds/history/:userId', requirePermission(PERM.PAYOUT_VIEW), finance.refundHistory); // F-11
router.post('/finance/goodwill', requirePermission(PERM.GOODWILL_ISSUE), finance.issueGoodwill); // F-12

// §8.3 — gated on the CA consultation. Present so the block is discoverable.
router.get('/tax/status', requirePermission(PERM.PAYOUT_VIEW), tax.status);
router.all(/^\/tax\/(?!status).*/, requirePermission(PERM.PAYOUT_VIEW), tax.gated);

// ─── §9 Users ────────────────────────────────────────────────────────────────

router.get('/users/meta', requirePermission(PERM.USER_VIEW), users.meta);
router.get('/users/deletions', requirePermission(PERM.DELETION_QUEUE_PROCESS), users.deletionQueue); // U-05, U-06
router.get('/users/deletions/:requestId', requirePermission(PERM.DELETION_QUEUE_PROCESS), users.deletionDetail); // U-07
router.post('/users/deletions/:requestId/process', requirePermission(PERM.DELETION_QUEUE_PROCESS), users.processDeletion);
router.get('/users', requirePermission(PERM.USER_VIEW), users.search); // U-01
router.get('/users/:userId', requirePermission(PERM.USER_VIEW), users.detail); // U-02
router.post('/users/:userId/suspend',
    requirePermission(PERM.USER_SUSPEND),
    requireReason({ allowedCodes: SUSPENSION_REASONS }),
    users.suspend); // U-03
router.post('/users/:userId/unsuspend', requirePermission(PERM.USER_SUSPEND), users.unsuspend);
router.post('/users/:userId/remove', requireSuperAdmin, users.remove); // U-04

// ─── §4 PII unmask ───────────────────────────────────────────────────────────

router.get('/pii/reasons', pii.reasons);
router.post('/pii/unmask', sensitiveLimiter, pii.unmask); // P-02
router.get('/pii/grants/:recordType/:recordId', pii.grantsForRecord);
router.get('/pii/volume', requireSuperAdmin, pii.volume); // P-06

// ─── §10 Audit ───────────────────────────────────────────────────────────────

router.get('/audit/actions', requirePermission(PERM.AUDIT_VIEW), auditLog.actions);
router.get('/audit/verify', requireSuperAdmin, auditLog.verify); // L-02
router.get('/audit/anomalies', requireSuperAdmin, auditLog.anomalies); // L-07
router.get('/audit/export', requirePermission(PERM.AUDIT_EXPORT), exportLimiter, auditLog.exportRange); // L-08
router.get('/audit/target/:targetType/:targetId', requirePermission(PERM.AUDIT_VIEW), auditLog.forTarget);
router.get('/audit', requirePermission(PERM.AUDIT_VIEW), auditLog.search); // L-03

// ─── §3 / §12 Admin account management — Super Admin only (AR-06) ────────────

router.get('/admins', requireSuperAdmin, auth.listAdmins);
router.post('/admins', requireSuperAdmin, auth.createAdmin);
router.patch('/admins/:adminId/role', requireSuperAdmin, auth.updateAdminRole);
router.patch('/admins/:adminId/status', requireSuperAdmin, auth.setAdminStatus);
router.post('/admins/:adminId/revoke-sessions', requireSuperAdmin, auth.revokeAdminSessions); // §12
router.post('/admins/:adminId/reset-mfa', requireSuperAdmin, auth.resetAdminMfa);             // §12
router.get('/sessions', requireSuperAdmin, auth.listSessions);

// ─── Errors ──────────────────────────────────────────────────────────────────

router.use((req, res) => res.status(404).json({ success: false, message: `No admin route ${req.method} ${req.path}` }));

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, _next) => {
    const status = err.status ?? 500;
    // Internal details never reach the client; the admin surface should not be a
    // source of stack traces about the systems behind it.
    console.error(`[admin] ${req.method} ${req.originalUrl}`, err);
    res.status(status).json({
        success: false,
        code: err.code ?? 'INTERNAL_ERROR',
        message: status === 500 ? 'Something went wrong' : err.message,
    });
});

module.exports = router;
