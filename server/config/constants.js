/**
 * Hive Admin — shared constants
 *
 * Everything here is a closed vocabulary on purpose. PRD K-07 / M-05 / P-02 all
 * turn on the fact that reasons come from a fixed list: free text produces
 * inconsistent decisions and un-queryable rejection patterns.
 */

// ─── Roles (PRD §4) ──────────────────────────────────────────────────────────

const ROLES = {
    SUPER_ADMIN: 'super_admin',
    OPS: 'ops',
    SUPPORT: 'support',
    FINANCE: 'finance',
    READ_ONLY: 'read_only',
};

const ROLE_LIST = Object.values(ROLES);

const ROLE_LABELS = {
    [ROLES.SUPER_ADMIN]: 'Super Admin',
    [ROLES.OPS]: 'Ops',
    [ROLES.SUPPORT]: 'Support',
    [ROLES.FINANCE]: 'Finance',
    [ROLES.READ_ONLY]: 'Read-only',
};

// ─── Permissions ─────────────────────────────────────────────────────────────
//
// Named capabilities rather than route strings — a route can move without the
// permission model changing, and the matrix below stays readable.

const PERM = {
    // Dashboard / read surfaces
    DASHBOARD_VIEW: 'dashboard:view',

    // KYC
    KYC_VIEW: 'kyc:view',
    KYC_DECIDE: 'kyc:decide',
    KYC_DOC_DOWNLOAD: 'kyc:doc:download',

    // Moderation
    MODERATION_VIEW: 'moderation:view',
    MODERATION_DECIDE: 'moderation:decide',

    // Reports
    REPORT_VIEW: 'report:view',
    REPORT_ACTION: 'report:action',

    // Grievance
    GRIEVANCE_VIEW: 'grievance:view',
    GRIEVANCE_ACTION: 'grievance:action',
    GRIEVANCE_EXPORT: 'grievance:export',

    // Bookings / disputes
    BOOKING_VIEW: 'booking:view',
    BOOKING_FORCE: 'booking:force',
    BOOKING_RELIABILITY_ADJUST: 'booking:reliability:adjust',

    // Finance
    PAYOUT_VIEW: 'payout:view',
    PAYOUT_ACTION: 'payout:action',
    REFUND_ISSUE: 'refund:issue',
    REFUND_APPROVE: 'refund:approve',
    GOODWILL_ISSUE: 'goodwill:issue',
    RECON_VIEW: 'recon:view',

    // Users
    USER_VIEW: 'user:view',
    USER_SUSPEND: 'user:suspend',
    USER_DELETE: 'user:delete',
    DELETION_QUEUE_PROCESS: 'deletion:process',

    // PII
    PII_VIEW_UNMASKED: 'pii:view_unmasked', // sees real values without an unmask grant
    PII_UNMASK: 'pii:unmask',               // may request a per-record unmask grant

    // Audit
    AUDIT_VIEW: 'audit:view',
    AUDIT_EXPORT: 'audit:export',

    // Admin account management
    ADMIN_MANAGE: 'admin:manage',
    SESSION_REVOKE: 'session:revoke',
};

/**
 * PRD §4 permission matrix.
 *
 * Read-only holds view permissions on aggregate surfaces only — never a
 * mutation, never PII.
 */
const ROLE_PERMISSIONS = {
    [ROLES.SUPER_ADMIN]: Object.values(PERM),

    [ROLES.OPS]: [
        PERM.DASHBOARD_VIEW,
        PERM.KYC_VIEW, PERM.KYC_DECIDE, PERM.KYC_DOC_DOWNLOAD,
        PERM.MODERATION_VIEW, PERM.MODERATION_DECIDE,
        PERM.REPORT_VIEW, PERM.REPORT_ACTION,
        PERM.GRIEVANCE_VIEW, PERM.GRIEVANCE_ACTION, PERM.GRIEVANCE_EXPORT,
        PERM.BOOKING_VIEW, PERM.BOOKING_FORCE, PERM.BOOKING_RELIABILITY_ADJUST,
        PERM.USER_VIEW, PERM.USER_SUSPEND,
        PERM.DELETION_QUEUE_PROCESS,
        PERM.PII_VIEW_UNMASKED, PERM.PII_UNMASK,
        PERM.AUDIT_VIEW,
    ],

    // Support sees profiles and bookings with PII masked by default (P-01) and
    // may lift the mask per record, per session, with a reason (P-02, P-03).
    [ROLES.SUPPORT]: [
        PERM.DASHBOARD_VIEW,
        PERM.MODERATION_VIEW,
        PERM.REPORT_VIEW,
        PERM.GRIEVANCE_VIEW, PERM.GRIEVANCE_ACTION,
        PERM.BOOKING_VIEW,
        PERM.USER_VIEW,
        PERM.GOODWILL_ISSUE,
        PERM.PII_UNMASK,
    ],

    [ROLES.FINANCE]: [
        PERM.DASHBOARD_VIEW,
        PERM.PAYOUT_VIEW, PERM.PAYOUT_ACTION,
        PERM.REFUND_ISSUE, PERM.REFUND_APPROVE,
        PERM.RECON_VIEW,
        PERM.BOOKING_VIEW,
        PERM.USER_VIEW,
        PERM.PII_VIEW_UNMASKED, PERM.PII_UNMASK,
        PERM.AUDIT_VIEW,
    ],

    [ROLES.READ_ONLY]: [
        PERM.DASHBOARD_VIEW,
    ],
};

