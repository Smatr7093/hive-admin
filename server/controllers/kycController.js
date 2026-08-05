/**
 * KYC approval queue (PRD §5).
 *
 * The decision surface is built around one idea: put everything a reviewer needs
 * to say yes or no on the same screen, and make the two things that actually go
 * wrong — an underage applicant and a duplicate identity — impossible to miss.
 *
 * Approved records are immutable (K-12). A correction does not edit the record;
 * it writes a new one carrying `supersedes`, and the old one keeps its decision
 * and gains `supersededBy`. That is what makes "who let this account through"
 * answerable months later.
 */

const { store, TABLES, ConflictError } = require('../lib/store');
const audit = require('../lib/audit');
const { hashIdentifier, randomId } = require('../lib/crypto');
const { maskFor, watermarkText } = require('../lib/mask');
const { KYC, KYC_REJECTION_REASONS, PERM } = require('../config/constants');
const { notifyUser } = require('../lib/notify');

const ACTIVE_STATUSES = ['pending', 'manual_review'];

// ─── Derived facts ───────────────────────────────────────────────────────────

function ageFromDob(dob) {
    if (!dob) return null;
    const born = new Date(dob);
    if (Number.isNaN(born.getTime())) return null;
    const now = new Date();
    let age = now.getUTCFullYear() - born.getUTCFullYear();
    const monthDiff = now.getUTCMonth() - born.getUTCMonth();
    if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < born.getUTCDate())) age--;
    return age;
}

function hoursBetween(a, b) {
    return Math.max(0, (b - Date.parse(a)) / 3_600_000);
}

/** K-02 — the reviewer compares extracted document fields against the profile. */
function fieldComparison(submission) {
    const doc = submission.extracted ?? {};
    const profile = submission.profileSnapshot ?? {};
    const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    return {
        name: {
            document: doc.name ?? null,
            profile: profile.name ?? null,
            matches: norm(doc.name) === norm(profile.name),
        },
        dob: {
            document: doc.dob ?? null,
            profile: profile.dob ?? null,
            matches: (doc.dob ?? '') === (profile.dob ?? ''),
        },
    };
}

/** K-03 — the age check is computed, not eyeballed, and surfaced as its own field. */
function ageCheck(submission) {
    const documentAge = ageFromDob(submission.extracted?.dob);
    const profileAge = ageFromDob(submission.profileSnapshot?.dob);
    return {
        documentAge,
        profileAge,
        minimum: KYC.MIN_AGE,
        // Unknown DOB is not a pass. If the document did not yield a date, the
        // reviewer is told the check could not be performed.
        passes: documentAge != null && documentAge >= KYC.MIN_AGE,
        indeterminate: documentAge == null,
    };
}

/** K-04 — duplicates match on the hashed ID number, never the raw value. */
async function duplicateMatches(submission) {
    if (!submission.idNumberHash) return [];
    const others = await store.list(TABLES.KYC_SUBMISSIONS, {
        filter: (s) => s.idNumberHash === submission.idNumberHash && s.userId !== submission.userId,
    });
    const seen = new Map();
    for (const other of others) {
        if (!seen.has(other.userId)) {
            seen.set(other.userId, {
                userId: other.userId,
                name: other.profileSnapshot?.name ?? null,
                submissionId: other.submissionId,
                status: other.status,
                submittedAt: other.submittedAt,
            });
        }
    }
    return [...seen.values()];
}

async function attemptHistory(userId) {
    const all = await store.list(TABLES.KYC_SUBMISSIONS, { filter: (s) => s.userId === userId });
    return all.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
}

// ─── GET /admin/kyc/queue ────────────────────────────────────────────────────

exports.queue = async (req, res, next) => {
    try {
        const { status = 'open' } = req.query;
        const now = Date.now();

        const wanted =
            status === 'open' ? ACTIVE_STATUSES
            : status === 'all' ? null
            : [status];

        const items = await store.list(TABLES.KYC_SUBMISSIONS, {
            filter: (s) => (wanted ? wanted.includes(s.status) : true) && !s.supersededBy,
        });

        // K-01 — oldest first. The queue is a queue, not a list someone picks the
        // easy items off the top of.
        items.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));

        const enriched = await Promise.all(items.map(async (s) => {
            const history = await attemptHistory(s.userId);
            return {
                submissionId: s.submissionId,
                userId: s.userId,
                name: s.profileSnapshot?.name ?? null,
                submittedAt: s.submittedAt,
                hoursInQueue: Math.round(hoursBetween(s.submittedAt, now) * 10) / 10,
                status: s.status,
                documentType: s.documentType,
                attemptNumber: s.attemptNumber,           // K-05
                totalAttempts: history.length,
                rejectionCount: history.filter((h) => h.status === 'rejected').length,
                ageCheck: ageCheck(s),                     // K-03 — visible in the list, not just the detail
                duplicateCount: (await duplicateMatches(s)).length,
                version: s.version,
            };
        }));

        return res.json({
            success: true,
            data: enriched,
            meta: {
                total: enriched.length,
                oldestHours: enriched.length ? enriched[0].hoursInQueue : 0,
                underageFlagged: enriched.filter((e) => !e.ageCheck.passes).length,
                duplicatesFlagged: enriched.filter((e) => e.duplicateCount > 0).length,
            },
        });
    } catch (err) {
        return next(err);
    }
};

