/**
 * Admin auth (PRD §3, §12).
 *
 * Flow: POST /admin/auth/login → { challengeToken } → POST /admin/auth/mfa →
 * { token, admin }. There is no path from login to a session token that skips
 * the second call (AR-05: no exceptions, no bypass).
 *
 * First-run enrolment: an admin created by a Super Admin starts in
 * `pending_enrolment`. Their first login returns an enrolment secret instead of
 * a session, and they must bind an authenticator before they get one.
 *
 * ── The one exception, and why it cannot reach anything real ────────────────
 *
 * `ADMIN_DEMO_SKIP_MFA=1` collapses the two calls into one so the seeded demo
 * can be walked through without an authenticator. It is off by default and
 * `demoBypassActive()` refuses to return true unless ALL of these hold:
 *
 *   - ADMIN_DEMO_SKIP_MFA is exactly '1'
 *   - ADMIN_DATA_DRIVER is the in-memory driver — never DynamoDB
 *   - NODE_ENV is not 'production'
 *
 * So it cannot engage against real KYC documents even if the flag is left set
 * in an environment file by accident: pointing the server at DynamoDB turns it
 * off on its own. `assertDemoBypassIsSafe()` in routes/index.js goes further and
 * refuses to boot if the flag is set alongside a real data source, rather than
 * quietly ignoring it — a security control that silently downgrades is worse
 * than one that fails loudly.
 *
 * Every sign-in taken this way is written to the audit log as
 * `auth.login.success` with the reason naming the bypass, so a log from a demo
 * run is never mistaken for a log from a real one.
 */

const { store, TABLES } = require('../lib/store');
const audit = require('../lib/audit');
const cryptoLib = require('../lib/crypto');
const {
    signSessionToken, signMfaChallenge, verifyMfaChallenge,
    createSession, revokeSession, revokeAllSessionsForAdmin,
} = require('../middleware/adminAuth');
const { ROLE_PERMISSIONS, ROLE_LIST, ROLES, SESSION } = require('../config/constants');

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

/** Two-factor is on unless ADMIN_MFA_ENABLED is exactly 'false'. */
function demoBypassActive() {
    return String(process.env.ADMIN_MFA_ENABLED).toLowerCase() === 'false';
}

/**
 * Called at mount time. A flag that is set but silently inert is how a bypass
 * survives into production — so if someone has asked for the bypass while
 * pointing at real data, stop rather than pretend.
 */
function assertDemoBypassIsSafe() {
    if (!demoBypassActive()) return;
    console.warn(
        '\n⚠  ADMIN_MFA_ENABLED=false — two-factor authentication is OFF.\n' +
        '   A password alone grants full access to KYC documents, PAN numbers\n' +
        '   and bank account details. Every sign-in is logged as password-only.\n' +
        '   Re-enable with ADMIN_MFA_ENABLED=true.\n'
    );
}

const publicAdmin = (a) => ({
    adminId: a.adminId,
    email: a.email,
    name: a.name,
    role: a.role,
    status: a.status,
    mfaEnrolled: !!a.totpSecret,
    createdAt: a.createdAt,
    createdBy: a.createdBy,
    lastLoginAt: a.lastLoginAt ?? null,
});

async function findByEmail(email) {
    const [found] = await store.list(TABLES.ADMIN_USERS, {
        filter: (a) => a.email.toLowerCase() === String(email).toLowerCase(),
    });
    return found ?? null;
}

// ─── POST /admin/auth/login ──────────────────────────────────────────────────

