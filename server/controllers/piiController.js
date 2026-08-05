/**
 * PII unmask requests (PRD §4, P-02 / P-03 / P-06).
 *
 * One endpoint, deliberately: every route into the real value goes through here,
 * so every real value viewed is one audit event with a reason attached. There is
 * no bulk unmask, no "unmask all fields on this page", and no session-wide
 * toggle — a grant names one record and the specific fields on it.
 */

const { store, TABLES } = require('../lib/store');
const audit = require('../lib/audit');
const { createGrant, activeGrantsFor, unmaskVolumeByAdmin, SENSITIVE_FIELDS } = require('../lib/mask');
const { UNMASK_REASONS, PERM } = require('../config/constants');

// Which record types can be unmasked, and where the real value lives.
const RESOLVERS = {
    user: async (id) => (await store.get(TABLES.USERS, id)) ?? (await store.get(TABLES.COMPANIONS, id)),
    bank_account: (id) => store.get(TABLES.BANK_ACCOUNTS, id),
    kyc: (id) => store.get(TABLES.KYC_SUBMISSIONS, id),
    report: (id) => store.get(TABLES.REPORTS, id),
    payout: (id) => store.get(TABLES.PAYOUTS, id),
};

exports.unmask = async (req, res, next) => {
    try {
        const { recordType, recordId, fields, reasonCode } = req.body ?? {};

        if (!req.admin.permissions.includes(PERM.PII_UNMASK)) {
            return res.status(403).json({ success: false, message: 'Your role cannot unmask personal data' });
        }
        if (!RESOLVERS[recordType]) {
            return res.status(400).json({ success: false, message: 'Unknown recordType', allowed: Object.keys(RESOLVERS) });
        }
        if (!Array.isArray(fields) || fields.length === 0) {
            return res.status(400).json({ success: false, message: 'Name the fields you need — there is no unmask-everything option (P-03)' });
        }
        // Refuse '*' explicitly rather than letting it fall through as an
        // unknown field name; the intent behind sending it is the thing P-03
        // exists to prevent.
        if (fields.includes('*')) {
            return res.status(400).json({ success: false, message: 'Wildcard unmask is not permitted (P-03)' });
        }
        const unknown = fields.filter((f) => !(f in SENSITIVE_FIELDS));
        if (unknown.length) {
            return res.status(400).json({ success: false, message: `Not maskable fields: ${unknown.join(', ')}` });
        }

        const reason = UNMASK_REASONS.find((r) => r.id === reasonCode);
        if (!reason) {
            return res.status(400).json({
                success: false,
                code: 'INVALID_REASON',
                message: 'A reason from the fixed list is required (P-02)',
                allowed: UNMASK_REASONS,
            });
        }

        const record = await RESOLVERS[recordType](recordId);
        if (!record) return res.status(404).json({ success: false, message: 'Record not found' });

        const grant = await createGrant({
            actor: req.admin,
            recordType,
            recordId,
            fields,
            reasonCode,
            reasonLabel: reason.label,
        });

        // L-04 — every unmask is its own audit event, not a line in a batch.
        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.PII_UNMASKED,
            targetType: recordType,
            targetId: recordId,
            reason: reason.label,
            reasonCode,
            metadata: { fields, grantId: grant.grantId, note: req.body.note ?? null },
            request: req,
        });

        const values = {};
        for (const field of fields) values[field] = record[field] ?? null;

        return res.json({
            success: true,
            data: {
                grantId: grant.grantId,
                recordType,
                recordId,
                values,
                expiresAt: grant.expiresAt,
                scope: 'This grant covers these fields, on this record, in this session only.',
            },
        });
    } catch (err) {
        return next(err);
    }
};

exports.grantsForRecord = async (req, res, next) => {
    try {
        const { recordType, recordId } = req.params;
        const grants = await activeGrantsFor(req.admin, recordType, recordId);
        return res.json({
            success: true,
            data: grants.map((g) => ({ grantId: g.grantId, fields: g.fields, reasonLabel: g.reasonLabel, expiresAt: g.expiresAt })),
        });
    } catch (err) {
        return next(err);
    }
};

/** P-06 — repeated unmask activity, for the Super Admin dashboard. */
exports.volume = async (req, res, next) => {
    try {
        const hours = Number(req.query.hours ?? 24);
        const rows = await unmaskVolumeByAdmin({ sinceMs: hours * 3_600_000 });
        const admins = await store.list(TABLES.ADMIN_USERS);
        const byId = new Map(admins.map((a) => [a.adminId, a]));
        return res.json({
            success: true,
            data: rows.map((r) => ({
                ...r,
                email: byId.get(r.adminId)?.email ?? null,
                name: byId.get(r.adminId)?.name ?? null,
                role: byId.get(r.adminId)?.role ?? null,
                flagged: r.count >= 10,
            })),
            meta: { windowHours: hours, flagThreshold: 10 },
        });
    } catch (err) {
        return next(err);
    }
};

exports.reasons = (_req, res) => res.json({ success: true, data: UNMASK_REASONS });
