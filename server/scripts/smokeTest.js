/**
 * End-to-end smoke test against the in-memory driver.
 *
 * Covers the paths where a regression would be silent and expensive: the 2FA
 * gate, the RBAC matrix, PII masking for Support, the fixed reason lists, the
 * age check, optimistic locking, dual approval, SLA computation, and the
 * append-only guarantee on the audit log.
 *
 *   npm test
 */

require('dotenv').config();
if (!process.env.ADMIN_JWT_SECRET) {
    process.env.ADMIN_JWT_SECRET = 'dev-only-admin-key-4f8b2e9d7a1c6350-local-run-do-not-ship';
}

// These tests assert AR-05 in its real form, so the demo bypass is forced off
// regardless of what .env says. A test suite that passes because a security
// control was disabled is worse than no test suite.
//
// Set rather than deleted: index.js calls dotenv.config() again on require, which
// would re-inject the value from .env. dotenv does not overwrite a variable that
// is already set, so an explicit '0' survives.
process.env.ADMIN_DEMO_SKIP_MFA = '0';

const http = require('http');
const { app } = require('../index');
const { seed } = require('../lib/seed');
const { totpCodeAt } = require('../lib/crypto');
const { store, TABLES } = require('../lib/store');

let baseUrl;
let passed = 0;
let failed = 0;

