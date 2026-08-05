/**
 * Admin API client.
 *
 * The session token lives in a module-level variable, never in localStorage or a
 * cookie. That is deliberate: an admin token grants access to every KYC document
 * Hive holds, and localStorage survives tab close, is readable by any script
 * that gets injected, and outlives the 30-minute idle timeout the server
 * enforces. In-memory means closing the tab ends the session, which is the
 * behaviour you want on a shared or stolen laptop.
 *
 * The cost is a re-login on refresh. For a tool used in eight-hour shifts by a
 * handful of people, that is the right trade.
 */

const BASE = process.env.NEXT_PUBLIC_ADMIN_API ?? 'http://localhost:4000';

let token: string | null = null;
let onUnauthorized: ((code: string, message: string) => void) | null = null;

export function setToken(value: string | null) {
    token = value;
}

export function hasToken() {
    return token !== null;
}

export function setUnauthorizedHandler(handler: (code: string, message: string) => void) {
    onUnauthorized = handler;
}

export class ApiError extends Error {
    status: number;
    code: string;
    payload: Record<string, unknown>;

    constructor(status: number, code: string, message: string, payload: Record<string, unknown> = {}) {
        super(message);
        this.status = status;
        this.code = code;
        this.payload = payload;
    }
}

type Options = {
    method?: string;
    body?: unknown;
    raw?: boolean;
};

export async function api<T = any>(path: string, options: Options = {}): Promise<T> {
    const { method = 'GET', body, raw = false } = options;

    const res = await fetch(`${BASE}/admin${path}`, {
        method,
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        // No cookies, so no CSRF surface. The Authorization header is the only
        // credential and it cannot be attached by a cross-site form post.
        credentials: 'omit',
    });

    if (raw) {
        if (!res.ok) throw new ApiError(res.status, 'RAW_ERROR', await res.text());
        return (await res.text()) as unknown as T;
    }

    let json: any = null;
    try {
        json = await res.json();
    } catch {
        json = {};
    }

    if (res.status === 401) {
        // Session expired, idled out, or revoked by a Super Admin. The shell
        // shows why rather than silently bouncing to the login form — "you were
        // signed out" without a reason reads as a bug.
        token = null;
        onUnauthorized?.(json?.code ?? 'UNAUTHORIZED', json?.message ?? 'Your session has ended');
        throw new ApiError(401, json?.code ?? 'UNAUTHORIZED', json?.message ?? 'Session ended', json);
    }

    if (!res.ok) {
        throw new ApiError(res.status, json?.code ?? 'ERROR', json?.message ?? `Request failed (${res.status})`, json);
    }

    return json as T;
}

/** Document previews come back as SVG, not JSON. */
export function documentUrl(submissionId: string, kind: 'gov-id' | 'selfie') {
    return `${BASE}/admin/kyc/${submissionId}/document/${kind}`;
}

export async function fetchDocument(submissionId: string, kind: 'gov-id' | 'selfie'): Promise<string> {
    const res = await fetch(documentUrl(submissionId, kind), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: 'omit',
    });
    if (!res.ok) throw new ApiError(res.status, 'DOCUMENT_ERROR', 'Could not load the document');
    return res.text();
}

/**
 * P-05 — the original bytes, for the roles allowed to have them. A plain anchor
 * cannot carry the Authorization header, so the fetch happens here and the file
 * is handed to the browser as a blob. The server logs the download as its own
 * audit event before it responds.
 */
export async function downloadDocument(submissionId: string, kind: 'gov-id' | 'selfie', reason: string) {
    const res = await fetch(`${documentUrl(submissionId, kind)}?download=1&reason=${encodeURIComponent(reason)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: 'omit',
    });
    if (!res.ok) {
        let message = 'Download refused';
        try { message = (await res.json())?.message ?? message; } catch { /* non-JSON */ }
        throw new ApiError(res.status, 'DOWNLOAD_REFUSED', message);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${submissionId}-${kind}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
}

// ─── Auth ────────────────────────────────────────────────────────────────────

export type Admin = {
    adminId: string;
    email: string;
    name: string;
    role: string;
    permissions: string[];
    status: string;
};

export type Session = {
    token: string;
    expiresAt: string;
    idleTimeoutSeconds: number;
    admin: Admin;
    mfaBypassed?: boolean;
    recoveryCodes?: string[];
};

export type LoginResult =
    | { stage: 'mfa'; challengeToken: string }
    | { stage: 'enrol_mfa'; challengeToken: string; enrolment: { secret: string; uri: string } }
    // Only reachable when the server is running the demo configuration
    // (ADMIN_DEMO_SKIP_MFA=1, in-memory driver, non-production). Against real
    // data the server never returns this stage from /auth/login.
    | ({ stage: 'authenticated' } & Session);

export async function login(email: string, password: string): Promise<LoginResult> {
    const res = await fetch(`${BASE}/admin/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        credentials: 'omit',
    });
    const json = await res.json();
    if (!res.ok) throw new ApiError(res.status, json?.code ?? 'LOGIN_FAILED', json?.message ?? 'Sign-in failed', json);
    if (json.stage === 'authenticated') token = json.token;
    return json as LoginResult;
}

export async function verifyMfa(challengeToken: string, code: string, recoveryCode?: string) {
    const res = await fetch(`${BASE}/admin/auth/mfa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeToken, code, recoveryCode }),
        credentials: 'omit',
    });
    const json = await res.json();
    if (!res.ok) throw new ApiError(res.status, json?.code ?? 'MFA_FAILED', json?.message ?? 'Verification failed', json);
    token = json.token;
    return json as Session;
}

export async function logout() {
    try {
        await api('/auth/logout', { method: 'POST' });
    } finally {
        token = null;
    }
}
