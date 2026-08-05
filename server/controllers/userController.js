/**
 * User management and the deletion queue (PRD §9).
 *
 * U-07 is only partially implementable today, and that is a data problem rather
 * than an engineering one. tryhive.in/privacy says KYC data is deleted on account
 * deletion; tryhive.in/delete-account says it is retained up to 8 years for
 * financial compliance. Both cannot be true.
 *
 * Rather than pick one and quietly encode it, the KYC retention basis is modelled
 * as `unresolved` and the deletion queue refuses to complete any deletion where a
 * KYC record exists until `ADMIN_KYC_RETENTION_POLICY` is set to `delete` or
 * `retain`. Someone has to make the decision; the code will not make it for them.
 */

const { store, TABLES } = require('../lib/store');
const audit = require('../lib/audit');
const { maskFor } = require('../lib/mask');
const { SUSPENSION_REASONS, DELETION_RETENTION_BASES, SLA } = require('../config/constants');

const KYC_RETENTION_POLICY = process.env.ADMIN_KYC_RETENTION_POLICY ?? 'unresolved';

// ─── U-01 — search ───────────────────────────────────────────────────────────

exports.search = async (req, res, next) => {
    try {
        const { q, role, status, limit = 50 } = req.query;
        const needle = q ? String(q).toLowerCase().trim() : null;

        const [users, companions] = await Promise.all([
            store.list(TABLES.USERS),
            store.list(TABLES.COMPANIONS),
        ]);
        const companionIds = new Set(companions.map((c) => c.userId));

        const matches = users.filter((u) => {
            if (role === 'companion' && !companionIds.has(u.userId)) return false;
            if (role === 'seeker' && companionIds.has(u.userId)) return false;
            if (status && (u.accountStatus ?? 'active') !== status) return false;
            if (!needle) return true;
            return [u.userId, u.name, u.phone, u.email].join(' ').toLowerCase().includes(needle);
        });

        const data = await Promise.all(matches.slice(0, Number(limit)).map(async (u) => {
            const companion = companions.find((c) => c.userId === u.userId);
            return maskFor(req.admin, {
                userId: u.userId,
                name: u.name ?? companion?.name ?? null,
                phone: u.phone ?? null,
                email: u.email ?? null,
                isCompanion: companionIds.has(u.userId),
                accountStatus: u.accountStatus ?? 'active',
                isKycVerified: companion?.isKycVerified ?? null,
                createdAt: u.createdAt,
            }, { recordType: 'user', recordId: u.userId });
        }));

        return res.json({ success: true, data, meta: { total: matches.length, shown: data.length } });
    } catch (err) {
        return next(err);
    }
};

// ─── U-02 — full profile view ────────────────────────────────────────────────