// ─── GET /admin/kyc/:submissionId ────────────────────────────────────────────

exports.detail = async (req, res, next) => {
    try {
        const submission = await store.get(TABLES.KYC_SUBMISSIONS, req.params.submissionId);
        if (!submission) return res.status(404).json({ success: false, message: 'Submission not found' });

        const history = await attemptHistory(submission.userId);
        const duplicates = await duplicateMatches(submission);

        // The raw document URLs never leave the server; the console only ever
        // gets the watermarked preview endpoint (P-04).
        const masked = await maskFor(req.admin, submission, {
            recordType: 'kyc',
            recordId: submission.submissionId,
        });

        return res.json({
            success: true,
            data: {
                ...masked,
                kycDocumentUrl: undefined,
                kycSelfieUrl: undefined,
                preview: {
                    document: `/admin/kyc/${submission.submissionId}/document/gov-id`,
                    selfie: `/admin/kyc/${submission.submissionId}/document/selfie`,
                },
                canDownload: req.admin.permissions.includes(PERM.KYC_DOC_DOWNLOAD), // P-05
                comparison: fieldComparison(submission),
                ageCheck: ageCheck(submission),
                duplicates,
                attempts: {
                    current: submission.attemptNumber,
                    total: history.length,
                    max: KYC.MAX_SUBMISSIONS,
                    windowDays: KYC.RESUBMISSION_WINDOW_DAYS,
                    history: history.map((h) => ({
                        submissionId: h.submissionId,
                        attemptNumber: h.attemptNumber,
                        submittedAt: h.submittedAt,
                        status: h.status,
                        decidedAt: h.decision?.at ?? null,
                        reasonCode: h.decision?.reasonCode ?? null,
                    })),
                },
                rejectionReasons: KYC_REJECTION_REASONS,
            },
        });
    } catch (err) {
        return next(err);
    }
};

// ─── GET /admin/kyc/:submissionId/document/:kind ─────────────────────────────
//
// P-04 — the preview is watermarked with the viewing admin's ID and timestamp,
// server-side. The image is embedded in an SVG the server composes, so the
// watermark cannot be removed by disabling CSS or editing the DOM.
// P-05 — ?download=1 returns the original bytes, needs KYC_DOC_DOWNLOAD, and is
// logged as its own event.

exports.document = async (req, res, next) => {
    try {
        const { submissionId, kind } = req.params;
        const wantsDownload = req.query.download === '1';

        if (!['gov-id', 'selfie'].includes(kind)) {
            return res.status(400).json({ success: false, message: "kind must be 'gov-id' or 'selfie'" });
        }

        const submission = await store.get(TABLES.KYC_SUBMISSIONS, submissionId);
        if (!submission) return res.status(404).json({ success: false, message: 'Submission not found' });

        const sourceUrl = kind === 'gov-id' ? submission.kycDocumentUrl : submission.kycSelfieUrl;
        if (!sourceUrl) return res.status(404).json({ success: false, message: 'No document of that kind' });

        if (wantsDownload) {
            if (!req.admin.permissions.includes(PERM.KYC_DOC_DOWNLOAD)) {
                return res.status(403).json({
                    success: false,
                    message: 'Document downloads are available to Ops and Super Admin only',
                });
            }
            await audit.record({
                actor: req.admin,
                action: audit.ACTIONS.DOCUMENT_DOWNLOADED,
                targetType: 'kyc_submission',
                targetId: submissionId,
                reason: req.query.reason ?? 'KYC document downloaded',
                metadata: { kind, userId: submission.userId },
                request: req,
            });
            const { stream, contentType } = await fetchDocument(sourceUrl);
            res.setHeader('Content-Type', contentType);
            res.setHeader('Content-Disposition', `attachment; filename="${submissionId}-${kind}"`);
            return stream.pipe(res);
        }

        // L-04 — every document view is its own audit event.
        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.DOCUMENT_VIEWED,
            targetType: 'kyc_submission',
            targetId: submissionId,
            reason: 'KYC document previewed',
            metadata: { kind, userId: submission.userId },
            request: req,
        });

        const { buffer, contentType } = await fetchDocumentBuffer(sourceUrl);
        const svg = watermarkedSvg(buffer, contentType, watermarkText(req.admin));
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'no-store'); // the watermark is per-view
        return res.send(svg);
    } catch (err) {
        return next(err);
    }
};

