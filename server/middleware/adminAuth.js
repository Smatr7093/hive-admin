/**
 * Admin authentication (PRD §3).
 *
 * AR-02  /admin has completely separate auth: different secret, different
 *        issuer, different token lifetime.
 * AR-03  An admin token must not be mintable by the consumer auth flow — the
 *        single most important requirement in the PRD.
 * AR-04  Session lifetime max 8h, idle timeout 30 min.
 * AR-05  TOTP 2FA mandatory, no bypass.
 *
 * How AR-03 is enforced, in layers — any one of these alone would be enough to
 * stop the obvious attack, and the point of having all four is that the
 * dangerous version of this bug is the one where a single check was refactored
 * away:
 *
 *   1. Different signing secret. ADMIN_JWT_SECRET must be set and must not equal
 *      JWT_SECRET; the process refuses to start otherwise (assertSecretsAreSeparate).
 *   2. Different issuer and audience claims, both verified.
 *   3. A `typ: 'admin'` claim, verified. Consumer tokens carry `{ userId }` only.
 *   4. A server-side session record that only the admin login flow creates. A
 *      forged-but-perfectly-signed token still fails because no session exists.
 *
 * The consumer flow (authController.generateToken) signs `{ userId }` with
 * JWT_SECRET and no issuer, audience or typ. It cannot produce a token that
 * survives step 1, and could not survive steps 2–4 even if the secrets leaked
 * into each other.
 */

const jwt = require('jsonwebtoken');
const { store, TABLES } = require('../lib/store');
const { SESSION, ROLE_PERMISSIONS } = require('../config/constants');
const audit = require('../lib/audit');

const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET;

/**
 * Called once at mount time. Refusing to boot is the correct response to a
 * misconfiguration here: a dashboard running with a guessable or shared admin
 * secret is worse than a dashboard that is down.
 */
function assertSecretsAreSeparate() {
    const consumerSecret = process.env.JWT_SECRET || 'hive_secret_key_change_in_prod';

    if (!ADMIN_JWT_SECRET) {
        throw new Error(
            'ADMIN_JWT_SECRET is not set. The admin surface refuses to start without its own signing key (AR-02).'
        );
    }
    if (ADMIN_JWT_SECRET === consumerSecret) {
        throw new Error(
            'ADMIN_JWT_SECRET must not equal JWT_SECRET. Sharing the secret would make every consumer token a potential admin token (AR-03).'
        );
    }
    if (ADMIN_JWT_SECRET.length < 32) {
        throw new Error('ADMIN_JWT_SECRET must be at least 32 characters.');
    }
    if (/change_in_prod|changeme|secret|password/i.test(ADMIN_JWT_SECRET)) {
        throw new Error('ADMIN_JWT_SECRET looks like a placeholder. Generate one: openssl rand -base64 48');
    }
}

// ─── Token minting ───────────────────────────────────────────────────────────

/**
 * Only called by the admin login controller, only after a TOTP challenge has
 * been satisfied, and only with a session already written to the store.
 */
function signSessionToken({ adminId, role, sessionId, expiresAt }) {
    const ttlSeconds = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
    return jwt.sign(
        { sub: adminId, role, sid: sessionId, typ: SESSION.TOKEN_TYPE },
        ADMIN_JWT_SECRET,
        {
            issuer: SESSION.ISSUER,
            audience: SESSION.AUDIENCE,
            expiresIn: ttlSeconds,
            algorithm: 'HS256',
        }
    );
}

/**
 * A short-lived token that proves "password accepted, TOTP still outstanding".
 * It carries typ 'mfa_challenge', so it cannot be used as a session token by the
 * middleware below even though it is signed with the same key.
 */
function signMfaChallenge(adminId) {
    return jwt.sign(
        { sub: adminId, typ: 'mfa_challenge' },
        ADMIN_JWT_SECRET,
        {
            issuer: SESSION.ISSUER,
            audience: SESSION.AUDIENCE,
            expiresIn: Math.floor(SESSION.MFA_CHALLENGE_TTL_MS / 1000),
            algorithm: 'HS256',
        }
    );
}

function verifyMfaChallenge(token) {
    const decoded = jwt.verify(token, ADMIN_JWT_SECRET, {
        issuer: SESSION.ISSUER,
        audience: SESSION.AUDIENCE,
        algorithms: ['HS256'],
    });
    if (decoded.typ !== 'mfa_challenge') {
        throw new Error('Not an MFA challenge token');
    }
    return decoded;
}

// ─── Session lifecycle ───────────────────────────────────────────────────────

async function createSession({ adminId, role, request }) {
    const now = Date.now();
    const session = {
        sessionId: require('../lib/crypto').randomId('sess'),
        adminId,
        role,
        createdAt: new Date(now).toISOString(),
        lastSeenAt: new Date(now).toISOString(),
        absoluteExpiresAt: new Date(now + SESSION.MAX_LIFETIME_MS).toISOString(), // AR-04
        revokedAt: null,
        revokedBy: null,
        ip: audit.clientIp(request),
        userAgent: request?.headers?.['user-agent'] ?? null,
    };
    await store.put(TABLES.ADMIN_SESSIONS, session);
    return session;
}