exports.detail = async (req, res, next) => {
    try {
        const { userId } = req.params;
        const user = await store.get(TABLES.USERS, userId);
        const companion = await store.get(TABLES.COMPANIONS, userId);
        if (!user && !companion) return res.status(404).json({ success: false, message: 'User not found' });

        const [bookingsAsSeeker, bookingsAsCompanion, reportsFiled, reportsReceived, moderation, kyc, grievances, deletionRequests] =
            await Promise.all([
                store.list(TABLES.BOOKINGS, { filter: (b) => b.userId === userId }),
                store.list(TABLES.BOOKINGS, { filter: (b) => b.companionId === userId }),
                store.list(TABLES.REPORTS, { filter: (r) => r.reporterUserId === userId }),
                store.list(TABLES.REPORTS, { filter: (r) => r.reportedUserId === userId }),
                store.list(TABLES.MODERATION_ITEMS, { filter: (m) => m.userId === userId }),
                store.list(TABLES.KYC_SUBMISSIONS, { filter: (k) => k.userId === userId }),
                store.list(TABLES.GRIEVANCES, { filter: (g) => g.againstUserId === userId || g.complainantUserId === userId }),
                store.list(TABLES.DELETION_REQUESTS, { filter: (d) => d.userId === userId }),
            ]);

        const profile = await maskFor(req.admin, {
            userId,
            name: user?.name ?? companion?.name ?? null,
            phone: user?.phone ?? null,
            email: user?.email ?? null,
            authProvider: user?.authProvider ?? null,
            registeredAt: user?.createdAt ?? companion?.createdAt ?? null,
            accountStatus: user?.accountStatus ?? 'active',
            suspendedUntil: user?.suspendedUntil ?? null,
            suspensionReason: user?.suspensionReason ?? null,
            reliabilityScore: user?.reliabilityScore ?? companion?.reliabilityScore ?? null,
            isCompanion: !!companion,
            isKycVerified: companion?.isKycVerified ?? null,
            kycStatus: companion?.kycStatus ?? null,
            upiId: companion?.upiId ?? null,
        }, { recordType: 'user', recordId: userId });

        return res.json({
            success: true,
            data: {
                profile,
                bookings: {
                    asSeeker: bookingsAsSeeker.length,
                    asCompanion: bookingsAsCompanion.length,
                    recent: [...bookingsAsSeeker, ...bookingsAsCompanion]
                        .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
                        .slice(0, 10)
                        .map((b) => ({
                            bookingId: b.bookingId, status: b.status, selectedDate: b.selectedDate,
                            totalAmount: b.totalAmount, role: b.userId === userId ? 'seeker' : 'companion',
                        })),
                },
                // Reports filed *by* this user are counted but their targets are
                // not enumerated here — a support admin looking at one account
                // should not get a list of everyone they have complained about.
                reports: { filed: reportsFiled.length, received: reportsReceived.length },
                moderationHistory: moderation.map((m) => ({
                    itemId: m.itemId, type: m.type, status: m.status,
                    createdAt: m.createdAt, reasonCode: m.decision?.reasonCode ?? null,
                })),
                kycHistory: kyc.map((k) => ({
                    submissionId: k.submissionId, status: k.status, submittedAt: k.submittedAt,
                    attemptNumber: k.attemptNumber, reasonCode: k.decision?.reasonCode ?? null,
                })),
                grievances: grievances.map((g) => ({
                    grievanceId: g.grievanceId, reference: g.reference, category: g.category,
                    isUrgent: g.isUrgent, receivedAt: g.receivedAt, resolvedAt: g.resolvedAt,
                    side: g.complainantUserId === userId ? 'complainant' : 'subject',
                })),
                deletionRequests,
                // U-08 — placeholder until v2.2 chat ships. Declared rather than
                // silently absent so it is obviously pending, not forgotten.
                blockedContactShareAttempts: {
                    available: false,
                    reason: 'Depends on v2.2 chat (U-08)',
                    count: null,
                },
                suspensionReasons: SUSPENSION_REASONS,
            },
        });
    } catch (err) {
        return next(err);
    }
};

// ─── U-03 — suspend ──────────────────────────────────────────────────────────

exports.suspend = async (req, res, next) => {
    try {
        const { userId } = req.params;
        const { reasonCode, note, durationDays } = req.body;
        const reason = SUSPENSION_REASONS.find((r) => r.id === reasonCode);
        if (!reason) {
            return res.status(400).json({ success: false, message: 'A valid reasonCode is required', allowed: SUSPENSION_REASONS });
        }
        if (durationDays != null && (!Number.isInteger(Number(durationDays)) || Number(durationDays) < 1)) {
            return res.status(400).json({ success: false, message: 'durationDays must be a positive integer, or omitted for indefinite' });
        }

        const user = await store.get(TABLES.USERS, userId);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        const now = new Date().toISOString();
        const until = durationDays ? new Date(Date.now() + Number(durationDays) * 86_400_000).toISOString() : null;

        const updated = await store.patch(TABLES.USERS, userId, {
            accountStatus: 'suspended',
            suspendedAt: now,
            suspendedUntil: until,
            suspensionReason: reason.label,
            suspensionNote: note ?? null,
            suspendedBy: req.admin.adminId,
        });
        await store.patch(TABLES.COMPANIONS, userId, { availabilityStatus: 'suspended' });

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.USER_SUSPENDED,
            targetType: 'user',
            targetId: userId,
            reason: note ? `${reason.label} — ${note}` : reason.label,
            reasonCode,
            before: { accountStatus: user.accountStatus ?? 'active' },
            after: { accountStatus: 'suspended', suspendedUntil: until },
            metadata: { durationDays: durationDays ?? 'indefinite' },
            request: req,
        });

        return res.json({ success: true, data: updated });
    } catch (err) {
        return next(err);
    }
};