function watermarkedSvg(buffer, contentType, text) {
    const dataUri = `data:${contentType};base64,${buffer.toString('base64')}`;
    const escaped = String(text).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1000 700" width="1000" height="700">
  <image xlink:href="${dataUri}" x="0" y="0" width="1000" height="700" preserveAspectRatio="xMidYMid meet"/>
  <defs>
    <pattern id="wm" width="420" height="180" patternUnits="userSpaceOnUse" patternTransform="rotate(-24)">
      <text x="0" y="60" font-family="monospace" font-size="15" fill="#c96a3d" fill-opacity="0.34">${escaped}</text>
    </pattern>
  </defs>
  <rect width="1000" height="700" fill="url(#wm)"/>
</svg>`;
}

/**
 * Documents live in S3 behind `/images/:filename` on bond-srv. In the memory
 * driver there is nothing to fetch, so a placeholder is generated instead —
 * which keeps the watermarking and the audit path exercised in local runs.
 */
async function fetchDocumentBuffer(url) {
    if (process.env.ADMIN_DATA_DRIVER !== 'dynamodb') {
        const placeholder = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700">
  <rect width="1000" height="700" fill="#e6d5c3"/>
  <text x="500" y="330" text-anchor="middle" font-family="sans-serif" font-size="30" fill="#4a4543">Demo KYC document</text>
  <text x="500" y="375" text-anchor="middle" font-family="monospace" font-size="16" fill="#8b7f76">${url}</text>
</svg>`;
        return { buffer: Buffer.from(placeholder), contentType: 'image/svg+xml' };
    }
    const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
    const s3 = new S3Client({ region: process.env.AWS_REGION });
    const key = `kyc/${url.split('/images/').pop()}`;
    const obj = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: key }));
    const chunks = [];
    for await (const chunk of obj.Body) chunks.push(chunk);
    return { buffer: Buffer.concat(chunks), contentType: obj.ContentType || 'image/jpeg' };
}

async function fetchDocument(url) {
    const { buffer, contentType } = await fetchDocumentBuffer(url);
    const { Readable } = require('stream');
    return { stream: Readable.from(buffer), contentType };
}

// ─── Decisions ───────────────────────────────────────────────────────────────

async function loadDecidable(submissionId) {
    const submission = await store.get(TABLES.KYC_SUBMISSIONS, submissionId);
    if (!submission) return { error: { status: 404, message: 'Submission not found' } };
    if (!ACTIVE_STATUSES.includes(submission.status)) {
        return {
            error: {
                status: 409,
                message: `This submission is already ${submission.status} and cannot be decided again (K-12)`,
            },
        };
    }
    return { submission };
}

// POST /admin/kyc/:submissionId/approve
exports.approve = async (req, res, next) => {
    try {
        const { submission, error } = await loadDecidable(req.params.submissionId);
        if (error) return res.status(error.status).json({ success: false, message: error.message });

        const check = ageCheck(submission);
        // An underage or indeterminate applicant can only be approved with an
        // explicit override and a written justification. The reviewer has to say
        // out loud that they are doing it.
        if (!check.passes && req.body?.ageOverrideJustification == null) {
            return res.status(400).json({
                success: false,
                code: 'AGE_CHECK_FAILED',
                message: check.indeterminate
                    ? 'Date of birth could not be read from the document — approval requires ageOverrideJustification'
                    : `Applicant computes as ${check.documentAge}, below the minimum of ${KYC.MIN_AGE}`,
                ageCheck: check,
            });
        }

        const now = new Date().toISOString();
        const decision = {
            outcome: 'approved',
            by: req.admin.adminId,
            byEmail: req.admin.email,
            at: now,
            note: req.body?.note ?? null,
            ageOverrideJustification: req.body?.ageOverrideJustification ?? null,
        };

        const updated = await store.patch(
            TABLES.KYC_SUBMISSIONS,
            submission.submissionId,
            { status: 'approved', decision, decidedAt: now },
            { expectedVersion: req.expectedVersion }
        );

        // Mirror the outcome onto the companion record the consumer app reads.
        await store.patch(TABLES.COMPANIONS, submission.userId, {
            isKycVerified: true,
            kycStatus: 'approved',
            kycReviewedAt: now,
            kycSubmissionId: submission.submissionId,
        });

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.KYC_APPROVED,
            targetType: 'kyc_submission',
            targetId: submission.submissionId,
            reason: req.body?.note ?? 'KYC approved',
            before: { status: submission.status },
            after: { status: 'approved' },
            metadata: {
                userId: submission.userId,
                ageCheck: check,
                ageOverride: !!req.body?.ageOverrideJustification,
            },
            request: req,
        });

        // K-11 — the companion hears the decision immediately.
        await notifyUser({
            userId: submission.userId,
            channel: 'kyc',
            title: 'Your verification was approved',
            body: 'You are verified and can start accepting bookings.',
            relatedType: 'kyc_submission',
            relatedId: submission.submissionId,
        });

        return res.json({ success: true, data: updated });
    } catch (err) {
        if (err instanceof ConflictError) {
            return res.status(409).json({
                success: false,
                code: 'VERSION_CONFLICT',
                message: 'Another admin actioned this submission while you had it open',
            });
        }
        return next(err);
    }
};

