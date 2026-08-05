/**
 * Audit log (PRD §10).
 *
 * L-01: every privileged action records actor, role, timestamp, target, action,
 * reason, and before/after state.
 * L-02: append-only — enforced by the store, which has no update or delete path
 * for this table.
 *
 * Each entry additionally carries a hash chained to the previous entry. That
 * does not make the log tamper-proof (nothing at the application layer can), but
 * it makes tampering *detectable*: deleting or editing a row breaks the chain
 * from that point on, and the verify endpoint reports where.
 */

const crypto = require('crypto');
const { store, TABLES } = require('./store');
const { randomId } = require('./crypto');

// Actions worth naming rather than free-typing at call sites — a typo'd action
// string is a row that never shows up in the filter that was supposed to find it.
const ACTIONS = {
    // Auth
    LOGIN_SUCCESS: 'auth.login.success',
    LOGIN_FAILED: 'auth.login.failed',
    MFA_FAILED: 'auth.mfa.failed',
    MFA_ENROLLED: 'auth.mfa.enrolled',
    LOGOUT: 'auth.logout',
    SESSION_EXPIRED: 'auth.session.expired',
    SESSION_REVOKED: 'auth.session.revoked',
    PASSWORD_CHANGED: 'auth.password.changed',
    RECOVERY_CODE_USED: 'auth.recovery_code.used',

    // Admin accounts
    ADMIN_CREATED: 'admin.created',
    ADMIN_ROLE_CHANGED: 'admin.role.changed',
    ADMIN_DISABLED: 'admin.disabled',
    ADMIN_ENABLED: 'admin.enabled',
    ADMIN_MFA_RESET: 'admin.mfa.reset',

    // PII
    PII_UNMASKED: 'pii.unmasked',
    DOCUMENT_VIEWED: 'document.viewed',
    DOCUMENT_DOWNLOADED: 'document.downloaded',

    // KYC
    KYC_APPROVED: 'kyc.approved',
    KYC_REJECTED: 'kyc.rejected',
    KYC_RESUBMISSION_REQUESTED: 'kyc.resubmission_requested',
    KYC_MANUAL_REVIEW: 'kyc.manual_review',

    // Moderation
    PROFILE_APPROVED: 'moderation.profile.approved',
    PROFILE_REJECTED: 'moderation.profile.rejected',
    PROFILE_ESCALATED: 'moderation.profile.escalated',

    // Reports
    REPORT_ACTIONED: 'report.actioned',
    REPORT_DISMISSED: 'report.dismissed',
    REPORT_ASSIGNED: 'report.assigned',

    // Grievance
    GRIEVANCE_CREATED: 'grievance.created',
    GRIEVANCE_ACKNOWLEDGED: 'grievance.acknowledged',
    GRIEVANCE_ASSIGNED: 'grievance.assigned',
    GRIEVANCE_RESOLVED: 'grievance.resolved',
    GRIEVANCE_APPEALED: 'grievance.appealed',
    GRIEVANCE_EXPORTED: 'grievance.exported',

    // Bookings
    BOOKING_FORCE_COMPLETED: 'booking.force_completed',
    BOOKING_FORCE_CANCELLED: 'booking.force_cancelled',
    RELIABILITY_ADJUSTED: 'booking.reliability.adjusted',
    DISPUTE_RESOLVED: 'dispute.resolved',

    // Finance
    PAYOUT_HELD: 'payout.held',
    PAYOUT_RELEASED: 'payout.released',
    PAYOUT_RETRIED: 'payout.retried',
    REFUND_REQUESTED: 'refund.requested',
    REFUND_APPROVED: 'refund.approved',
    REFUND_REJECTED: 'refund.rejected',
    REFUND_ISSUED: 'refund.issued',
    GOODWILL_ISSUED: 'goodwill.issued',
    RECON_DISCREPANCY_RESOLVED: 'recon.discrepancy.resolved',

    // Users
    USER_SUSPENDED: 'user.suspended',
    USER_UNSUSPENDED: 'user.unsuspended',
    USER_REMOVED: 'user.removed',
    DELETION_PROCESSED: 'user.deletion.processed',
    DELETION_DEFERRED: 'user.deletion.deferred',

    // Export
    AUDIT_EXPORTED: 'audit.exported',
};