exports.unsuspend = async (req, res, next) => {
    try {
        const { userId } = req.params;
        const { note } = req.body ?? {};
        if (!note) return res.status(400).json({ success: false, message: 'A reason is required' });
        const user = await store.get(TABLES.USERS, userId);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        const updated = await store.patch(TABLES.USERS, userId, {
            accountStatus: 'active',
            suspendedUntil: null,
            suspensionReason: null,
            unsuspendedAt: new Date().toISOString(),
            unsuspendedBy: req.admin.adminId,
        });
        await store.patch(TABLES.COMPANIONS, userId, { availabilityStatus: 'available' });

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.USER_UNSUSPENDED,
            targetType: 'user',
            targetId: userId,
            reason: note,
            before: { accountStatus: 'suspended' },
            after: { accountStatus: 'active' },
            request: req,
        });

        return res.json({ success: true, data: updated });
    } catch (err) {
        return next(err);
    }
};

// ─── U-04 — permanent removal, Super Admin only ──────────────────────────────

exports.remove = async (req, res, next) => {
    try {
        const { userId } = req.params;
        const { note } = req.body ?? {};
        if (!note || String(note).trim().length < 15) {
            return res.status(400).json({ success: false, message: 'Permanent removal requires a written reason of at least 15 characters' });
        }
        const user = await store.get(TABLES.USERS, userId);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        const blockers = await deletionBlockers(userId);
        if (blockers.length && !req.body.overrideBlockers) {
            return res.status(409).json({
                success: false,
                code: 'REMOVAL_BLOCKED',
                message: 'This account has open obligations — resolve them or pass overrideBlockers with a reason',
                blockers,
            });
        }

        const now = new Date().toISOString();
        const updated = await store.patch(TABLES.USERS, userId, {
            accountStatus: 'removed',
            removedAt: now,
            removalReason: note,
            removedBy: req.admin.adminId,
        });
        await store.patch(TABLES.COMPANIONS, userId, { availabilityStatus: 'removed', isVerified: false });

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.USER_REMOVED,
            targetType: 'user',
            targetId: userId,
            reason: note,
            before: { accountStatus: user.accountStatus ?? 'active' },
            after: { accountStatus: 'removed' },
            metadata: { blockersOverridden: blockers.length ? blockers : null },
            request: req,
        });

        return res.json({ success: true, data: updated });
    } catch (err) {
        return next(err);
    }
};

// ─── U-05, U-06 — deletion queue ─────────────────────────────────────────────

/**
 * U-06 — what stands in the way of honouring this deletion request.
 *
 * PRD §12: a companion with an open grievance against them has deletion deferred
 * until resolution, per the published /delete-account page.
 */
async function deletionBlockers(userId) {
    const [payouts, disputes, bookings, grievances] = await Promise.all([
        store.list(TABLES.PAYOUTS, { filter: (p) => p.companionId === userId && ['requested', 'processing', 'held', 'failed'].includes(p.status) }),
        store.list(TABLES.DISPUTES, { filter: (d) => d.status === 'open' }),
        store.list(TABLES.BOOKINGS, { filter: (b) => (b.userId === userId || b.companionId === userId) && ['pending', 'confirmed'].includes(b.status) }),
        store.list(TABLES.GRIEVANCES, { filter: (g) => g.againstUserId === userId && !g.resolvedAt }),
    ]);

    const relevantDisputes = [];
    for (const d of disputes) {
        const booking = await store.get(TABLES.BOOKINGS, d.bookingId);
        if (booking && (booking.userId === userId || booking.companionId === userId)) relevantDisputes.push(d);
    }

    const blockers = [];
    if (payouts.length) blockers.push({ type: 'pending_payouts', count: payouts.length, detail: `${payouts.length} payout(s) not settled`, ids: payouts.map((p) => p.payoutId) });
    if (relevantDisputes.length) blockers.push({ type: 'open_disputes', count: relevantDisputes.length, detail: `${relevantDisputes.length} open dispute(s)`, ids: relevantDisputes.map((d) => d.disputeId) });
    if (bookings.length) blockers.push({ type: 'active_bookings', count: bookings.length, detail: `${bookings.length} booking(s) still active`, ids: bookings.map((b) => b.bookingId) });
    if (grievances.length) blockers.push({ type: 'open_grievance', count: grievances.length, detail: 'Deletion deferred until the grievance is resolved (PRD §12)', ids: grievances.map((g) => g.grievanceId) });
    return blockers;
}