// POST /admin/kyc/:submissionId/reject
exports.reject = async (req, res, next) => {
    try {
        const { submission, error } = await loadDecidable(req.params.submissionId);
        if (error) return res.status(error.status).json({ success: false, message: error.message });

        const { reasonCode, note } = req.body;
        const reason = KYC_REJECTION_REASONS.find((r) => r.id === reasonCode);
        const now = new Date().toISOString();

        const history = await attemptHistory(submission.userId);
        const priorRejections = history.filter((h) => h.status === 'rejected').length;
        const rejectionsAfterThis = priorRejections + 1;

        // K-09 — three strikes moves the account to manual review, it does not
        // hard-block. A lighting problem should not cost Hive a companion.
        const nextStatus =
            rejectionsAfterThis >= KYC.MANUAL_REVIEW_AFTER_REJECTIONS ? 'manual_review' : 'rejected';

        const decision = {
            outcome: 'rejected',
            reasonCode,
            reasonLabel: reason.label,
            note: note ?? null, // K-08 — optional free text alongside the fixed code
            by: req.admin.adminId,
            byEmail: req.admin.email,
            at: now,
        };

        const updated = await store.patch(
            TABLES.KYC_SUBMISSIONS,
            submission.submissionId,
            { status: nextStatus, decision, decidedAt: now },
            { expectedVersion: req.expectedVersion }
        );

        await store.patch(TABLES.COMPANIONS, submission.userId, {
            isKycVerified: false,
            kycStatus: nextStatus === 'manual_review' ? 'manual_review' : 'rejected',
            kycReviewedAt: now,
            kycNote: reason.label,
        });

        await audit.record({
            actor: req.admin,
            action: nextStatus === 'manual_review' ? audit.ACTIONS.KYC_MANUAL_REVIEW : audit.ACTIONS.KYC_REJECTED,
            targetType: 'kyc_submission',
            targetId: submission.submissionId,
            reason: note ? `${reason.label} — ${note}` : reason.label,
            reasonCode,
            before: { status: submission.status },
            after: { status: nextStatus },
            metadata: { userId: submission.userId, rejectionCount: rejectionsAfterThis },
            request: req,
        });

        await notifyUser({
            userId: submission.userId,
            channel: 'kyc',
            title: nextStatus === 'manual_review'
                ? 'Your verification needs a manual review'
                : 'Your verification could not be approved',
            body: nextStatus === 'manual_review'
                ? `Reason: ${reason.label}. Our team will review your submission personally and get back to you.`
                : `Reason: ${reason.label}. You can submit again with a corrected document.`,
            relatedType: 'kyc_submission',
            relatedId: submission.submissionId,
        });

        return res.json({
            success: true,
            data: updated,
            movedToManualReview: nextStatus === 'manual_review',
        });
    } catch (err) {
        if (err instanceof ConflictError) {
            return res.status(409).json({ success: false, code: 'VERSION_CONFLICT', message: 'Actioned by another admin' });
        }
        return next(err);
    }
};