exports.login = async (req, res, next) => {
    try {
        const { email, password } = req.body ?? {};
        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Email and password are required' });
        }

        const admin = await findByEmail(email);

        // Same response shape and roughly the same work whether or not the
        // account exists — the login endpoint should not be an account oracle.
        if (!admin) {
            cryptoLib.verifyPassword(password, cryptoLib.hashPassword('decoy-work-factor-parity'));
            await audit.record({
                actor: null,
                action: audit.ACTIONS.LOGIN_FAILED,
                reason: 'Unknown admin email',
                metadata: { email: String(email).toLowerCase() },
                request: req,
            });
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        if (admin.status === 'disabled') {
            await audit.record({
                actor: { adminId: admin.adminId, email: admin.email, role: admin.role },
                action: audit.ACTIONS.LOGIN_FAILED,
                reason: 'Account is disabled',
                request: req,
            });
            return res.status(403).json({ success: false, message: 'This account is disabled' });
        }

        if (admin.lockedUntil && Date.parse(admin.lockedUntil) > Date.now()) {
            return res.status(423).json({
                success: false,
                code: 'ACCOUNT_LOCKED',
                message: 'Account temporarily locked after repeated failed sign-ins',
                lockedUntil: admin.lockedUntil,
            });
        }

        if (!cryptoLib.verifyPassword(password, admin.passwordHash)) {
            const failures = (admin.failedLogins ?? 0) + 1;
            const lock = failures >= MAX_FAILED_LOGINS;
            await store.patch(TABLES.ADMIN_USERS, admin.adminId, {
                failedLogins: failures,
                lockedUntil: lock ? new Date(Date.now() + LOCKOUT_MS).toISOString() : null,
            });
            await audit.record({
                actor: { adminId: admin.adminId, email: admin.email, role: admin.role },
                action: audit.ACTIONS.LOGIN_FAILED,
                reason: lock ? 'Wrong password — account locked' : 'Wrong password',
                metadata: { attempt: failures },
                request: req,
            });
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        await store.patch(TABLES.ADMIN_USERS, admin.adminId, { failedLogins: 0, lockedUntil: null });

        // Demo configuration only — see the header comment for the three
        // conditions that must all hold before this is reachable.
        if (demoBypassActive()) {
            return res.json(await issueSession(admin, req, { bypassedMfa: true }));
        }

        // First login — bind an authenticator before anything else. AR-05 has no
        // "remind me later" state.
        if (!admin.totpSecret) {
            const secret = cryptoLib.generateTotpSecret();
            await store.patch(TABLES.ADMIN_USERS, admin.adminId, {
                pendingTotpSecret: secret,
                status: 'pending_enrolment',
            });
            return res.json({
                success: true,
                stage: 'enrol_mfa',
                challengeToken: signMfaChallenge(admin.adminId),
                enrolment: {
                    secret,
                    uri: cryptoLib.totpProvisioningUri(secret, admin.email),
                },
                expiresInSeconds: Math.floor(SESSION.MFA_CHALLENGE_TTL_MS / 1000),
            });
        }

        return res.json({
            success: true,
            stage: 'mfa',
            challengeToken: signMfaChallenge(admin.adminId),
            expiresInSeconds: Math.floor(SESSION.MFA_CHALLENGE_TTL_MS / 1000),
        });
    } catch (err) {
        return next(err);
    }
};

// ─── POST /admin/auth/mfa ────────────────────────────────────────────────────

exports.verifyMfa = async (req, res, next) => {
    try {
        const { challengeToken, code, recoveryCode } = req.body ?? {};
        if (!challengeToken) {
            return res.status(400).json({ success: false, message: 'challengeToken is required' });
        }

        let claims;
        try {
            claims = verifyMfaChallenge(challengeToken);
        } catch {
            return res.status(401).json({ success: false, code: 'CHALLENGE_EXPIRED', message: 'Sign in again' });
        }

        const admin = await store.get(TABLES.ADMIN_USERS, claims.sub);
        if (!admin || admin.status === 'disabled') {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        // Enrolment path: the code proves the authenticator holds the secret.
        if (admin.pendingTotpSecret) {
            const check = cryptoLib.verifyTotp(admin.pendingTotpSecret, code);
            if (!check.valid) {
                await audit.record({
                    actor: { adminId: admin.adminId, email: admin.email, role: admin.role },
                    action: audit.ACTIONS.MFA_FAILED,
                    reason: 'Enrolment code did not verify',
                    request: req,
                });
                return res.status(401).json({ success: false, message: 'That code is not valid' });
            }
            const recoveryCodes = cryptoLib.generateRecoveryCodes();
            await store.patch(TABLES.ADMIN_USERS, admin.adminId, {
                totpSecret: admin.pendingTotpSecret,
                pendingTotpSecret: null,
                status: 'active',
                mfaEnrolledAt: new Date().toISOString(),
                lastTotpCounter: check.counter,
                recoveryCodeHashes: recoveryCodes.map((c) => cryptoLib.hashIdentifier(c)),
            });
            await audit.record({
                actor: { adminId: admin.adminId, email: admin.email, role: admin.role },
                action: audit.ACTIONS.MFA_ENROLLED,
                reason: 'Authenticator bound on first sign-in',
                request: req,
            });

            const issued = await issueSession(admin, req);
            // Recovery codes are shown exactly once; only hashes are stored.
            return res.json({ ...issued, recoveryCodes });
        }

        // Normal path.
        let usedRecoveryCode = false;
        if (recoveryCode) {
            const hash = cryptoLib.hashIdentifier(recoveryCode);
            const remaining = (admin.recoveryCodeHashes ?? []).filter((h) => h !== hash);
            if (remaining.length === (admin.recoveryCodeHashes ?? []).length) {
                await audit.record({
                    actor: { adminId: admin.adminId, email: admin.email, role: admin.role },
                    action: audit.ACTIONS.MFA_FAILED,
                    reason: 'Invalid recovery code',
                    request: req,
                });
                return res.status(401).json({ success: false, message: 'That code is not valid' });
            }
            await store.patch(TABLES.ADMIN_USERS, admin.adminId, { recoveryCodeHashes: remaining });
            usedRecoveryCode = true;
            await audit.record({
                actor: { adminId: admin.adminId, email: admin.email, role: admin.role },
                action: audit.ACTIONS.RECOVERY_CODE_USED,
                reason: 'Signed in with a recovery code',
                metadata: { codesRemaining: remaining.length },
                request: req,
            });
        } else {
            const check = cryptoLib.verifyTotp(admin.totpSecret, code);
            if (!check.valid) {
                await audit.record({
                    actor: { adminId: admin.adminId, email: admin.email, role: admin.role },
                    action: audit.ACTIONS.MFA_FAILED,
                    reason: 'TOTP code did not verify',
                    request: req,
                });
                return res.status(401).json({ success: false, message: 'That code is not valid' });
            }
            // Reject replay of a step already used — a code shoulder-surfed
            // inside its 30-second window is otherwise reusable.
            if (admin.lastTotpCounter && check.counter <= admin.lastTotpCounter) {
                await audit.record({
                    actor: { adminId: admin.adminId, email: admin.email, role: admin.role },
                    action: audit.ACTIONS.MFA_FAILED,
                    reason: 'TOTP code replayed',
                    request: req,
                });
                return res.status(401).json({ success: false, message: 'That code has already been used' });
            }
            await store.patch(TABLES.ADMIN_USERS, admin.adminId, { lastTotpCounter: check.counter });
        }

        const issued = await issueSession(admin, req, { usedRecoveryCode });
        return res.json(issued);
    } catch (err) {
        return next(err);
    }
};

async function issueSession(admin, req, { usedRecoveryCode = false, bypassedMfa = false } = {}) {
    const session = await createSession({ adminId: admin.adminId, role: admin.role, request: req });
    const token = signSessionToken({
        adminId: admin.adminId,
        role: admin.role,
        sessionId: session.sessionId,
        expiresAt: Date.parse(session.absoluteExpiresAt),
    });

    await store.patch(TABLES.ADMIN_USERS, admin.adminId, { lastLoginAt: session.createdAt });
    await audit.record({
        actor: { adminId: admin.adminId, email: admin.email, role: admin.role, sessionId: session.sessionId },
        action: audit.ACTIONS.LOGIN_SUCCESS,
        // A demo sign-in must never read like a real one in the log.
        reason: bypassedMfa
            ? 'Signed in with password only — 2FA bypassed via ADMIN_DEMO_SKIP_MFA (demo configuration)'
            : usedRecoveryCode
                ? 'Signed in using a recovery code'
                : 'Signed in with password and TOTP',
        metadata: bypassedMfa ? { mfaBypassed: true, demoConfiguration: true } : null,
        request: req,
    });

    return {
        success: true,
        stage: 'authenticated',
        token,
        expiresAt: session.absoluteExpiresAt,
        idleTimeoutSeconds: Math.floor(SESSION.IDLE_TIMEOUT_MS / 1000),
        // The console renders a persistent banner while this is true, so nobody
        // demoing the tool can forget that 2FA is off.
        mfaBypassed: bypassedMfa,
        admin: { ...publicAdmin(admin), permissions: ROLE_PERMISSIONS[admin.role] ?? [] },
    };
}

exports.demoBypassActive = demoBypassActive;
exports.assertDemoBypassIsSafe = assertDemoBypassIsSafe;

// ─── Session endpoints ───────────────────────────────────────────────────────

exports.me = async (req, res) => {
    const admin = await store.get(TABLES.ADMIN_USERS, req.admin.adminId);
    return res.json({
        success: true,
        data: {
            ...publicAdmin(admin),
            permissions: req.admin.permissions,
            sessionExpiresAt: req.admin.sessionExpiresAt,
            idleDeadline: req.admin.idleDeadline,
        },
    });
};

exports.logout = async (req, res, next) => {
    try {
        await revokeSession(req.admin.sessionId, { by: req.admin.adminId, reason: 'signed out' });
        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.LOGOUT,
            reason: 'Signed out',
            request: req,
        });
        return res.json({ success: true });
    } catch (err) {
        return next(err);
    }
};