/**
 * U-07 — what was deleted, what was retained, and under which basis.
 *
 * `unresolved` is a real state here, not a placeholder: until the privacy policy
 * contradiction is settled, the honest answer for KYC data is that Hive's own
 * published pages disagree.
 */
async function retentionPlan(userId) {
    const kyc = await store.list(TABLES.KYC_SUBMISSIONS, { filter: (k) => k.userId === userId });
    const refunds = await store.list(TABLES.REFUNDS, { filter: (r) => r.userId === userId || r.companionId === userId });
    const reports = await store.list(TABLES.REPORTS, { filter: (r) => r.reportedUserId === userId || r.reporterUserId === userId });
    const grievances = await store.list(TABLES.GRIEVANCES, { filter: (g) => g.againstUserId === userId || g.complainantUserId === userId });

    const items = [
        { item: 'Profile, bio and photos', action: 'delete', basis: null, detail: 'Removed on processing' },
        { item: 'Contact details (phone, email)', action: 'delete', basis: null, detail: 'Removed on processing' },
        { item: 'Chat history', action: 'delete', basis: null, detail: 'Removed on processing' },
        { item: 'Registration record', action: 'retain', basis: 'registration_record', detail: `Retained ${SLA.GRIEVANCE_RETENTION_DAYS} days per the published deletion page` },
        { item: 'Financial records (bookings, payouts, refunds)', action: 'retain', basis: 'financial_records', detail: `${refunds.length} financial record(s) — statutory retention` },
        { item: 'Safety and moderation records', action: 'retain', basis: 'safety_records', detail: `${reports.length} report(s) retained` },
    ];

    if (kyc.length) {
        items.push({
            item: 'KYC documents and extracted identity data',
            action: KYC_RETENTION_POLICY === 'unresolved' ? 'unresolved' : KYC_RETENTION_POLICY,
            basis: KYC_RETENTION_POLICY === 'retain' ? 'financial_records' : null,
            detail: KYC_RETENTION_POLICY === 'unresolved'
                ? 'BLOCKED: tryhive.in/privacy says KYC data is deleted on account deletion; tryhive.in/delete-account says it is retained up to 8 years. Set ADMIN_KYC_RETENTION_POLICY once the contradiction is resolved.'
                : `${kyc.length} KYC record(s)`,
            count: kyc.length,
        });
    }

    const openGrievances = grievances.filter((g) => !g.resolvedAt);
    if (openGrievances.length) {
        items.push({
            item: 'Grievance records',
            action: 'retain',
            basis: 'grievance_open',
            detail: 'Deletion deferred until open grievances are resolved',
        });
    }

    return items;
}

exports.deletionQueue = async (req, res, next) => {
    try {
        const { status = 'pending' } = req.query;
        const requests = await store.list(TABLES.DELETION_REQUESTS, {
            filter: (d) => status === 'all' || d.status === status,
        });

        const data = await Promise.all(requests
            .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
            .map(async (d) => {
                const blockers = await deletionBlockers(d.userId);
                return {
                    ...d,
                    blockers,
                    blocked: blockers.length > 0,
                    daysWaiting: Math.floor((Date.now() - Date.parse(d.requestedAt)) / 86_400_000),
                };
            }));

        return res.json({
            success: true,
            data,
            meta: {
                total: data.length,
                blocked: data.filter((d) => d.blocked).length,
                clear: data.filter((d) => !d.blocked).length,
                kycPolicyResolved: KYC_RETENTION_POLICY !== 'unresolved',
            },
        });
    } catch (err) {
        return next(err);
    }
};

