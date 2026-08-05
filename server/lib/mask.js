/**
 * PII masking (PRD §4).
 *
 * P-01 masks bank account numbers, PAN and KYC documents by default for Support.
 * P-02 an unmask needs a reason from a fixed list and is logged.
 * P-03 grants are per-record and per-session — there is deliberately no global
 *      "show everything" toggle anywhere in this file or its callers.
 *
 * The important property: masking happens on the way *out of the server*, not in
 * the browser. A masked field is never sent over the wire, so "inspect the
 * network tab" is not an unmask.
 */

const { store, TABLES } = require('./store');
const { PERM, SESSION } = require('../config/constants');
const { randomId } = require('./crypto');

// ─── Maskers ─────────────────────────────────────────────────────────────────

const maskers = {
    accountNumber: (v) => (v ? `••••••${String(v).slice(-4)}` : null),
    pan: (v) => (v ? `${String(v).slice(0, 3)}•••••${String(v).slice(-1)}` : null),
    phone: (v) => {
        if (!v) return null;
        const s = String(v);
        return `${s.slice(0, s.startsWith('+') ? 3 : 2)}••••••${s.slice(-3)}`;
    },
    email: (v) => {
        if (!v) return null;
        const [local, domain] = String(v).split('@');
        if (!domain) return '•••';
        return `${local.slice(0, 2)}•••@${domain}`;
    },
    idNumber: (v) => (v ? `••••••••${String(v).slice(-4)}` : null),
    address: () => '•••••• (address hidden)',
    ifsc: (v) => (v ? `${String(v).slice(0, 4)}••••••` : null),
    documentUrl: () => null,
    default: () => '••••••',
};

/**
 * Which fields are sensitive, and how each one masks. Keyed by the field name as
 * it appears on the wire, so a new sensitive field is one line here rather than
 * a grep through every controller.
 */
const SENSITIVE_FIELDS = {
    accountNumber: 'accountNumber',
    bankAccountNumber: 'accountNumber',
    ifscCode: 'ifsc',
    pan: 'pan',
    panNumber: 'pan',
    idNumber: 'idNumber',
    documentIdNumber: 'idNumber',
    phone: 'phone',
    email: 'email',
    address: 'address',
    residentialAddress: 'address',
    kycDocumentUrl: 'documentUrl',
    kycSelfieUrl: 'documentUrl',
    upiId: 'default',
};

// ─── Grants (P-03) ───────────────────────────────────────────────────────────

/**
 * Create a per-record, per-session unmask grant.
 *
 * Scoped to (sessionId, recordType, recordId, fields) and expires. When the
 * session ends the grant is dead regardless of its own TTL, because lookup joins
 * on sessionId.
 */
async function createGrant({ actor, recordType, recordId, fields, reasonCode, reasonLabel }) {
    const now = Date.now();
    const grant = {
        grantId: randomId('grn'),
        adminId: actor.adminId,
        sessionId: actor.sessionId,
        recordType,
        recordId,
        fields,
        reasonCode,
        reasonLabel,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + SESSION.UNMASK_GRANT_TTL_MS).toISOString(),
    };
    await store.put(TABLES.UNMASK_GRANTS, grant);
    return grant;
}

async function activeGrantsFor(actor, recordType, recordId) {
    if (!actor?.sessionId) return [];
    const now = Date.now();
    return store.list(TABLES.UNMASK_GRANTS, {
        filter: (g) =>
            g.sessionId === actor.sessionId &&
            g.recordType === recordType &&
            g.recordId === recordId &&
            Date.parse(g.expiresAt) > now,
    });
}

/** P-06 — repeated unmasks by one admin surface on the Super Admin dashboard. */
async function unmaskVolumeByAdmin({ sinceMs = 24 * 60 * 60 * 1000 } = {}) {
    const cutoff = Date.now() - sinceMs;
    const grants = await store.list(TABLES.UNMASK_GRANTS, {
        filter: (g) => Date.parse(g.createdAt) > cutoff,
    });
    const byAdmin = new Map();
    for (const g of grants) {
        const entry = byAdmin.get(g.adminId) ?? { adminId: g.adminId, count: 0, reasons: {} };
        entry.count += 1;
        entry.reasons[g.reasonCode] = (entry.reasons[g.reasonCode] ?? 0) + 1;
        byAdmin.set(g.adminId, entry);
    }
    return [...byAdmin.values()].sort((a, b) => b.count - a.count);
}

// ─── Application ─────────────────────────────────────────────────────────────

/**
 * Mask an object for a given actor.
 *
 * Returns a shallow copy with sensitive values replaced and a `_masked` array
 * naming the fields that were hidden — the console renders an Unmask control for
 * exactly those, so the UI never has to guess what it is allowed to ask for.
 */
async function maskFor(actor, obj, { recordType, recordId } = {}) {
    if (obj == null) return obj;
    if (Array.isArray(obj)) {
        return Promise.all(obj.map((o) => maskFor(actor, o, {
            recordType,
            recordId: recordId ?? o?.[`${recordType}Id`],
        })));
    }

    const present = Object.keys(obj).filter((k) => k in SENSITIVE_FIELDS && obj[k] != null);
    if (present.length === 0) return obj;

    // Roles with PII_VIEW_UNMASKED (Ops, Finance, Super Admin) see the real
    // values. Support does not — P-01.
    const seesEverything = actor?.permissions?.includes(PERM.PII_VIEW_UNMASKED);
    if (seesEverything) return { ...obj, _masked: [], _unmaskable: present };

    const id = recordId ?? obj[`${recordType}Id`] ?? obj.userId ?? obj.id;
    const grants = recordType && id ? await activeGrantsFor(actor, recordType, id) : [];
    const granted = new Set(grants.flatMap((g) => g.fields));

    const out = { ...obj };
    const masked = [];
    for (const field of present) {
        if (granted.has(field) || granted.has('*')) continue;
        out[field] = maskers[SENSITIVE_FIELDS[field]](obj[field]);
        masked.push(field);
    }
    out._masked = masked;
    out._unmaskable = present;
    return out;
}

/** True when the actor may see this field on this record without a fresh grant. */
async function canSeeUnmasked(actor, field, { recordType, recordId }) {
    if (actor?.permissions?.includes(PERM.PII_VIEW_UNMASKED)) return true;
    const grants = await activeGrantsFor(actor, recordType, recordId);
    return grants.some((g) => g.fields.includes(field) || g.fields.includes('*'));
}

/**
 * P-04 — document previews are watermarked with the viewing admin's ID and
 * timestamp. The server issues a short-lived, single-admin view token; the
 * document route stamps the overlay server-side so the watermark cannot be
 * removed by turning off CSS.
 */
function watermarkText(actor) {
    return `${actor.email} · ${actor.adminId} · ${new Date().toISOString()}`;
}

module.exports = {
    maskFor, createGrant, activeGrantsFor, canSeeUnmasked,
    unmaskVolumeByAdmin, watermarkText,
    SENSITIVE_FIELDS, maskers,
};
