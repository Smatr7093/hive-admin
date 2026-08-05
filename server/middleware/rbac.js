/**
 * Role-based access control (PRD §4) and the reason requirement (L-01).
 *
 * Also home to the IDOR guard carried over from the v1 security review: an Ops
 * admin must not reach Finance-only records by changing an ID. Route-level
 * permissions do most of that work; `requireOwnScope` covers the cases where the
 * record type is only known after the fetch.
 */

const { ROLE_PERMISSIONS, ROLES } = require('../config/constants');

function forbidden(res, message, needed) {
    return res.status(403).json({
        success: false,
        code: 'FORBIDDEN',
        message,
        ...(needed ? { requiredPermission: needed } : {}),
    });
}

/** Gate a route on one permission. */
function requirePermission(permission) {
    return (req, res, next) => {
        if (!req.admin) return res.status(401).json({ success: false, message: 'Not authenticated' });
        if (!req.admin.permissions.includes(permission)) {
            return forbidden(res, `Your role (${req.admin.role}) cannot perform this action`, permission);
        }
        return next();
    };
}

/** Gate on any one of several permissions. */
function requireAnyPermission(...permissions) {
    return (req, res, next) => {
        if (!req.admin) return res.status(401).json({ success: false, message: 'Not authenticated' });
        if (!permissions.some((p) => req.admin.permissions.includes(p))) {
            return forbidden(res, `Your role (${req.admin.role}) cannot perform this action`, permissions.join(' | '));
        }
        return next();
    };
}

function requireSuperAdmin(req, res, next) {
    if (!req.admin) return res.status(401).json({ success: false, message: 'Not authenticated' });
    if (req.admin.role !== ROLES.SUPER_ADMIN) {
        return forbidden(res, 'Super Admin only');
    }
    return next();
}

/**
 * L-01 — a privileged action without a reason is an unexplained action, and an
 * unexplained action is indistinguishable from an unauthorised one after the
 * fact. Reject at the edge rather than storing null.
 *
 * `allowedCodes` is the fixed list for this action type (K-07, M-05, P-02...).
 */
function requireReason({ allowedCodes = null, minLength = 0, field = 'reasonCode' } = {}) {
    return (req, res, next) => {
        const code = req.body?.[field];
        const note = req.body?.note ?? req.body?.reason ?? '';

        if (allowedCodes) {
            const valid = allowedCodes.map((r) => (typeof r === 'string' ? r : r.id));
            if (!code || !valid.includes(code)) {
                return res.status(400).json({
                    success: false,
                    code: 'INVALID_REASON',
                    message: `'${field}' is required and must be one of the permitted reasons`,
                    allowed: allowedCodes,
                });
            }
        } else if (!note || String(note).trim().length < Math.max(1, minLength)) {
            return res.status(400).json({
                success: false,
                code: 'REASON_REQUIRED',
                message: minLength
                    ? `A reason of at least ${minLength} characters is required`
                    : 'A reason is required',
            });
        }

        if (minLength && String(note).trim().length < minLength && allowedCodes) {
            // A fixed code plus a too-short note is fine; the code carries the meaning.
        }

        return next();
    };
}

/**
 * Optimistic locking (PRD §12 — two admins actioning the same ticket).
 *
 * Clients echo back the `version` they were shown. The store's conditional write
 * does the real enforcement; this just gives a clear 400 when the header is
 * missing entirely, rather than silently disabling the check.
 */
function requireVersion(req, res, next) {
    const raw = req.body?.expectedVersion ?? req.headers['if-match'];
    const version = Number(raw);
    if (!Number.isInteger(version) || version < 1) {
        return res.status(400).json({
            success: false,
            code: 'VERSION_REQUIRED',
            message: 'expectedVersion (or an If-Match header) is required so concurrent edits can be detected',
        });
    }
    req.expectedVersion = version;
    return next();
}

/**
 * Carried from the v1 security review: ownership/scoping checks apply to admin
 * endpoints too. `loader` fetches the record; `check` decides whether this actor
 * may touch it. Returns 404 rather than 403 on failure so the endpoint does not
 * confirm the existence of records the caller cannot see.
 */
function requireRecordScope(loader, check) {
    return async (req, res, next) => {
        try {
            const record = await loader(req);
            if (!record) return res.status(404).json({ success: false, message: 'Not found' });
            if (!check(req.admin, record)) {
                return res.status(404).json({ success: false, message: 'Not found' });
            }
            req.record = record;
            return next();
        } catch (err) {
            return next(err);
        }
    };
}

function permissionsForRole(role) {
    return ROLE_PERMISSIONS[role] ?? [];
}

module.exports = {
    requirePermission, requireAnyPermission, requireSuperAdmin,
    requireReason, requireVersion, requireRecordScope, permissionsForRole,
};