exports.changePassword = async (req, res, next) => {
    try {
        const { currentPassword, newPassword } = req.body ?? {};
        const admin = await store.get(TABLES.ADMIN_USERS, req.admin.adminId);
        if (!cryptoLib.verifyPassword(currentPassword ?? '', admin.passwordHash)) {
            return res.status(401).json({ success: false, message: 'Current password is incorrect' });
        }
        const errors = cryptoLib.validatePasswordStrength(newPassword);
        if (errors.length) {
            return res.status(400).json({ success: false, message: `Password ${errors.join(', ')}`, errors });
        }
        await store.patch(TABLES.ADMIN_USERS, admin.adminId, {
            passwordHash: cryptoLib.hashPassword(newPassword),
            passwordChangedAt: new Date().toISOString(),
        });
        // Every other session for this admin dies with the old password.
        const sessions = await store.list(TABLES.ADMIN_SESSIONS, {
            filter: (s) => s.adminId === admin.adminId && !s.revokedAt && s.sessionId !== req.admin.sessionId,
        });
        for (const s of sessions) await revokeSession(s.sessionId, { by: admin.adminId, reason: 'password changed' });

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.PASSWORD_CHANGED,
            reason: 'Password changed by the account holder',
            metadata: { otherSessionsRevoked: sessions.length },
            request: req,
        });
        return res.json({ success: true, otherSessionsRevoked: sessions.length });
    } catch (err) {
        return next(err);
    }
};