function call(path, { token, method = 'GET', body } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = http.request(`${baseUrl}${path}`, {
            method,
            headers: {
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
            },
        }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(raw); } catch { /* non-JSON body (csv, svg) */ }
                resolve({ status: res.statusCode, json, raw });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function check(name, condition, detail = '') {
    if (condition) {
        passed++;
        console.log(`  ✓ ${name}`);
    } else {
        failed++;
        console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

function section(title) {
    console.log(`\n${title}`);
}

async function signIn(email, password, secret) {
    const login = await call('/admin/auth/login', { method: 'POST', body: { email, password } });
    if (login.json?.stage !== 'mfa') return { error: login };
    const code = totpCodeAt(secret, Math.floor(Date.now() / 1000 / 30));
    const mfa = await call('/admin/auth/mfa', {
        method: 'POST',
        body: { challengeToken: login.json.challengeToken, code },
    });
    return { login, mfa, token: mfa.json?.token };
}

(async () => {
    const seeded = await seed();
    const secret = seeded.demoTotpSecret;
    const password = 'HiveAdmin!2026#Ops';

    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    // ── Authentication (AR-05) ───────────────────────────────────────────────
    section('Auth');

    const noMfa = await call('/admin/auth/login', { method: 'POST', body: { email: 'naveen@tryhive.in', password } });
    check('Password alone returns a challenge, never a session token',
        noMfa.json?.stage === 'mfa' && !noMfa.json?.token);

    const badPassword = await call('/admin/auth/login', { method: 'POST', body: { email: 'naveen@tryhive.in', password: 'wrong' } });
    check('Wrong password is rejected', badPassword.status === 401);

    const badMfa = await call('/admin/auth/mfa', {
        method: 'POST',
        body: { challengeToken: noMfa.json.challengeToken, code: '000000' },
    });
    check('Wrong TOTP code is rejected', badMfa.status === 401);

    // The demo bypass exists; these assert it cannot reach anything real.
    const authController = require('../controllers/authController');
    const withEnv = (env, fn) => {
        const saved = { ...process.env };
        Object.assign(process.env, env);
        try { return fn(); } finally { process.env = saved; }
    };
    check('Demo 2FA bypass is inert unless explicitly enabled',
        !authController.demoBypassActive());
    check('Demo 2FA bypass is inert against the DynamoDB driver',
        withEnv({ ADMIN_DEMO_SKIP_MFA: '1', ADMIN_DATA_DRIVER: 'dynamodb' }, () => !authController.demoBypassActive()));
    check('Demo 2FA bypass is inert in production',
        withEnv({ ADMIN_DEMO_SKIP_MFA: '1', NODE_ENV: 'production' }, () => !authController.demoBypassActive()));
    check('Server refuses to boot with the bypass set against real data', withEnv(
        { ADMIN_DEMO_SKIP_MFA: '1', ADMIN_DATA_DRIVER: 'dynamodb' },
        () => { try { authController.assertDemoBypassIsSafe(); return false; } catch { return true; } }
    ));
    check('Server refuses to boot with the bypass set in production', withEnv(
        { ADMIN_DEMO_SKIP_MFA: '1', NODE_ENV: 'production' },
        () => { try { authController.assertDemoBypassIsSafe(); return false; } catch { return true; } }
    ));

    const superAdmin = await signIn('naveen@tryhive.in', password, secret);
    check('Password + valid TOTP issues a session', !!superAdmin.token);
    check('Session carries the 8-hour absolute expiry',
        superAdmin.mfa.json.expiresAt && Date.parse(superAdmin.mfa.json.expiresAt) - Date.now() <= 8 * 3_600_000 + 5000);

    const ops = await signIn('ops@tryhive.in', password, secret);
    const support = await signIn('support@tryhive.in', password, secret);
    const finance = await signIn('finance@tryhive.in', password, secret);
    const readonly = await signIn('readonly@tryhive.in', password, secret);
    check('All five roles can sign in', [ops, support, finance, readonly].every((r) => !!r.token));

    // ── RBAC (§4) ────────────────────────────────────────────────────────────
    section('RBAC');

    const readonlyKyc = await call('/admin/kyc/queue', { token: readonly.token });
    check('Read-only cannot see the KYC queue', readonlyKyc.status === 403);

    const readonlyDash = await call('/admin/dashboard', { token: readonly.token });
    check('Read-only can see the dashboard', readonlyDash.status === 200);

    const supportPayouts = await call('/admin/finance/payouts', { token: support.token });
    check('Support cannot see payouts', supportPayouts.status === 403);

    const financeKyc = await call('/admin/kyc/queue', { token: finance.token });
    check('Finance cannot decide KYC', financeKyc.status === 403);

    const opsAdmins = await call('/admin/admins', { token: ops.token });
    check('Ops cannot list admin accounts', opsAdmins.status === 403);

    const superAdmins = await call('/admin/admins', { token: superAdmin.token });
    check('Super Admin can list admin accounts', superAdmins.status === 200);

    // ── PII masking (§4) ─────────────────────────────────────────────────────
    section('PII masking');

    const supportUsers = await call('/admin/users?q=aarav', { token: support.token });
    const supportRow = supportUsers.json?.data?.[0];
    check('Support sees masked contact details',
        supportRow && supportRow.phone?.includes('•') && supportRow._masked?.includes('phone'),
        JSON.stringify(supportRow));

    const opsUsers = await call('/admin/users?q=aarav', { token: ops.token });
    check('Ops sees real contact details',
        opsUsers.json?.data?.[0]?.phone === '+919812345001');

    const noReason = await call('/admin/pii/unmask', {
        token: support.token, method: 'POST',
        body: { recordType: 'user', recordId: 'phone_+919812345001', fields: ['phone'] },
    });
    check('Unmask without a reason is refused', noReason.status === 400 && noReason.json?.code === 'INVALID_REASON');

    const wildcard = await call('/admin/pii/unmask', {
        token: support.token, method: 'POST',
        body: { recordType: 'user', recordId: 'phone_+919812345001', fields: ['*'], reasonCode: 'user_support_request' },
    });
    check('Wildcard unmask is refused (P-03)', wildcard.status === 400);

    const unmask = await call('/admin/pii/unmask', {
        token: support.token, method: 'POST',
        body: { recordType: 'user', recordId: 'phone_+919812345001', fields: ['phone'], reasonCode: 'user_support_request' },
    });
    check('Unmask with a valid reason returns the value',
        unmask.status === 200 && unmask.json.data.values.phone === '+919812345001');

    const afterGrant = await call('/admin/users?q=aarav', { token: support.token });
    check('The grant applies to that record only',
        afterGrant.json?.data?.[0]?.phone === '+919812345001');

    const otherRecordStillMasked = await call('/admin/users?q=diya', { token: support.token });
    check('A grant on one record does not unmask another',
        otherRecordStillMasked.json?.data?.[0]?.phone?.includes('•'));

    const readonlyUnmask = await call('/admin/pii/unmask', {
        token: readonly.token, method: 'POST',
        body: { recordType: 'user', recordId: 'phone_+919812345001', fields: ['phone'], reasonCode: 'user_support_request' },
    });
    check('Read-only cannot unmask anything', readonlyUnmask.status === 403);

    // ── KYC (§5) ─────────────────────────────────────────────────────────────
    section('KYC');

    const queue = await call('/admin/kyc/queue', { token: ops.token });
    const items = queue.json.data;
    check('Queue is sorted oldest first (K-01)',
        items.length > 1 && items[0].submittedAt <= items[1].submittedAt);
    check('Time in queue is shown (K-01)', typeof items[0].hoursInQueue === 'number');
    check('Attempt count is shown (K-05)', typeof items[0].attemptNumber === 'number');

    const underage = items.find((i) => !i.ageCheck.passes && i.ageCheck.documentAge < 18);
    check('Age check flags the underage applicant (K-03)', !!underage, JSON.stringify(items.map((i) => i.ageCheck)));

    const dupes = items.filter((i) => i.duplicateCount > 0);
    check('Duplicate ID detection fires on the shared PAN (K-04)', dupes.length === 2, `found ${dupes.length}`);

    const underageDetail = await call(`/admin/kyc/${underage.submissionId}`, { token: ops.token });
    check('Detail shows the document/profile comparison (K-02)',
        !!underageDetail.json.data.comparison?.name && !!underageDetail.json.data.comparison?.dob);
    check('Raw document URLs are never returned',
        underageDetail.json.data.kycDocumentUrl === undefined);

    const approveUnderage = await call(`/admin/kyc/${underage.submissionId}/approve`, {
        token: ops.token, method: 'POST', body: { expectedVersion: underage.version },
    });
    check('Approving an underage applicant is blocked (K-03)',
        approveUnderage.status === 400 && approveUnderage.json.code === 'AGE_CHECK_FAILED');

    const freeTextReject = await call(`/admin/kyc/${underage.submissionId}/reject`, {
        token: ops.token, method: 'POST',
        body: { reason: 'looks too young', expectedVersion: underage.version },
    });
    check('Rejection without a fixed reason code is refused (K-07)',
        freeTextReject.status === 400 && freeTextReject.json.code === 'INVALID_REASON');

    const rejected = await call(`/admin/kyc/${underage.submissionId}/reject`, {
        token: ops.token, method: 'POST',
        body: { reasonCode: 'underage', note: 'DOB on document is 2009.', expectedVersion: underage.version },
    });
    check('Rejection with a fixed reason succeeds', rejected.status === 200);

    const staleReject = await call(`/admin/kyc/${underage.submissionId}/reject`, {
        token: ops.token, method: 'POST',
        body: { reasonCode: 'underage', expectedVersion: underage.version },
    });
    check('Deciding twice is refused (K-12 / §12 concurrency)', staleReject.status === 409);

    // K-09 — a third rejection moves the account to manual review
    const diya = items.find((i) => i.rejectionCount === 2);
    if (diya) {
        const third = await call(`/admin/kyc/${diya.submissionId}/reject`, {
            token: ops.token, method: 'POST',
            body: { reasonCode: 'name_mismatch', expectedVersion: diya.version },
        });
        check('Third rejection moves the account to manual review, not a hard block (K-09)',
            third.json?.movedToManualReview === true);
    } else {
        check('Third rejection moves the account to manual review (K-09)', false, 'fixture missing');
    }

    const doc = await call(`/admin/kyc/${items[1].submissionId}/document/gov-id`, { token: ops.token });
    check('Document preview is watermarked server-side (P-04)',
        doc.raw.includes('<svg') && doc.raw.includes('ops@tryhive.in'));

    const supportDownload = await call(`/admin/kyc/${items[1].submissionId}/document/gov-id?download=1`, { token: support.token });
    check('Support cannot reach documents at all', supportDownload.status === 403);

    // ── Moderation (§6.1) ────────────────────────────────────────────────────
    section('Moderation');

    const modQueue = await call('/admin/moderation', { token: ops.token });
    const edit = modQueue.json.data.find((i) => i.type === 'profile_edit');
    check('Edited profiles re-enter the approval queue (M-02)', !!edit);

    const editDetail = await call(`/admin/moderation/${edit.itemId}`, { token: ops.token });
    check('Diff shows only the changed fields (M-03)',
        editDetail.json.data.diff.some((d) => d.field === 'bio' && d.changed));
    check('Previous approved version stays live while pending (M-04)',
        editDetail.json.data.liveVersionRemainsPublished === true);

    const escalatingReject = await call(`/admin/moderation/${edit.itemId}/reject`, {
        token: ops.token, method: 'POST',
        body: { reasonCode: 'sexual_solicitation', note: 'Bio advertises private paid sessions.', expectedVersion: edit.version },
    });
    check('Solicitation rejection escalates automatically (M-06)', escalatingReject.json?.escalated === true);

    const companionAfter = await store.get(TABLES.COMPANIONS, edit.userId);
    check('Rejected edit never touched the live profile (M-04)',
        !companionAfter.bio.includes('telegram'));

    // ── Reports (§6.2) ───────────────────────────────────────────────────────
    section('Reports');

    const reportQueue = await call('/admin/reports', { token: ops.token });
    const report = reportQueue.json.data[0];
    check('Reports are ordered by severity then age', report.severity === 'high');

    const reportDetail = await call(`/admin/reports/${report.reportId}`, { token: ops.token });
    check('Reporter identity is flagged as non-disclosable (M-09)',
        reportDetail.json.data.reporterIdentityDisclosable === false);
    check('Prior report history is on the ticket (M-12)',
        Array.isArray(reportDetail.json.data.history));

    const noReasonAction = await call(`/admin/reports/${report.reportId}/act`, {
        token: ops.token, method: 'POST',
        body: { actionId: 'temp_suspension', suspensionDays: 7, expectedVersion: report.version },
    });
    check('Enforcement without a reason is refused (M-11)', noReasonAction.status === 400);

    const acted = await call(`/admin/reports/${report.reportId}/act`, {
        token: ops.token, method: 'POST',
        body: {
            actionId: 'temp_suspension', suspensionDays: 7,
            note: 'Solicitation confirmed against the chat transcript and profile bio.',
            expectedVersion: report.version,
        },
    });
    check('Enforcement with a reason succeeds (M-10)', acted.status === 200);

    const suspendedUser = await store.get(TABLES.USERS, report.reportedUserId);
    check('Suspension is carried into the user record', suspendedUser.accountStatus === 'suspended');

    // ── Grievance SLA (§6.3) ─────────────────────────────────────────────────
    section('Grievance SLA');

    const grv = await call('/admin/grievances', { token: ops.token });
    check('Every grievance is acknowledged automatically (G-02)',
        grv.json.data.every((g) => !!g.acknowledgedAt));
    check('Acknowledgement and resolution both carry countdowns (G-03)',
        grv.json.data.every((g) => g.sla.acknowledgement.deadline && g.sla.resolution.deadline));

    const breached = grv.json.data.find((g) => g.sla.urgentAction?.state === 'breached');
    check('A breached urgent-track clock is visible (G-04, G-05)', !!breached);

    const filteredOut = await call('/admin/grievances?category=payment_complaint', { token: ops.token });
    check('Urgent tickets cannot be filtered out of view (G-06)',
        filteredOut.json.data.some((g) => g.isUrgent && g.pinnedByUrgency));

    const unassignedFlag = grv.json.data.find((g) => g.sla.assignment.state === 'breached');
    check('Unassigned tickets are flagged after 4h (G-07)', !!unassignedFlag);

    const postal = grv.json.data.find((g) => g.channel === 'postal');
    check('Postal grievance SLA runs from physical receipt, not entry (§12)',
        postal && Date.parse(postal.receivedAt) < Date.parse(postal.enteredAt));

    const shortReasoning = await call(`/admin/grievances/${grv.json.data[0].grievanceId}/resolve`, {
        token: ops.token, method: 'POST',
        body: { outcome: 'upheld', reasoning: 'done', expectedVersion: grv.json.data[0].version },
    });
    check('Resolution without recorded reasoning is refused (G-08)',
        shortReasoning.status === 400 && shortReasoning.json.code === 'REASONING_REQUIRED');

    const target = grv.json.data.find((g) => !g.resolvedAt);
    const resolved = await call(`/admin/grievances/${target.grievanceId}/resolve`, {
        token: ops.token, method: 'POST',
        body: {
            outcome: 'upheld',
            reasoning: 'The image was removed within four hours of receipt and the account has been suspended pending review.',
            expectedVersion: target.version,
        },
    });
    check('Resolution with reasoning succeeds (G-08)', resolved.status === 200);
    check('Appeal window opens on resolution (G-10)', resolved.json.data.sla.appeal.open === true);

    const exported = await call(`/admin/grievances/export?from=2020-01-01&to=2030-01-01`, { token: ops.token });
    check('Grievance export returns the full compliance record (G-11)',
        exported.status === 200 && exported.json.data.length >= 5 &&
        'acknowledgementMet' in exported.json.data[0] && 'resolutionMet' in exported.json.data[0]);

    const supportExport = await call(`/admin/grievances/export?from=2020-01-01&to=2030-01-01`, { token: support.token });
    check('Support cannot export grievance data', supportExport.status === 403);

    // ── Bookings and disputes (§7) ───────────────────────────────────────────
    section('Bookings');

    const bookingDetail = await call('/admin/bookings/bkg_demo_1', { token: ops.token });
    check('Booking timeline shows every stage with timestamps (B-02)',
        bookingDetail.json.data.timeline.length >= 5 &&
        bookingDetail.json.data.timeline.every((s) => 'reached' in s));

    const forceNoReason = await call('/admin/bookings/bkg_demo_4/force-complete', {
        token: ops.token, method: 'POST', body: { expectedVersion: 1 },
    });
    check('Force-complete without a reason is refused (B-03)', forceNoReason.status === 400);

    const forced = await call('/admin/bookings/bkg_demo_4/force-complete', {
        token: ops.token, method: 'POST',
        body: { reasonCode: 'checkin_failure', note: 'GPS failed; both parties confirmed by phone.', expectedVersion: 1 },
    });
    check('Force-complete with a reason succeeds (B-03)', forced.status === 200);

    const disputes = await call('/admin/bookings/disputes', { token: ops.token });
    check('Dispute queue shows the 24-hour window state (B-08)',
        disputes.json.data.every((d) => !!d.window?.state));
    check('A block during an active booking sorts to the top as a distress signal (B-09)',
        disputes.json.data[0].blockSignal === true);

    // ── Finance (§8) ─────────────────────────────────────────────────────────
    section('Finance');

    const payouts = await call('/admin/finance/payouts', { token: finance.token });
    check('Payout queue covers all states (F-01)',
        ['requested', 'failed', 'held', 'paid'].every((s) => payouts.json.data.some((p) => p.status === s)));
    check('Failed payout carries the gateway error (F-04)',
        payouts.json.data.find((p) => p.status === 'failed')?.gatewayError?.includes('BENEFICIARY'));
    check('Shared bank account is flagged as a mule signal (F-07)',
        payouts.json.meta.muleFlagged >= 2, `flagged ${payouts.json.meta.muleFlagged}`);
    check('Bank-change cooling-off is surfaced (F-06)',
        payouts.json.data.some((p) => p.coolingOff?.active));

    const coolingOffPayout = payouts.json.data.find((p) => p.coolingOff?.active && p.status === 'held');
    if (coolingOffPayout) {
        const blockedRelease = await call(`/admin/finance/payouts/${coolingOffPayout.payoutId}/release`, {
            token: finance.token, method: 'POST',
            body: { note: 'Reviewed and cleared by the fraud team.', expectedVersion: coolingOffPayout.version },
        });
        check('Release inside the cooling-off window is blocked (F-06)',
            blockedRelease.status === 409 && blockedRelease.json.code === 'COOLING_OFF_ACTIVE');
    }

    const heldPayout = payouts.json.data.find((p) => p.status === 'held' && !p.coolingOff?.active);
    const released = await call(`/admin/finance/payouts/${heldPayout.payoutId}/release`, {
        token: finance.token, method: 'POST',
        body: { note: 'Fraud review closed — the second profile was a duplicate registration, now removed.', expectedVersion: heldPayout.version },
    });
    check('Held payout can be released with a reason (F-03)', released.status === 200);

    const recon = await call('/admin/finance/reconciliation', { token: finance.token });
    check('Reconciliation flags gateway/ledger discrepancies (F-08)',
        recon.json.meta.discrepancies >= 2, `found ${recon.json.meta.discrepancies}`);
    check('Failed-after-paid is detected (§12)',
        recon.json.data.some((r) => r.discrepancy?.type === 'failed_after_paid'));

    const refunds = await call('/admin/finance/refunds', { token: finance.token });
    const bigRefund = refunds.json.data.find((r) => r.amount > 500000);
    const selfApprove = await call(`/admin/finance/refunds/${bigRefund.refundId}/approve`, {
        token: finance.token, method: 'POST', body: { expectedVersion: bigRefund.version },
    });
    check('The requester cannot approve their own large refund (F-10)',
        selfApprove.status === 403 && selfApprove.json.code === 'DUAL_APPROVAL_SAME_ADMIN');

    const secondApprove = await call(`/admin/finance/refunds/${bigRefund.refundId}/approve`, {
        token: superAdmin.token, method: 'POST',
        body: { note: 'Confirmed against the no-show report.', expectedVersion: bigRefund.version },
    });
    check('A second admin can approve it (F-10)', secondApprove.status === 200);

    const overGoodwill = await call('/admin/finance/goodwill', {
        token: support.token, method: 'POST',
        body: { userId: 'phone_+919812345006', amount: 200000, note: 'Sorry about the delay' },
    });
    check('Support goodwill is capped (F-12)', overGoodwill.status === 403 && overGoodwill.json.code === 'GOODWILL_LIMIT');

    const okGoodwill = await call('/admin/finance/goodwill', {
        token: support.token, method: 'POST',
        body: { userId: 'phone_+919812345006', amount: 20000, note: 'Booking cancelled at short notice.' },
    });
    check('Support goodwill under the cap succeeds (F-12)', okGoodwill.status === 201);

    const taxStatus = await call('/admin/tax/status', { token: finance.token });
    check('Tax module reports itself as gated (§8.3)', taxStatus.json.enabled === false);
    const taxAttempt = await call('/admin/tax/form16a', { token: finance.token });
    check('Tax endpoints return 501 with the blocking dependency', taxAttempt.status === 501);

    // ── Users and deletion (§9) ──────────────────────────────────────────────
    section('Users');

    const deletions = await call('/admin/users/deletions', { token: ops.token });
    check('Deletion queue shows blockers (U-06)',
        deletions.json.data.some((d) => d.blocked && d.blockers.length > 0));

    const blockedRequest = deletions.json.data.find((d) => d.blocked);
    const blockedProcess = await call(`/admin/users/deletions/${blockedRequest.requestId}/process`, {
        token: ops.token, method: 'POST', body: { note: 'Processing' },
    });
    check('A blocked deletion is deferred, not completed (U-06, §12)',
        blockedProcess.status === 409 && blockedProcess.json.code === 'DELETION_BLOCKED');

    const clearRequest = deletions.json.data.find((d) => !d.blocked);
    if (clearRequest) {
        const detail = await call(`/admin/users/deletions/${clearRequest.requestId}`, { token: ops.token });
        check('Retention plan states a basis per retained item (U-07)',
            detail.json.data.retentionPlan.every((r) => r.action !== 'retain' || !!r.basis));
        const unresolvedProcess = await call(`/admin/users/deletions/${clearRequest.requestId}/process`, {
            token: ops.token, method: 'POST', body: { note: 'Processing' },
        });
        check('Deletion refuses to complete while the KYC retention policy is unresolved (U-07 blocker)',
            unresolvedProcess.status === 409 && unresolvedProcess.json.code === 'RETENTION_POLICY_UNRESOLVED');
    }

    const opsRemove = await call('/admin/users/phone_+919812345007/remove', {
        token: ops.token, method: 'POST', body: { note: 'Repeated guideline violations confirmed.' },
    });
    check('Only Super Admin can permanently remove an account (U-04)', opsRemove.status === 403);

    // ── Audit (§10) ──────────────────────────────────────────────────────────
    section('Audit');

    const auditSearch = await call('/admin/audit?limit=500', { token: superAdmin.token });
    const entries = auditSearch.json.data;
    check('Every action recorded actor, role, timestamp and reason (L-01)',
        entries.filter((e) => e.actorId && e.actorId !== 'system')
            .every((e) => e.actorRole && e.at && (e.reason || e.reasonCode)));

    check('PII unmask is its own audit event (L-04)',
        entries.some((e) => e.action === 'pii.unmasked'));
    check('Document views are logged separately (L-04)',
        entries.some((e) => e.action === 'document.viewed'));
    check('Failed logins and 2FA failures are logged (L-05)',
        entries.some((e) => e.action === 'auth.login.failed') &&
        entries.some((e) => e.action === 'auth.mfa.failed'));

    const chain = await call('/admin/audit/verify', { token: superAdmin.token });
    check('Audit chain verifies intact (L-02)', chain.json.data.intact === true);

    // L-02 the hard way: the store refuses updates to the audit table outright.
    let appendOnlyHeld = false;
    try {
        await store.patch(TABLES.AUDIT_LOG, entries[0].eventId, { reason: 'tampered' });
    } catch (err) {
        appendOnlyHeld = err.code === 'APPEND_ONLY';
    }
    check('Audit entries cannot be edited, even from inside the process (L-02)', appendOnlyHeld);

    let deleteRefused = false;
    try {
        await store.remove(TABLES.AUDIT_LOG, entries[0].eventId);
    } catch (err) {
        deleteRefused = err.code === 'APPEND_ONLY';
    }
    check('Audit entries cannot be deleted (L-02)', deleteRefused);

    const opsAudit = await call('/admin/audit/verify', { token: ops.token });
    check('Chain verification is Super Admin only', opsAudit.status === 403);

    const anomalies = await call('/admin/audit/anomalies', { token: superAdmin.token });
    check('Anomaly detection runs (L-07)', anomalies.status === 200 && Array.isArray(anomalies.json.data));

    // ── Sessions and account management (§3, §12) ────────────────────────────
    section('Sessions');

    const created = await call('/admin/admins', {
        token: superAdmin.token, method: 'POST',
        body: { email: 'newops@tryhive.in', name: 'New Ops', role: 'ops' },
    });
    check('Super Admin can create an admin account (AR-06)', created.status === 201);
    check('New account starts pending enrolment — 2FA before access (AR-05)',
        created.json.data.status === 'pending_enrolment');

    const selfReset = await call(`/admin/admins/${superAdmin.mfa.json.admin.adminId}/reset-mfa`, {
        token: superAdmin.token, method: 'POST', body: { reason: 'Lost my phone' },
    });
    check('A Super Admin cannot reset their own 2FA — a second one must (§12)',
        selfReset.status === 403 && selfReset.json.code === 'SELF_MFA_RESET');

    const revoke = await call(`/admin/admins/${ops.mfa.json.admin.adminId}/revoke-sessions`, {
        token: superAdmin.token, method: 'POST', body: { reason: 'Laptop reported stolen' },
    });
    check('Super Admin can revoke every session for an admin (§12)', revoke.json?.sessionsRevoked >= 1);

    const afterRevoke = await call('/admin/kyc/queue', { token: ops.token });
    check('A revoked session stops working immediately',
        afterRevoke.status === 401 && afterRevoke.json.code === 'SESSION_REVOKED');

    // Demote-the-last-Super-Admin guard
    const supers = await store.list(TABLES.ADMIN_USERS, { filter: (a) => a.role === 'super_admin' && a.status !== 'disabled' });
    for (const s of supers.slice(1)) {
        await store.patch(TABLES.ADMIN_USERS, s.adminId, { role: 'ops' });
    }
    const demoteLast = await call(`/admin/admins/${supers[0].adminId}/role`, {
        token: superAdmin.token, method: 'PATCH', body: { role: 'ops', reason: 'test' },
    });
    check('The last Super Admin cannot be demoted (break-glass guard)',
        demoteLast.status === 409 && demoteLast.json.code === 'LAST_SUPER_ADMIN');

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log(`\n${passed} passed, ${failed} failed`);
    server.close();
    process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