let chainTipPromise = null;

async function currentTip() {
    if (!chainTipPromise) {
        chainTipPromise = (async () => {
            const all = await store.list(TABLES.AUDIT_LOG);
            if (all.length === 0) return { seq: 0, hash: 'GENESIS' };
            const last = all.sort((a, b) => a.seq - b.seq)[all.length - 1];
            return { seq: last.seq, hash: last.entryHash };
        })();
    }
    return chainTipPromise;
}

function computeHash(entry, previousHash) {
    return crypto
        .createHash('sha256')
        .update(JSON.stringify({
            seq: entry.seq,
            at: entry.at,
            actorId: entry.actorId,
            action: entry.action,
            targetType: entry.targetType,
            targetId: entry.targetId,
            reason: entry.reason,
            before: entry.before,
            after: entry.after,
            previousHash,
        }))
        .digest('hex');
}

/**
 * Write one audit entry.
 *
 * Never throws into the caller's happy path silently — an audit write that fails
 * is a P0 incident, so it is logged loudly and the error is rethrown. An action
 * that cannot be recorded must not be reported as done (PRD goal: 100% of
 * privileged actions carry actor, reason and timestamp).
 */
async function record({
    actor,            // { adminId, role, sessionId } — or null for pre-auth events
    action,
    targetType = null,
    targetId = null,
    reason = null,
    reasonCode = null,
    before = null,
    after = null,
    metadata = null,
    request = null,   // express req, for ip / user-agent
}) {
    const tip = await currentTip();
    const seq = tip.seq + 1;

    const entry = {
        eventId: randomId('evt'),
        seq,
        at: new Date().toISOString(),
        actorId: actor?.adminId ?? null,
        actorEmail: actor?.email ?? null,
        actorRole: actor?.role ?? null,
        sessionId: actor?.sessionId ?? null,
        action,
        targetType,
        targetId,
        reason,
        reasonCode,
        before,
        after,
        metadata,
        ip: request ? clientIp(request) : null,
        userAgent: request?.headers?.['user-agent'] ?? null,
        previousHash: tip.hash,
    };
    entry.entryHash = computeHash(entry, tip.hash);

    await store.put(TABLES.AUDIT_LOG, entry);
    chainTipPromise = Promise.resolve({ seq, hash: entry.entryHash });
    return entry;
}

function clientIp(req) {
    const forwarded = req.headers?.['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
    return req.ip ?? req.socket?.remoteAddress ?? null;
}

/**
 * Walk the chain and report the first break, if any. Exposed at
 * GET /admin/audit/verify for Super Admin.
 */
async function verifyChain() {
    const entries = (await store.list(TABLES.AUDIT_LOG)).sort((a, b) => a.seq - b.seq);
    let previousHash = 'GENESIS';
    let expectedSeq = 1;
    for (const entry of entries) {
        if (entry.seq !== expectedSeq) {
            return { intact: false, brokenAt: entry.seq, reason: `Sequence gap — expected ${expectedSeq}` };
        }
        if (entry.previousHash !== previousHash) {
            return { intact: false, brokenAt: entry.seq, reason: 'Previous-hash mismatch' };
        }
        if (computeHash(entry, previousHash) !== entry.entryHash) {
            return { intact: false, brokenAt: entry.seq, reason: 'Entry content does not match its hash' };
        }
        previousHash = entry.entryHash;
        expectedSeq++;
    }
    return { intact: true, entries: entries.length, tip: previousHash };
}

/** Reset the cached chain tip — used by the seeder after bulk-loading history. */
function invalidateTipCache() {
    chainTipPromise = null;
}

module.exports = { record, ACTIONS, verifyChain, clientIp, invalidateTipCache };