async function revokeSession(sessionId, { by = null, reason = null } = {}) {
    return store.patch(TABLES.ADMIN_SESSIONS, sessionId, {
        revokedAt: new Date().toISOString(),
        revokedBy: by,
        revokeReason: reason,
    });
}

/** PRD §12 — Super Admin can revoke every session for a compromised admin. */
async function revokeAllSessionsForAdmin(adminId, { by = null, reason = null } = {}) {
    const sessions = await store.list(TABLES.ADMIN_SESSIONS, {
        filter: (s) => s.adminId === adminId && !s.revokedAt,
    });
    for (const s of sessions) {
        await revokeSession(s.sessionId, { by, reason });
    }
    return sessions.length;
}

// ─── The guard ───────────────────────────────────────────────────────────────

function unauthorized(res, code, message) {
    return res.status(401).json({ success: false, code, message });
}

/**
 * Express middleware. Populates req.admin with
 * { adminId, email, name, role, permissions, sessionId }.
 */
async function requireAdmin(req, res, next) {
    try {
        const header = req.headers.authorization;
        const token = header && header.startsWith('Bearer ') ? header.slice(7) : null;
        if (!token) return unauthorized(res, 'NO_TOKEN', 'Admin access token required');

        let decoded;
        try {
            decoded = jwt.verify(token, ADMIN_JWT_SECRET, {
                issuer: SESSION.ISSUER,      // AR-03 layer 2
                audience: SESSION.AUDIENCE,  // AR-03 layer 2
                algorithms: ['HS256'],       // never trust the header's alg
            });
        } catch (err) {
            return unauthorized(res, 'INVALID_TOKEN', 'Invalid or expired admin token');
        }

        // AR-03 layer 3 — a consumer token has no typ claim and dies here even if
        // it somehow survived signature verification.
        if (decoded.typ !== SESSION.TOKEN_TYPE) {
            await audit.record({
                actor: null,
                action: audit.ACTIONS.LOGIN_FAILED,
                reason: 'Token presented to /admin was not an admin session token',
                metadata: { typ: decoded.typ ?? null, sub: decoded.sub ?? decoded.userId ?? null },
                request: req,
            });
            return unauthorized(res, 'WRONG_TOKEN_TYPE', 'This token is not valid for the admin surface');
        }

        // AR-03 layer 4 — the session must exist, and only the admin login flow
        // writes sessions.
        const session = await store.get(TABLES.ADMIN_SESSIONS, decoded.sid);
        if (!session) return unauthorized(res, 'NO_SESSION', 'Session not found');
        if (session.revokedAt) return unauthorized(res, 'SESSION_REVOKED', 'Session has been revoked');

        const now = Date.now();

        if (now > Date.parse(session.absoluteExpiresAt)) {
            await revokeSession(session.sessionId, { reason: 'absolute_lifetime_reached' });
            await audit.record({
                actor: { adminId: session.adminId, role: session.role, sessionId: session.sessionId },
                action: audit.ACTIONS.SESSION_EXPIRED,
                reason: 'Absolute 8-hour session lifetime reached',
                request: req,
            });
            return unauthorized(res, 'SESSION_EXPIRED', 'Session expired — sign in again');
        }

        if (now - Date.parse(session.lastSeenAt) > SESSION.IDLE_TIMEOUT_MS) {
            await revokeSession(session.sessionId, { reason: 'idle_timeout' });
            await audit.record({
                actor: { adminId: session.adminId, role: session.role, sessionId: session.sessionId },
                action: audit.ACTIONS.SESSION_EXPIRED,
                reason: 'Idle for more than 30 minutes',
                request: req,
            });
            return unauthorized(res, 'SESSION_IDLE', 'Session timed out after 30 minutes idle');
        }

        const admin = await store.get(TABLES.ADMIN_USERS, session.adminId);
        if (!admin || admin.status !== 'active') {
            await revokeSession(session.sessionId, { reason: 'account_inactive' });
            return unauthorized(res, 'ACCOUNT_INACTIVE', 'Admin account is not active');
        }

        // The role comes from the account record, not the token. A role change
        // takes effect on the next request rather than on the next login.
        const role = admin.role;

        await store.patch(TABLES.ADMIN_SESSIONS, session.sessionId, {
            lastSeenAt: new Date(now).toISOString(),
            role,
        });

        req.admin = {
            adminId: admin.adminId,
            email: admin.email,
            name: admin.name,
            role,
            permissions: ROLE_PERMISSIONS[role] ?? [],
            sessionId: session.sessionId,
            sessionExpiresAt: session.absoluteExpiresAt,
            idleDeadline: new Date(now + SESSION.IDLE_TIMEOUT_MS).toISOString(),
        };

        return next();
    } catch (err) {
        return next(err);
    }
}

module.exports = {
    assertSecretsAreSeparate,
    signSessionToken, signMfaChallenge, verifyMfaChallenge,
    createSession, revokeSession, revokeAllSessionsForAdmin,
    requireAdmin,
};