// ─── Fixed reason lists ──────────────────────────────────────────────────────

// K-07
const KYC_REJECTION_REASONS = [
    { id: 'blurry', label: 'Blurry / unreadable' },
    { id: 'name_mismatch', label: 'Name mismatch' },
    { id: 'expired', label: 'Document expired' },
    { id: 'underage', label: 'Underage' },
    { id: 'suspected_forgery', label: 'Suspected forgery' },
    { id: 'type_not_accepted', label: 'Document type not accepted' },
];

// M-05 — aligned to the Community Guidelines hard lines
const MODERATION_REJECTION_REASONS = [
    { id: 'sexual_solicitation', label: 'Sexual solicitation or implication', escalates: true },
    { id: 'nudity', label: 'Nudity or sexually explicit imagery', escalates: true },
    { id: 'minor_involved', label: 'Appears to involve a minor', escalates: true },
    { id: 'impersonation', label: 'Impersonation or misleading identity' },
    { id: 'contact_sharing', label: 'Off-platform contact details in profile' },
    { id: 'photo_not_self', label: 'Photo is not of the account holder' },
    { id: 'offensive_content', label: 'Hateful, abusive or offensive content' },
    { id: 'commercial_spam', label: 'Advertising or commercial spam' },
    { id: 'incomplete_low_quality', label: 'Incomplete or unusable profile' },
];

// P-02 — an unmask needs a reason, and the reason has to be from a list, or the
// field fills with "checking" and the log is worthless.
const UNMASK_REASONS = [
    { id: 'payout_verification', label: 'Verifying payout destination' },
    { id: 'refund_processing', label: 'Processing a refund' },
    { id: 'kyc_review', label: 'KYC document review' },
    { id: 'fraud_investigation', label: 'Fraud or mule-account investigation' },
    { id: 'user_support_request', label: 'User asked us to confirm their details' },
    { id: 'law_enforcement_request', label: 'Law enforcement / regulatory request' },
    { id: 'reconciliation', label: 'Ledger reconciliation discrepancy' },
];

// M-10 — the enforcement ladder, in order of severity
const ENFORCEMENT_ACTIONS = [
    { id: 'warn', label: 'Warn', severity: 1 },
    { id: 'remove_content', label: 'Remove content', severity: 2 },
    { id: 'temp_suspension', label: 'Temporary suspension', severity: 3 },
    { id: 'withhold_payout', label: 'Withhold payout', severity: 4 },
    { id: 'permanent_removal', label: 'Permanent removal', severity: 5 },
    { id: 'law_enforcement', label: 'Escalate to law enforcement', severity: 6 },
];

const REPORT_CATEGORIES = [
    { id: 'harassment', label: 'Harassment or abuse' },
    { id: 'sexual_solicitation', label: 'Sexual solicitation' },
    { id: 'no_show', label: 'No-show' },
    { id: 'safety_concern', label: 'Safety concern' },
    { id: 'impersonation', label: 'Impersonation' },
    { id: 'payment_issue', label: 'Payment issue' },
    { id: 'off_platform', label: 'Pushed off-platform' },
    { id: 'other', label: 'Other' },
];

// G-05 — the urgent track. These are the categories tryhive.in/grievance-redressal
// commits to actioning within 24 hours.
const URGENT_GRIEVANCE_CATEGORIES = [
    { id: 'ncii', label: 'Non-consensual intimate imagery' },
    { id: 'nudity', label: 'Nudity / sexual imagery' },
    { id: 'impersonation', label: 'Impersonation' },
    { id: 'morphed_image', label: 'Morphed or synthetic image' },
    { id: 'minor_involved', label: 'Involves a minor' },
];

const STANDARD_GRIEVANCE_CATEGORIES = [
    { id: 'content_complaint', label: 'Content complaint' },
    { id: 'conduct_complaint', label: 'Conduct of another user' },
    { id: 'privacy_complaint', label: 'Privacy / data complaint' },
    { id: 'payment_complaint', label: 'Payment or refund complaint' },
    { id: 'account_action_appeal', label: 'Appeal against an account action' },
    { id: 'other', label: 'Other' },
];

const GRIEVANCE_CHANNELS = [
    { id: 'in_app', label: 'In-app' },
    { id: 'email', label: 'Email — grievance@tryhive.in' },
    { id: 'postal', label: 'Postal' },
];

const SUSPENSION_REASONS = [
    { id: 'under_investigation', label: 'Under investigation' },
    { id: 'guideline_violation', label: 'Community guideline violation' },
    { id: 'payment_fraud', label: 'Suspected payment fraud' },
    { id: 'safety_risk', label: 'Safety risk to other users' },
    { id: 'repeat_reports', label: 'Repeated reports upheld' },
    { id: 'user_request', label: 'At the user\'s own request' },
];