// ─── Admin account management (AR-06, Super Admin only) ──────────────────────

exports.listAdmins = async (_req, res, next) => {
    try {
        const admins = await store.list(TABLES.ADMIN_USERS);
        const sessions = await store.list(TABLES.ADMIN_SESSIONS, { filter: (s) => !s.revokedAt });
        const active = new Map();
        for (const s of sessions) active.set(s.adminId, (active.get(s.adminId) ?? 0) + 1);
        return res.json({
            success: true,
            data: admins
                .sort((a, b) => a.email.localeCompare(b.email))
                .map((a) => ({ ...publicAdmin(a), activeSessions: active.get(a.adminId) ?? 0 })),
        });
    } catch (err) {
        return next(err);
    }
};

/**
 * AR-06 — accounts are created by a Super Admin. There is no self-registration
 * route and no invite link that grants access on click: the temporary password
 * is handed over out of band and the account still cannot do anything until it
 * has bound an authenticator.
 */
exports.createAdmin = async (req, res, next) => {
    try {
        const { email, name, role, temporaryPassword } = req.body ?? {};
        if (!email || !name || !role) {
            return res.status(400).json({ success: false, message: 'email, name and role are required' });
        }
        if (!ROLE_LIST.includes(role)) {
            return res.status(400).json({ success: false, message: 'Unknown role', allowed: ROLE_LIST });
        }
        if (await findByEmail(email)) {
            return res.status(409).json({ success: false, message: 'An admin with that email already exists' });
        }
        const password = temporaryPassword || `${cryptoLib.randomId('Tmp')}!aA9`;
        const errors = cryptoLib.validatePasswordStrength(password);
        if (errors.length) {
            return res.status(400).json({ success: false, message: `Password ${errors.join(', ')}`, errors });
        }

        const admin = {
            adminId: cryptoLib.randomId('adm'),
            email: String(email).toLowerCase(),
            name,
            role,
            status: 'pending_enrolment',
            passwordHash: cryptoLib.hashPassword(password),
            totpSecret: null,
            createdAt: new Date().toISOString(),
            createdBy: req.admin.adminId,
            failedLogins: 0,
        };
        await store.put(TABLES.ADMIN_USERS, admin);

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.ADMIN_CREATED,
            targetType: 'admin',
            targetId: admin.adminId,
            reason: req.body.reason ?? 'New admin account provisioned',
            after: { email: admin.email, role: admin.role },
            request: req,
        });

        return res.status(201).json({
            success: true,
            data: publicAdmin(admin),
            // Returned once, to be delivered out of band. Never stored in plaintext.
            temporaryPassword: temporaryPassword ? undefined : password,
        });
    } catch (err) {
        return next(err);
    }
};

