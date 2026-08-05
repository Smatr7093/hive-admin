/**
 * Grievance SLA computation (PRD §6.3).
 *
 * The published commitments on tryhive.in/grievance-redressal are: acknowledge
 * within 24 hours, resolve within 15 days, and action §6.3 categories within 24
 * hours. Under the IT Rules 2021 those are obligations, so the clock has to be a
 * computed property of the ticket rather than a field someone updates.
 *
 * Two deliberate choices:
 *
 *  - The clock runs from `receivedAt`, not `createdAt`. A grievance that arrives
 *    by post is entered days later and the SLA still runs from the physical
 *    receipt date (PRD §12).
 *  - Nothing here filters. G-06 requires that urgent tickets cannot be filtered
 *    out of view, so urgency is a computed flag the query layer refuses to
 *    exclude — see grievanceController.list.
 */

const { SLA } = require('../config/constants');

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** breached > critical > warning > ok — ordered so `Math.max` over states works. */
const STATE_RANK = { ok: 0, warning: 1, critical: 2, breached: 3 };

function stateFor(remainingMs, totalMs) {
    if (remainingMs <= 0) return 'breached';
    const fraction = remainingMs / totalMs;
    if (fraction <= 0.1) return 'critical';
    if (fraction <= 0.25) return 'warning';
    return 'ok';
}

function humanise(ms) {
    const abs = Math.abs(ms);
    const days = Math.floor(abs / DAY);
    const hours = Math.floor((abs % DAY) / HOUR);
    const minutes = Math.floor((abs % HOUR) / 60_000);
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (!days && minutes) parts.push(`${minutes}m`);
    const text = parts.join(' ') || '0m';
    return ms < 0 ? `${text} overdue` : text;
}

function countdown({ deadlineMs, totalMs, satisfiedAt, now }) {
    const met = satisfiedAt ? Date.parse(satisfiedAt) <= deadlineMs : null;
    if (satisfiedAt) {
        return {
            deadline: new Date(deadlineMs).toISOString(),
            satisfiedAt,
            met,
            state: met ? 'met' : 'breached',
            remainingMs: 0,
            label: met ? 'Met' : 'Breached',
        };
    }
    const remainingMs = deadlineMs - now;
    const state = stateFor(remainingMs, totalMs);
    return {
        deadline: new Date(deadlineMs).toISOString(),
        satisfiedAt: null,
        met: null,
        state,
        remainingMs,
        label: humanise(remainingMs),
    };
}

/**
 * Compute every clock on a grievance.
 *
 * Returns `{ urgent, acknowledgement, resolution, urgentAction, assignment,
 * appeal, worstState }`. `worstState` is what drives the colour coding in G-04 —
 * a ticket is as bad as its worst clock.
 */
function computeSla(grievance, now = Date.now()) {
    const received = Date.parse(grievance.receivedAt ?? grievance.createdAt);
    const urgent = !!grievance.isUrgent;

    const acknowledgement = countdown({
        deadlineMs: received + SLA.ACK_HOURS * HOUR,
        totalMs: SLA.ACK_HOURS * HOUR,
        satisfiedAt: grievance.acknowledgedAt ?? null,
        now,
    });

    const resolution = countdown({
        deadlineMs: received + SLA.RESOLVE_DAYS * DAY,
        totalMs: SLA.RESOLVE_DAYS * DAY,
        satisfiedAt: grievance.resolvedAt ?? null,
        now,
    });

    // G-05 — the urgent track has its own 24-hour action deadline, and it is a
    // separate clock from acknowledgement. Acknowledging an NCII report is not
    // actioning it.
    const urgentAction = urgent
        ? countdown({
            deadlineMs: received + SLA.URGENT_ACTION_HOURS * HOUR,
            totalMs: SLA.URGENT_ACTION_HOURS * HOUR,
            satisfiedAt: grievance.urgentActionedAt ?? grievance.resolvedAt ?? null,
            now,
        })
        : null;

    // G-07 — unassigned tickets are flagged after four hours.
    const assignment = grievance.assignedTo
        ? { state: 'met', label: 'Assigned', assignedTo: grievance.assignedTo, assignedAt: grievance.assignedAt }
        : {
            state: now - received > SLA.UNASSIGNED_FLAG_HOURS * HOUR ? 'breached' : 'ok',
            label: now - received > SLA.UNASSIGNED_FLAG_HOURS * HOUR
                ? `Unassigned for ${humanise(now - received)}`
                : 'Unassigned',
            assignedTo: null,
        };

    // G-10 — the 30-day appeal window runs from resolution.
    const appeal = grievance.resolvedAt
        ? (() => {
            const closes = Date.parse(grievance.resolvedAt) + SLA.APPEAL_WINDOW_DAYS * DAY;
            return {
                closesAt: new Date(closes).toISOString(),
                open: now < closes && !grievance.appeal?.decidedAt,
                remainingLabel: humanise(closes - now),
                appealed: !!grievance.appeal,
            };
        })()
        : { closesAt: null, open: false, remainingLabel: null, appealed: false };

    // G-12 — retention floor, 180 days from resolution.
    const retention = grievance.resolvedAt
        ? {
            purgeableAfter: new Date(
                Date.parse(grievance.resolvedAt) + SLA.GRIEVANCE_RETENTION_DAYS * DAY
            ).toISOString(),
        }
        : { purgeableAfter: null };

    const clocks = [acknowledgement, resolution, urgentAction, assignment].filter(Boolean);
    const worstState = clocks.reduce(
        (worst, c) => (STATE_RANK[c.state] > STATE_RANK[worst] ? c.state : worst),
        'ok'
    );

    return {
        urgent,
        acknowledgement,
        resolution,
        urgentAction,
        assignment,
        appeal,
        retention,
        worstState,
        // A single boolean the dashboard counts. Any breached clock is a breach.
        breached: clocks.some((c) => c.state === 'breached'),
    };
}

/** §11 — dashboard counters by SLA state. */
function summarise(grievances, now = Date.now()) {
    const summary = {
        total: grievances.length,
        open: 0,
        urgentOpen: 0,
        breached: 0,
        critical: 0,
        warning: 0,
        ok: 0,
        awaitingAcknowledgement: 0,
        unassignedFlagged: 0,
    };
    for (const g of grievances) {
        const sla = computeSla(g, now);
        if (!g.resolvedAt) {
            summary.open += 1;
            if (sla.urgent) summary.urgentOpen += 1;
            if (!g.acknowledgedAt) summary.awaitingAcknowledgement += 1;
            if (sla.assignment.state === 'breached') summary.unassignedFlagged += 1;
            if (sla.breached) summary.breached += 1;
            else if (sla.worstState === 'critical') summary.critical += 1;
            else if (sla.worstState === 'warning') summary.warning += 1;
            else summary.ok += 1;
        }
    }
    return summary;
}

module.exports = { computeSla, summarise, humanise, STATE_RANK };