// ─── SLA windows (PRD §6.3) ──────────────────────────────────────────────────

const SLA = {
    ACK_HOURS: 24,
    RESOLVE_DAYS: 15,
    URGENT_ACTION_HOURS: 24,
    UNASSIGNED_FLAG_HOURS: 4,      // G-07
    APPEAL_WINDOW_DAYS: 30,        // G-10
    GRIEVANCE_RETENTION_DAYS: 180, // G-12
    AUDIT_RETENTION_DAYS: 1095,    // L-06 — 3 years
};

// ─── Session policy (AR-04, AR-05) ───────────────────────────────────────────

const SESSION = {
    MAX_LIFETIME_MS: 8 * 60 * 60 * 1000,
    IDLE_TIMEOUT_MS: 30 * 60 * 1000,
    ISSUER: 'hive-admin',
    AUDIENCE: 'hive-admin-console',
    TOKEN_TYPE: 'admin',           // AR-03 — consumer tokens carry no typ claim
    MFA_CHALLENGE_TTL_MS: 5 * 60 * 1000,
    UNMASK_GRANT_TTL_MS: 15 * 60 * 1000, // P-03 — per record, per session, short
};

// ─── KYC policy (PRD §5) ─────────────────────────────────────────────────────

const KYC = {
    MAX_SUBMISSIONS: 3,             // K-10
    RESUBMISSION_WINDOW_DAYS: 7,    // K-10
    MANUAL_REVIEW_AFTER_REJECTIONS: 3, // K-09
    MIN_AGE: 18,                    // K-03
};

// ─── Finance policy (PRD §8) ─────────────────────────────────────────────────

const FINANCE = {
    // F-10 — recommendation in the PRD, open question #2. Configurable so the
    // number can move without a deploy once it is confirmed.
    DUAL_APPROVAL_THRESHOLD_PAISE: Number(process.env.ADMIN_DUAL_APPROVAL_THRESHOLD ?? 500000), // ₹5,000
    // F-12 — Support's goodwill ceiling
    GOODWILL_MAX_PAISE: Number(process.env.ADMIN_GOODWILL_MAX ?? 50000), // ₹500
    BANK_CHANGE_COOLING_HOURS: 48, // F-06, per v2.0 M-10
};

const REFUND_REASONS = [
    { id: 'companion_no_show', label: 'Companion no-show' },
    { id: 'seeker_no_show_dispute', label: 'Disputed no-show' },
    { id: 'safety_incident', label: 'Safety incident' },
    { id: 'service_not_as_described', label: 'Service not as described' },
    { id: 'duplicate_charge', label: 'Duplicate charge' },
    { id: 'technical_failure', label: 'Technical failure (check-in / payment)' },
    { id: 'goodwill', label: 'Goodwill' },
];

const PAYOUT_HOLD_REASONS = [
    { id: 'open_dispute', label: 'Open dispute on a related booking' },
    { id: 'fraud_review', label: 'Fraud review' },
    { id: 'kyc_incomplete', label: 'KYC incomplete or revoked' },
    { id: 'bank_change_cooling', label: 'Bank details changed — cooling-off' },
    { id: 'mule_signal', label: 'Bank account shared across profiles' },
    { id: 'grievance_open', label: 'Open grievance against this companion' },
];

const BOOKING_FORCE_REASONS = [
    { id: 'checkin_failure', label: 'Check-in failed technically' },
    { id: 'both_parties_confirm', label: 'Both parties confirmed out of band' },
    { id: 'companion_no_show', label: 'Companion no-show' },
    { id: 'seeker_no_show', label: 'Seeker no-show' },
    { id: 'safety_incident', label: 'Safety incident' },
    { id: 'duplicate_booking', label: 'Duplicate booking' },
];

const DELETION_RETENTION_BASES = [
    { id: 'financial_records', label: 'Financial records — statutory retention' },
    { id: 'safety_records', label: 'Safety and moderation records' },
    { id: 'registration_record', label: 'Registration record — 180 days' },
    { id: 'legal_hold', label: 'Legal hold / active proceeding' },
    { id: 'grievance_open', label: 'Open grievance — deletion deferred' },
];

module.exports = {
    ROLES, ROLE_LIST, ROLE_LABELS, PERM, ROLE_PERMISSIONS,
    KYC_REJECTION_REASONS, MODERATION_REJECTION_REASONS, UNMASK_REASONS,
    ENFORCEMENT_ACTIONS, REPORT_CATEGORIES,
    URGENT_GRIEVANCE_CATEGORIES, STANDARD_GRIEVANCE_CATEGORIES, GRIEVANCE_CHANNELS,
    SUSPENSION_REASONS, REFUND_REASONS, PAYOUT_HOLD_REASONS, BOOKING_FORCE_REASONS,
    DELETION_RETENTION_BASES,
    SLA, SESSION, KYC, FINANCE,
};