exports.updateAdminRole = async (req, res, next) => {
    try {
        const { adminId } = req.params;
        const { role, reason } = req.body ?? {};
        if (!ROLE_LIST.includes(role)) {
            return res.status(400).json({ success: false, message: 'Unknown role', allowed: ROLE_LIST });
        }
        const target = await store.get(TABLES.ADMIN_USERS, adminId);
        if (!target) return res.status(404).json({ success: false, message: 'Admin not found' });

        // §12 / open question #1: a Super Admin demoting the last Super Admin
        // locks everyone out of account management permanently.
        if (target.role === ROLES.SUPER_ADMIN && role !== ROLES.SUPER_ADMIN) {
            const supers = await store.list(TABLES.ADMIN_USERS, {
                filter: (a) => a.role === ROLES.SUPER_ADMIN && a.status !== 'disabled',
            });
            if (supers.length <= 1) {
                return res.status(409).json({
                    success: false,
                    code: 'LAST_SUPER_ADMIN',
                    message: 'Cannot demote the last active Super Admin — promote another one first',
                });
            }
        }

        const updated = await store.patch(TABLES.ADMIN_USERS, adminId, { role });
        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.ADMIN_ROLE_CHANGED,
            targetType: 'admin',
            targetId: adminId,
            reason: reason ?? 'Role changed',
            before: { role: target.role },
            after: { role },
            request: req,
        });
        return res.json({ success: true, data: publicAdmin(updated) });
    } catch (err) {
        return next(err);
    }
};