exports.deletionDetail = async (req, res, next) => {
    try {
        const request = await store.get(TABLES.DELETION_REQUESTS, req.params.requestId);
        if (!request) return res.status(404).json({ success: false, message: 'Deletion request not found' });
        const blockers = await deletionBlockers(request.userId);
        const retention = await retentionPlan(request.userId);
        return res.json({
            success: true,
            data: {
                ...request,
                blockers,
                blocked: blockers.length > 0,
                retentionPlan: retention,           // U-07
                retentionBases: DELETION_RETENTION_BASES,
                unresolvedPolicyItems: retention.filter((r) => r.action === 'unresolved'),
            },
        });
    } catch (err) {
        return next(err);
    }
};

exports.processDeletion = async (req, res, next) => {
    try {
        const { requestId } = req.params;
        const { note } = req.body ?? {};
        const request = await store.get(TABLES.DELETION_REQUESTS, requestId);
        if (!request) return res.status(404).json({ success: false, message: 'Deletion request not found' });
        if (request.status !== 'pending') return res.status(409).json({ success: false, message: `Request is ${request.status}` });

        const blockers = await deletionBlockers(request.userId);
        if (blockers.length) {
            const updated = await store.patch(TABLES.DELETION_REQUESTS, requestId, {
                status: 'deferred',
                blockers,
                deferredAt: new Date().toISOString(),
                deferredBy: req.admin.adminId,
                deferralNote: note ?? blockers.map((b) => b.detail).join('; '),
            });
            await audit.record({
                actor: req.admin,
                action: audit.ACTIONS.DELETION_DEFERRED,
                targetType: 'deletion_request',
                targetId: requestId,
                reason: note ?? 'Deferred — open obligations on the account',
                metadata: { userId: request.userId, blockers },
                request: req,
            });
            return res.status(409).json({ success: false, code: 'DELETION_BLOCKED', message: 'Deletion deferred', blockers, data: updated });
        }

        const retention = await retentionPlan(request.userId);
        const unresolved = retention.filter((r) => r.action === 'unresolved');
        if (unresolved.length) {
            return res.status(409).json({
                success: false,
                code: 'RETENTION_POLICY_UNRESOLVED',
                message: 'Cannot complete this deletion: the retention basis for KYC data is unresolved between tryhive.in/privacy and tryhive.in/delete-account. U-07 requires the record to state which basis applied, and there is no correct answer to record yet.',
                unresolved,
            });
        }

        const now = new Date().toISOString();
        const deleted = retention.filter((r) => r.action === 'delete').map((r) => r.item);
        const retained = retention.filter((r) => r.action === 'retain').map((r) => ({ item: r.item, basis: r.basis }));

        await store.patch(TABLES.USERS, request.userId, {
            accountStatus: 'deleted',
            deletedAt: now,
            name: null, phone: null, email: null, picture: null,
        });
        await store.patch(TABLES.COMPANIONS, request.userId, {
            availabilityStatus: 'deleted',
            bio: null, about: null, profileImage: null, thumbnailImage: null,
            kycDocumentUrl: null, kycSelfieUrl: null,
        });

        const updated = await store.patch(TABLES.DELETION_REQUESTS, requestId, {
            status: 'completed',
            completedAt: now,
            completedBy: req.admin.adminId,
            retentionRecord: { deleted, retained, kycPolicy: KYC_RETENTION_POLICY },
            note: note ?? null,
        });

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.DELETION_PROCESSED,
            targetType: 'deletion_request',
            targetId: requestId,
            reason: note ?? 'Account deletion processed',
            after: { deleted, retained },
            metadata: { userId: request.userId },
            request: req,
        });

        return res.json({ success: true, data: updated });
    } catch (err) {
        return next(err);
    }
};

exports.meta = (_req, res) => res.json({
    success: true,
    data: {
        suspensionReasons: SUSPENSION_REASONS,
        retentionBases: DELETION_RETENTION_BASES,
        kycRetentionPolicy: KYC_RETENTION_POLICY,
        kycRetentionPolicyResolved: KYC_RETENTION_POLICY !== 'unresolved',
    },
});

exports.deletionBlockers = deletionBlockers;
exports.retentionPlan = retentionPlan;
