/**
 * Rate limiting (AR-08) and IP allowlisting (AR-07).
 *
 * AR-08 requires admin endpoints be limited independently of consumer endpoints,
 * so this keeps its own buckets and never shares state with anything under
 * /auth, /user, /bookings.
 *
 * In-process sliding window. Single-instance correct; behind more than one
 * instance the effective limit multiplies by the instance count. That is
 * acceptable for the login limiter (which also has account lockout behind it)
 * but should move to Redis or DynamoDB before the admin surface is scaled out —
 * noted in docs/SECURITY.md rather than pretended away here.
 */

const audit = require('../lib/audit');

const buckets = new Map();

function sweep(now) {
    for (const [key, entry] of buckets) {
        if (entry.resetAt < now) buckets.delete(key);
    }
}

let lastSweep = 0;

function limiter({ windowMs, max, keyFn, code = 'RATE_LIMITED', message }) {
    return (req, res, next) => {
        const now = Date.now();
        if (now - lastSweep > 60_000) {
            sweep(now);
            lastSweep = now;
        }

        const key = `${code}:${keyFn(req)}`;
        let entry = buckets.get(key);
        if (!entry || entry.resetAt < now) {
            entry = { count: 0, resetAt: now + windowMs };
            buckets.set(key, entry);
        }
        entry.count += 1;

        const remaining = Math.max(0, max - entry.count);
        res.setHeader('X-RateLimit-Limit', String(max));
        res.setHeader('X-RateLimit-Remaining', String(remaining));
        res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

        if (entry.count > max) {
            const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
            res.setHeader('Retry-After', String(retryAfter));
            return res.status(429).json({
                success: false,
                code,
                message: message ?? 'Too many requests — slow down',
                retryAfterSeconds: retryAfter,
            });
        }

        return next();
    };
}

const ipKey = (req) => audit.clientIp(req) ?? 'unknown';

/** Login is the brute-force target; keep it tight and keyed on IP + account. */
const loginLimiter = limiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyFn: (req) => `${ipKey(req)}|${String(req.body?.email ?? '').toLowerCase()}`,
    code: 'LOGIN_RATE_LIMITED',
    message: 'Too many sign-in attempts. Try again later.',
});

/** TOTP is 6 digits — a million combinations is not many if you can guess fast. */
const mfaLimiter = limiter({
    windowMs: 5 * 60 * 1000,
    max: 5,
    keyFn: (req) => `${ipKey(req)}|${String(req.body?.challengeToken ?? '').slice(-24)}`,
    code: 'MFA_RATE_LIMITED',
    message: 'Too many verification attempts.',
});

/** General authenticated traffic, keyed on the admin rather than the IP. */
const apiLimiter = limiter({
    windowMs: 60 * 1000,
    max: 300,
    keyFn: (req) => req.admin?.adminId ?? ipKey(req),
    code: 'API_RATE_LIMITED',
});

/** Unmask and document views are cheap to request and expensive to leak. */
const sensitiveLimiter = limiter({
    windowMs: 60 * 1000,
    max: 20,
    keyFn: (req) => req.admin?.adminId ?? ipKey(req),
    code: 'SENSITIVE_RATE_LIMITED',
    message: 'Too many sensitive-data requests in a short window.',
});

/** Exports pull whole date ranges out of the system; one at a time is plenty. */
const exportLimiter = limiter({
    windowMs: 60 * 60 * 1000,
    max: 20,
    keyFn: (req) => req.admin?.adminId ?? ipKey(req),
    code: 'EXPORT_RATE_LIMITED',
});

// ─── AR-07 — IP allowlist, configurable, off by default ──────────────────────

function parseAllowlist() {
    const raw = process.env.ADMIN_IP_ALLOWLIST;
    if (!raw || !raw.trim()) return null;
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function ipMatches(ip, rule) {
    if (rule === ip) return true;
    if (rule.endsWith('*')) return ip.startsWith(rule.slice(0, -1));
    if (rule.includes('/')) {
        // Minimal IPv4 CIDR. IPv6 ranges are not supported; use exact matches.
        const [range, bitsRaw] = rule.split('/');
        const bits = Number(bitsRaw);
        const toInt = (a) => a.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !/^\d+\.\d+\.\d+\.\d+$/.test(range)) return false;
        const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
        return (toInt(ip) & mask) === (toInt(range) & mask);
    }
    return false;
}

function ipAllowlist(req, res, next) {
    const allow = parseAllowlist();
    if (!allow) return next(); // off by default, per AR-07
    const ip = ipKey(req);
    if (allow.some((rule) => ipMatches(ip, rule))) return next();

    audit.record({
        actor: null,
        action: audit.ACTIONS.LOGIN_FAILED,
        reason: 'Request from an IP outside the admin allowlist',
        metadata: { ip },
        request: req,
    }).catch(() => {});

    return res.status(403).json({
        success: false,
        code: 'IP_NOT_ALLOWED',
        message: 'Access to the admin surface is not permitted from this network',
    });
}

module.exports = {
    loginLimiter, mfaLimiter, apiLimiter, sensitiveLimiter, exportLimiter,
    ipAllowlist, limiter,
};