exports.setAdminStatus = async (req, res, next) => {
    try {
        const { adminId } = req.params;
        const { status, reason } = req.body ?? {};
        if (!['active', 'disabled'].includes(status)) {
            return res.status(400).json({ success: false, message: "status must be 'active' or 'disabled'" });
        }
        const target = await store.get(TABLES.ADMIN_USERS, adminId);
        if (!target) return res.status(404).json({ success: false, message: 'Admin not found' });

        if (status === 'disabled' && target.role === ROLES.SUPER_ADMIN) {
            const supers = await store.list(TABLES.ADMIN_USERS, {
                filter: (a) => a.role === ROLES.SUPER_ADMIN && a.status !== 'disabled',
            });
            if (supers.length <= 1) {
                return res.status(409).json({
                    success: false,
                    code: 'LAST_SUPER_ADMIN',
                    message: 'Cannot disable the last active Super Admin',
                });
            }
        }

        const updated = await store.patch(TABLES.ADMIN_USERS, adminId, { status });
        let revoked = 0;
        if (status === 'disabled') {
            revoked = await revokeAllSessionsForAdmin(adminId, { by: req.admin.adminId, reason: 'account disabled' });
        }
        await audit.record({
            actor: req.admin,
            action: status === 'disabled' ? audit.ACTIONS.ADMIN_DISABLED : audit.ACTIONS.ADMIN_ENABLED,
            targetType: 'admin',
            targetId: adminId,
            reason: reason ?? `Account ${status}`,
            before: { status: target.status },
            after: { status },
            metadata: { sessionsRevoked: revoked },
            request: req,
        });
        return res.json({ success: true, data: publicAdmin(updated), sessionsRevoked: revoked });
    } catch (err) {
        return next(err);
    }
};

/** PRD §12 — admin account compromised: revoke every session immediately. */
exports.revokeAdminSessions = async (req, res, next) => {
    try {
        const { adminId } = req.params;
        const { reason } = req.body ?? {};
        if (!reason) return res.status(400).json({ success: false, message: 'A reason is required' });
        const count = await revokeAllSessionsForAdmin(adminId, { by: req.admin.adminId, reason });
        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.SESSION_REVOKED,
            targetType: 'admin',
            targetId: adminId,
            reason,
            metadata: { sessionsRevoked: count },
            request: req,
        });
        return res.json({ success: true, sessionsRevoked: count });
    } catch (err) {
        return next(err);
    }
};

/**
 * PRD §12 — Super Admin loses their 2FA device. Recovery requires a *second*
 * Super Admin: this route is Super-Admin-only and refuses to act on the caller's
 * own account, which is what makes "a second Super Admin" structural rather than
 * a procedure someone has to remember.
 */
exports.resetAdminMfa = async (req, res, next) => {
    try {
        const { adminId } = req.params;
        const { reason } = req.body ?? {};
        if (!reason) return res.status(400).json({ success: false, message: 'A reason is required' });
        if (adminId === req.admin.adminId) {
            return res.status(403).json({
                success: false,
                code: 'SELF_MFA_RESET',
                message: 'A Super Admin cannot reset their own 2FA — a second Super Admin must do it (PRD §12)',
            });
        }
        const target = await store.get(TABLES.ADMIN_USERS, adminId);
        if (!target) return res.status(404).json({ success: false, message: 'Admin not found' });

        await store.patch(TABLES.ADMIN_USERS, adminId, {
            totpSecret: null,
            pendingTotpSecret: null,
            recoveryCodeHashes: [],
            lastTotpCounter: null,
            status: 'pending_enrolment',
        });
        const revoked = await revokeAllSessionsForAdmin(adminId, { by: req.admin.adminId, reason: '2FA reset' });

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.ADMIN_MFA_RESET,
            targetType: 'admin',
            targetId: adminId,
            reason,
            metadata: { sessionsRevoked: revoked },
            request: req,
        });
        return res.json({ success: true, message: 'Authenticator cleared — the admin must re-enrol on next sign-in' });
    } catch (err) {
        return next(err);
    }
};

exports.listSessions = async (req, res, next) => {
    try {
        const { adminId } = req.query;
        const sessions = await store.list(TABLES.ADMIN_SESSIONS, {
            filter: (s) => (adminId ? s.adminId === adminId : true),
        });
        const admins = await store.list(TABLES.ADMIN_USERS);
        const byId = new Map(admins.map((a) => [a.adminId, a]));
        return res.json({
            success: true,
            data: sessions
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .map((s) => ({
                    ...s,
                    adminEmail: byId.get(s.adminId)?.email ?? null,
                    adminName: byId.get(s.adminId)?.name ?? null,
                    active: !s.revokedAt && Date.parse(s.absoluteExpiresAt) > Date.now(),
                })),
        });
    } catch (err) {
        return next(err);
    }
};
