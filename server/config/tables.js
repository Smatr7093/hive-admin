/**
 * Table names and key attributes.
 *
 * Existing bond-srv tables are reused as-is — the admin console reads the same
 * `Test_Table` / `hive_companion` / `hive_booking` / `hive_reviews` the consumer
 * app writes. Everything prefixed `hive_admin_` is new and owned by this module.
 */

const TABLES = {
    // Existing consumer tables (read, and written only through admin actions)
    USERS: process.env.HIVE_USERS_TABLE || 'Test_Table',
    COMPANIONS: process.env.HIVE_COMPANION_TABLE || 'hive_companion',
    BOOKINGS: process.env.HIVE_BOOKING_TABLE || 'hive_booking',
    REVIEWS: process.env.HIVE_REVIEWS_TABLE || 'hive_reviews',

    // Admin-owned tables
    ADMIN_USERS: 'hive_admin_users',
    ADMIN_SESSIONS: 'hive_admin_sessions',
    AUDIT_LOG: 'hive_admin_audit',
    KYC_SUBMISSIONS: 'hive_admin_kyc_submissions',
    MODERATION_ITEMS: 'hive_admin_moderation',
    REPORTS: 'hive_admin_reports',
    GRIEVANCES: 'hive_admin_grievances',
    DISPUTES: 'hive_admin_disputes',
    PAYOUTS: 'hive_admin_payouts',
    REFUNDS: 'hive_admin_refunds',
    BANK_ACCOUNTS: 'hive_admin_bank_accounts',
    RECONCILIATION: 'hive_admin_reconciliation',
    DELETION_REQUESTS: 'hive_admin_deletion_requests',
    UNMASK_GRANTS: 'hive_admin_unmask_grants',
    NOTIFICATIONS: 'hive_admin_notifications',
};

const TABLE_KEYS = {
    [TABLES.USERS]: 'userId',
    [TABLES.COMPANIONS]: 'userId',
    [TABLES.BOOKINGS]: 'bookingId',
    [TABLES.REVIEWS]: 'reviewId',
    [TABLES.ADMIN_USERS]: 'adminId',
    [TABLES.ADMIN_SESSIONS]: 'sessionId',
    [TABLES.AUDIT_LOG]: 'eventId',
    [TABLES.KYC_SUBMISSIONS]: 'submissionId',
    [TABLES.MODERATION_ITEMS]: 'itemId',
    [TABLES.REPORTS]: 'reportId',
    [TABLES.GRIEVANCES]: 'grievanceId',
    [TABLES.DISPUTES]: 'disputeId',
    [TABLES.PAYOUTS]: 'payoutId',
    [TABLES.REFUNDS]: 'refundId',
    [TABLES.BANK_ACCOUNTS]: 'bankAccountId',
    [TABLES.RECONCILIATION]: 'reconId',
    [TABLES.DELETION_REQUESTS]: 'requestId',
    [TABLES.UNMASK_GRANTS]: 'grantId',
    [TABLES.NOTIFICATIONS]: 'notificationId',
};

/**
 * L-02 — no admin, including Super Admin, can edit or delete an audit entry.
 * The store refuses patch/remove on anything listed here, so the guarantee is
 * structural rather than a convention controllers have to remember.
 *
 * In production the audit table should additionally be written with a separate
 * IAM role that holds dynamodb:PutItem and nothing else (see docs/SECURITY.md).
 */
const APPEND_ONLY_TABLES = new Set([TABLES.AUDIT_LOG]);

module.exports = { TABLES, TABLE_KEYS, APPEND_ONLY_TABLES };
