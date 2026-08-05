/**
 * Crypto helpers — password hashing, TOTP, hashing for duplicate detection.
 *
 * Deliberately zero new npm dependencies: everything here is node:crypto. The
 * admin surface is the highest-value target Hive operates (PRD §1), and every
 * dependency added to it is supply-chain surface on the box that holds the KYC
 * documents. scrypt and HMAC-SHA1/256 are in the standard library; TOTP is
 * forty lines of RFC 6238.
 */

const crypto = require('crypto');

// ─── Passwords (scrypt) ──────────────────────────────────────────────────────

const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LEN = 64;

function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const derived = crypto.scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
    return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

function verifyPassword(password, stored) {
    try {
        const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$');
        if (scheme !== 'scrypt') return false;
        const salt = Buffer.from(saltB64, 'base64');
        const expected = Buffer.from(hashB64, 'base64');
        const derived = crypto.scryptSync(password, salt, expected.length, {
            N: Number(N), r: Number(r), p: Number(p),
        });
        return crypto.timingSafeEqual(derived, expected);
    } catch {
        return false;
    }
}

/** Password policy for admin accounts — these are not consumer passwords. */
function validatePasswordStrength(password) {
    const errors = [];
    if (typeof password !== 'string' || password.length < 14) {
        errors.push('must be at least 14 characters');
    }
    if (!/[a-z]/.test(password || '')) errors.push('must contain a lowercase letter');
    if (!/[A-Z]/.test(password || '')) errors.push('must contain an uppercase letter');
    if (!/[0-9]/.test(password || '')) errors.push('must contain a digit');
    if (!/[^A-Za-z0-9]/.test(password || '')) errors.push('must contain a symbol');
    return errors;
}

// ─── Base32 (RFC 4648, no padding) — for TOTP secrets ────────────────────────

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
    return out;
}

function base32Decode(str) {
    const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
    let bits = 0;
    let value = 0;
    const out = [];
    for (const ch of clean) {
        const idx = B32_ALPHABET.indexOf(ch);
        if (idx === -1) throw new Error('Invalid base32 character');
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

// ─── TOTP (RFC 6238, SHA-1, 6 digits, 30s step) ──────────────────────────────

const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;

function generateTotpSecret() {
    return base32Encode(crypto.randomBytes(20)); // 160-bit, per RFC 4226 §4
}

function totpCodeAt(secretB32, counter) {
    const key = base32Decode(secretB32);
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', key).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const binary =
        ((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff);
    return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * Verify a TOTP code. `window` of 1 tolerates one step of clock drift either
 * way — the usual compromise. Returns the matched counter so the caller can
 * reject replay of an already-used step (AR-05: no bypass includes no reuse).
 */
function verifyTotp(secretB32, code, { window = 1, now = Date.now() } = {}) {
    const clean = String(code || '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(clean)) return { valid: false };
    const counter = Math.floor(now / 1000 / TOTP_STEP_SECONDS);
    for (let drift = -window; drift <= window; drift++) {
        const candidate = totpCodeAt(secretB32, counter + drift);
        if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(clean))) {
            return { valid: true, counter: counter + drift };
        }
    }
    return { valid: false };
}

function totpProvisioningUri(secretB32, accountName, issuer = 'Hive Admin') {
    const label = encodeURIComponent(`${issuer}:${accountName}`);
    const params = new URLSearchParams({
        secret: secretB32,
        issuer,
        algorithm: 'SHA1',
        digits: String(TOTP_DIGITS),
        period: String(TOTP_STEP_SECONDS),
    });
    return `otpauth://totp/${label}?${params.toString()}`;
}

// ─── Recovery codes (break-glass, PRD §12 / open question #1) ────────────────

function generateRecoveryCodes(count = 10) {
    return Array.from({ length: count }, () =>
        crypto.randomBytes(5).toString('hex').replace(/(.{4})/g, '$1-').replace(/-$/, '').toUpperCase()
    );
}

// ─── Hashing for detection controls ──────────────────────────────────────────

const HASH_PEPPER = process.env.ADMIN_HASH_PEPPER || 'hive-admin-dev-pepper';

/** K-04 — duplicate KYC detection matches on the hashed ID number, never the raw one. */
function hashIdentifier(value) {
    return crypto
        .createHmac('sha256', HASH_PEPPER)
        .update(String(value).toUpperCase().replace(/[\s-]/g, ''))
        .digest('hex');
}

/** F-07 — payout-mule detection: hash(account_number + IFSC) and flag collisions. */
function hashBankAccount(accountNumber, ifsc) {
    return hashIdentifier(`${accountNumber}|${ifsc}`);
}

// ─── Misc ────────────────────────────────────────────────────────────────────

function randomId(prefix) {
    return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}

function constantTimeEquals(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = {
    hashPassword, verifyPassword, validatePasswordStrength,
    base32Encode, base32Decode,
    generateTotpSecret, verifyTotp, totpProvisioningUri, totpCodeAt,
    generateRecoveryCodes,
    hashIdentifier, hashBankAccount,
    randomId, constantTimeEquals,
};
