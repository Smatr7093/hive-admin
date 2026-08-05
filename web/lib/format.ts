/**
 * Formatting helpers.
 *
 * Money is stored in paise everywhere — the consumer app, the ledger, the payout
 * gateway. It is converted to rupees exactly once, here, on the way to a screen.
 * Every past rounding bug in a payments system started with a second place that
 * did the division.
 */

export function rupees(paise: number | null | undefined, { decimals = 0 } = {}) {
    if (paise == null) return '—';
    return `₹${(paise / 100).toLocaleString('en-IN', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    })}`;
}

export function relativeTime(iso: string | null | undefined) {
    if (!iso) return '—';
    const diff = Date.now() - Date.parse(iso);
    const abs = Math.abs(diff);
    const minutes = Math.floor(abs / 60_000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    let text: string;
    if (minutes < 1) text = 'just now';
    else if (minutes < 60) text = `${minutes}m`;
    else if (hours < 24) text = `${hours}h`;
    else if (days < 30) text = `${days}d`;
    else text = `${Math.floor(days / 30)}mo`;

    if (minutes < 1) return text;
    return diff > 0 ? `${text} ago` : `in ${text}`;
}

export function duration(ms: number) {
    const negative = ms < 0;
    const abs = Math.abs(ms);
    const days = Math.floor(abs / 86_400_000);
    const hours = Math.floor((abs % 86_400_000) / 3_600_000);
    const minutes = Math.floor((abs % 3_600_000) / 60_000);
    const parts: string[] = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (!days && minutes) parts.push(`${minutes}m`);
    const text = parts.join(' ') || '0m';
    return negative ? `${text} overdue` : text;
}

export function clock(seconds: number) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

export function dateTime(iso: string | null | undefined) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false,
    });
}

export function dateOnly(iso: string | null | undefined) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function titleCase(value: string | null | undefined) {
    if (!value) return '—';
    return value.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export const ROLE_LABELS: Record<string, string> = {
    super_admin: 'Super Admin',
    ops: 'Ops',
    support: 'Support',
    finance: 'Finance',
    read_only: 'Read-only',
};

/** Maps an SLA state to the pill class. Kept in one place so the four levels
 *  stay the four levels. */
export function stateClass(state: string | null | undefined) {
    switch (state) {
        case 'breached': return 'pill-breach';
        case 'critical': return 'pill-critical';
        case 'warning': return 'pill-warning';
        case 'ok':
        case 'met': return 'pill-ok';
        default: return 'pill-neutral';
    }
}

export function rowClass(state: string | null | undefined) {
    switch (state) {
        case 'breached': return 'row-breach';
        case 'critical': return 'row-critical';
        case 'warning': return 'row-warning';
        default: return '';
    }
}