// POST /admin/kyc/:submissionId/request-resubmission
exports.requestResubmission = async (req, res, next) => {
    try {
        const { submission, error } = await loadDecidable(req.params.submissionId);
        if (error) return res.status(error.status).json({ success: false, message: error.message });

        const { reasonCode, note } = req.body;
        const reason = KYC_REJECTION_REASONS.find((r) => r.id === reasonCode);
        const now = new Date().toISOString();

        const history = await attemptHistory(submission.userId);

        // K-10 — up to three submissions inside a rolling seven-day window.
        const windowStart = Date.now() - KYC.RESUBMISSION_WINDOW_DAYS * 86_400_000;
        const inWindow = history.filter((h) => Date.parse(h.submittedAt) > windowStart).length;
        const resubmissionAllowed = inWindow < KYC.MAX_SUBMISSIONS;

        const updated = await store.patch(
            TABLES.KYC_SUBMISSIONS,
            submission.submissionId,
            {
                status: resubmissionAllowed ? 'resubmission_requested' : 'manual_review',
                decision: {
                    outcome: 'resubmission_requested',
                    reasonCode,
                    reasonLabel: reason.label,
                    note: note ?? null,
                    by: req.admin.adminId,
                    byEmail: req.admin.email,
                    at: now,
                },
                decidedAt: now,
                resubmissionDeadline: new Date(
                    Date.parse(history[0]?.submittedAt ?? now) + KYC.RESUBMISSION_WINDOW_DAYS * 86_400_000
                ).toISOString(),
            },
            { expectedVersion: req.expectedVersion }
        );

        await store.patch(TABLES.COMPANIONS, submission.userId, {
            kycStatus: resubmissionAllowed ? 'resubmission_requested' : 'manual_review',
            kycNote: reason.label,
        });

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.KYC_RESUBMISSION_REQUESTED,
            targetType: 'kyc_submission',
            targetId: submission.submissionId,
            reason: note ? `${reason.label} — ${note}` : reason.label,
            reasonCode,
            before: { status: submission.status },
            after: { status: updated.status },
            metadata: { userId: submission.userId, attemptsInWindow: inWindow },
            request: req,
        });

        await notifyUser({
            userId: submission.userId,
            channel: 'kyc',
            title: 'Please resubmit your verification document',
            body: `${reason.label}${note ? ` — ${note}` : ''}. You have ${Math.max(0, KYC.MAX_SUBMISSIONS - inWindow)} attempt(s) left this week.`,
            relatedType: 'kyc_submission',
            relatedId: submission.submissionId,
        });

        return res.json({ success: true, data: updated, attemptsRemaining: Math.max(0, KYC.MAX_SUBMISSIONS - inWindow) });
    } catch (err) {
        if (err instanceof ConflictError) {
            return res.status(409).json({ success: false, code: 'VERSION_CONFLICT', message: 'Actioned by another admin' });
        }
        return next(err);
    }
};

/**
 * K-12 — corrections to an approved record create a new record linked to the one
 * it supersedes. Nothing overwrites a decision that was already made.
 */
exports.correct = async (req, res, next) => {
    try {
        const original = await store.get(TABLES.KYC_SUBMISSIONS, req.params.submissionId);
        if (!original) return res.status(404).json({ success: false, message: 'Submission not found' });
        if (original.status !== 'approved') {
            return res.status(400).json({ success: false, message: 'Only an approved record needs superseding' });
        }
        if (original.supersededBy) {
            return res.status(409).json({ success: false, message: 'This record has already been superseded' });
        }

        const { extracted, note } = req.body ?? {};
        if (!note) return res.status(400).json({ success: false, message: 'A note explaining the correction is required' });

        const now = new Date().toISOString();
        const replacement = {
            ...original,
            submissionId: randomId('kyc'),
            version: 1,
            status: 'pending',
            decision: null,
            decidedAt: null,
            extracted: { ...original.extracted, ...(extracted ?? {}) },
            idNumberHash: extracted?.idNumber ? hashIdentifier(extracted.idNumber) : original.idNumberHash,
            supersedes: original.submissionId,
            correctionNote: note,
            submittedAt: now,
            attemptNumber: (original.attemptNumber ?? 1),
        };
        await store.put(TABLES.KYC_SUBMISSIONS, replacement);
        await store.patch(TABLES.KYC_SUBMISSIONS, original.submissionId, { supersededBy: replacement.submissionId });

        await audit.record({
            actor: req.admin,
            action: audit.ACTIONS.KYC_MANUAL_REVIEW,
            targetType: 'kyc_submission',
            targetId: replacement.submissionId,
            reason: `Correction of ${original.submissionId}: ${note}`,
            before: { extracted: original.extracted },
            after: { extracted: replacement.extracted },
            metadata: { supersedes: original.submissionId },
            request: req,
        });

        return res.status(201).json({ success: true, data: replacement });
    } catch (err) {
        return next(err);
    }
};

exports.reasons = (_req, res) => res.json({ success: true, data: KYC_REJECTION_REASONS });
