/**
 * Admin API client.
 *
 * The session lives in an httpOnly cookie set by the server, and the browser
 * sends it automatically. JavaScript cannot read it — not this code, not a
 * script someone manages to inject — which is strictly stronger than
 * localStorage, where any injected script can simply read the token out.
 *
 * It used to be a module-level variable and nothing else. The reasoning was
 * sound (an admin token opens every KYC document Hive holds, so it should not
 * sit anywhere readable) but the cost was a re-login on every browser refresh,
 * mid-decision, with no warning. The cookie keeps the security property and
 * drops the cost.
 *
 * The in-memory `token` below is still used for the Authorization header when
 * we have one, so anything scripted against this API keeps working. After a
 * refresh it is null and the cookie carries the session instead.
 *
 * CSRF: the cookie is SameSite=None, because the console and the API are not
 * always on the same site. So every request carries X-Hive-Console, a header a
 * cross-origin page cannot set without a preflight the API answers only for the
 * console's own origin. The server rejects cookie-authenticated writes without
 * it.
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
    /**
     * Suppress the "your session ended" announcement for a 401. Used by the
     * boot-time restore, where no session is the normal case for a first visit
     * and telling someone their session ended when they never had one is a lie.
     */
    quiet?: boolean;
};

export async function api<T = any>(path: string, options: Options = {}): Promise<T> {
    const { method = 'GET', body, raw = false, quiet = false } = options;

    const res = await fetch(`${BASE}/admin${path}`, {
        method,
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            // Proves the request came from this app. See the note at the top.
            'X-Hive-Console': '1',
        },
        body: body ? JSON.stringify(body) : undefined,
        // Sends the httpOnly session cookie. The API answers with
        // Access-Control-Allow-Credentials only for its configured origins.
        credentials: 'include',
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
        if (!quiet) {
            onUnauthorized?.(json?.code ?? 'UNAUTHORIZED', json?.message ?? 'Your session has ended');
        }
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
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            'X-Hive-Console': '1',
        },
        credentials: 'include',
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
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            'X-Hive-Console': '1',
        },
        credentials: 'include',
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

/**
 * Rebuild a session from the httpOnly cookie, on page load.
 *
 * Returns null rather than throwing when there is no usable session — a cold
 * visit and an expired cookie are both ordinary, not errors to surface. The
 * server is the authority: if it says the session idled out, was revoked, or
 * has passed its eight hours, this comes back null and the login form shows.
 */
export async function restoreSession(): Promise<
    { admin: Admin; expiresAt: string; idleTimeoutSeconds: number } | null
> {
    try {
        const res = await api<{ success: boolean; data: any }>('/auth/me', { quiet: true });
        const d = res?.data;
        if (!d?.adminId) return null;
        const idleTimeoutSeconds = d.idleDeadline
            ? Math.max(0, Math.floor((Date.parse(d.idleDeadline) - Date.now()) / 1000))
            : 1800;
        return {
            admin: {
                adminId: d.adminId,
                email: d.email,
                name: d.name,
                role: d.role,
                permissions: d.permissions ?? [],
                status: d.status,
            },
            expiresAt: d.sessionExpiresAt,
            idleTimeoutSeconds,
        };
    } catch {
        // 401 already cleared the token and notified the session handler.
        return null;
    }
}

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
        headers: { 'Content-Type': 'application/json', 'X-Hive-Console': '1' },
        body: JSON.stringify({ email, password }),
        // Must be 'include', or the browser throws away the Set-Cookie on this
        // response and the session cookie is never stored.
        credentials: 'include',
    });
    const json = await res.json();
    if (!res.ok) throw new ApiError(res.status, json?.code ?? 'LOGIN_FAILED', json?.message ?? 'Sign-in failed', json);
    if (json.stage === 'authenticated') token = json.token;
    return json as LoginResult;
}

export async function verifyMfa(challengeToken: string, code: string, recoveryCode?: string) {
    const res = await fetch(`${BASE}/admin/auth/mfa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hive-Console': '1' },
        body: JSON.stringify({ challengeToken, code, recoveryCode }),
        // As above: this is the response that carries the session cookie.
        credentials: 'include',
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
