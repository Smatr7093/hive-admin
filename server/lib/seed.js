/**
 * Demo data for the in-memory driver.
 *
 * This is what makes the console runnable and pen-testable without an AWS
 * account. Every fixture is shaped like the real thing — the same item shapes
 * DynamoDB holds — so screens built against it work unchanged in prod.
 *
 * Deliberately includes the awkward cases rather than only happy paths: an
 * underage applicant, a duplicate ID, a fourth KYC attempt, a breached
 * grievance, an NCII report inside its 24-hour window, a shared bank account
 * across two profiles, a reconciliation discrepancy, and a deletion request
 * blocked by an open payout. If a queue cannot render those, it is not finished.
 */

const { store, TABLES } = require('./store');
const { hashPassword, hashIdentifier, hashBankAccount, randomId, generateTotpSecret } = require('./crypto');
const { ROLES } = require('../config/constants');
const audit = require('./audit');

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const HOUR = 3_600_000;
const DAY = 86_400_000;

const DEFAULT_DEMO_PASSWORD = 'HiveAdmin!2026#Ops';

async function seed({
    // Read from the environment, not just the call site. Anything hosted where a
    // team can reach it must be able to move off the password published in the
    // README, and the only lever a deploy platform has is an env var.
    superAdminPassword = process.env.ADMIN_SEED_PASSWORD || DEFAULT_DEMO_PASSWORD,
} = {}) {
    // ─── Admin accounts ──────────────────────────────────────────────────────
    // Every demo admin ships with the same TOTP secret so one authenticator
    // entry covers all of them. Obviously never do this anywhere real.
    const demoSecret = process.env.ADMIN_DEMO_TOTP_SECRET || generateTotpSecret();

    const admins = [
        { adminId: 'adm_super', email: 'naveen@tryhive.in', name: 'Naveen', role: ROLES.SUPER_ADMIN },
        { adminId: 'adm_super2', email: 'grievance@tryhive.in', name: 'Grievance Officer', role: ROLES.SUPER_ADMIN },
        { adminId: 'adm_ops', email: 'ops@tryhive.in', name: 'Priya (Ops)', role: ROLES.OPS },
        { adminId: 'adm_support', email: 'support@tryhive.in', name: 'Rahul (Support)', role: ROLES.SUPPORT },
        { adminId: 'adm_finance', email: 'finance@tryhive.in', name: 'Meera (Finance)', role: ROLES.FINANCE },
        { adminId: 'adm_readonly', email: 'readonly@tryhive.in', name: 'Auditor', role: ROLES.READ_ONLY },
    ];

    for (const a of admins) {
        await store.put(TABLES.ADMIN_USERS, {
            ...a,
            status: 'active',
            passwordHash: hashPassword(superAdminPassword),
            totpSecret: demoSecret,
            createdAt: iso(90 * DAY),
            createdBy: 'bootstrap',
            failedLogins: 0,
            mfaEnrolledAt: iso(90 * DAY),
            recoveryCodeHashes: [],
        });
    }

    // ─── Users and companions ────────────────────────────────────────────────

    const people = [
        { id: 'phone_+919812345001', name: 'Aarav Mehta', phone: '+919812345001', email: 'aarav@example.com', companion: true, dob: '1998-04-12' },
        { id: 'phone_+919812345002', name: 'Diya Sharma', phone: '+919812345002', email: 'diya@example.com', companion: true, dob: '2001-11-03' },
        { id: 'phone_+919812345003', name: 'Kabir Rao', phone: '+919812345003', email: 'kabir@example.com', companion: true, dob: '2009-02-20' }, // underage
        { id: 'phone_+919812345004', name: 'Ishita Nair', phone: '+919812345004', email: 'ishita@example.com', companion: true, dob: '1996-07-30' },
        { id: 'phone_+919812345005', name: 'Vivaan Gupta', phone: '+919812345005', email: 'vivaan@example.com', companion: true, dob: '1999-01-15' },
        { id: 'phone_+919812345006', name: 'Ananya Iyer', phone: '+919812345006', email: 'ananya@example.com', companion: false },
        { id: 'phone_+919812345007', name: 'Rohan Das', phone: '+919812345007', email: 'rohan@example.com', companion: false },
        { id: 'phone_+919812345008', name: 'Sara Khan', phone: '+919812345008', email: 'sara@example.com', companion: false },
        { id: 'google_10293847561', name: 'Neel Verma', phone: '+919812345009', email: 'neel@example.com', companion: false },
        // Verified companion with nothing outstanding — the deletion queue needs
        // at least one request that is genuinely clear to process, otherwise the
        // U-07 retention path is never exercised.
        { id: 'phone_+919812345010', name: 'Tara Bose', phone: '+919812345010', email: 'tara@example.com', companion: true, dob: '1994-09-08' },
    ];

    for (const [i, p] of people.entries()) {
        await store.put(TABLES.USERS, {
            userId: p.id,
            name: p.name,
            phone: p.phone,
            email: p.email,
            authProvider: p.id.startsWith('google_') ? 'google' : 'phone',
            role: p.companion ? 'companion' : 'seeker',
            isProfileComplete: true,
            accountStatus: 'active',
            reliabilityScore: 100 - i * 3,
            dob: p.dob ?? null,
            createdAt: iso((60 - i * 4) * DAY),
            updatedAt: iso(2 * DAY),
        });

        if (p.companion) {
            await store.put(TABLES.COMPANIONS, {
                userId: p.id,
                name: p.name,
                initial: p.name[0],
                age: p.dob ? new Date().getFullYear() - Number(p.dob.slice(0, 4)) : 25,
                bio: 'Happy to keep you company for a walk, a coffee, or a museum afternoon.',
                shortTitle: ['Museum walks', 'Coffee & conversation', 'City walks', 'Gallery visits', 'Board games'][i % 5],
                category: ['outdoor', 'social', 'cultural', 'cultural', 'social'][i % 5],
                price: 60000 + i * 10000,
                currency: 'INR',
                rating: 4.2 + (i % 5) * 0.15,
                reviewCount: 8 + i * 3,
                location: ['Hyderabad', 'Bengaluru', 'Hyderabad', 'Mumbai', 'Pune'][i % 5],
                tags: ['walks', 'conversation'],
                languages: ['English', 'Hindi', 'Telugu'].slice(0, 2 + (i % 2)),
                availabilityStatus: 'available',
                isVerified: i < 2,
                isKycVerified: i < 2,
                kycStatus: i < 2 ? 'approved' : 'pending',
                reliabilityScore: 100 - i * 3,
                profileImage: `https://cdn.tryhive.in/p/${p.id}.jpg`,
                thumbnailImage: `https://cdn.tryhive.in/t/${p.id}.jpg`,
                createdAt: iso((60 - i * 4) * DAY),
                updatedAt: iso(2 * DAY),
            });
        }
    }

    // ─── KYC submissions (§5) ────────────────────────────────────────────────

    const sharedIdNumber = 'ABCDE1234F'; // K-04 — deliberate duplicate across two accounts

    const kycFixtures = [
        {
            userId: 'phone_+919812345003', // underage — K-03 must catch this
            attemptNumber: 1,
            hoursAgo: 26,
            documentType: 'aadhaar',
            extracted: { name: 'Kabir Rao', dob: '2009-02-20', idNumber: 'XXXX9012' },
            profileSnapshot: { name: 'Kabir Rao', dob: '2009-02-20', phone: '+919812345003' },
        },
        {
            userId: 'phone_+919812345004',
            attemptNumber: 1,
            hoursAgo: 14,
            documentType: 'pan',
            extracted: { name: 'Ishita Nair', dob: '1996-07-30', idNumber: sharedIdNumber },
            profileSnapshot: { name: 'Ishita Nair', dob: '1996-07-30', phone: '+919812345004' },
        },
        {
            userId: 'phone_+919812345005', // duplicate ID — same PAN as Ishita
            attemptNumber: 1,
            hoursAgo: 9,
            documentType: 'pan',
            extracted: { name: 'Vivaan Gupta', dob: '1999-01-15', idNumber: sharedIdNumber },
            profileSnapshot: { name: 'Vivaan Gupta', dob: '1999-01-15', phone: '+919812345005' },
        },
        {
            userId: 'phone_+919812345002', // third attempt — approaching K-09
            attemptNumber: 3,
            hoursAgo: 3,
            documentType: 'aadhaar',
            extracted: { name: 'Diya Sharma', dob: '2001-11-03', idNumber: 'XXXX4451' },
            profileSnapshot: { name: 'Diya S.', dob: '2001-11-03', phone: '+919812345002' }, // name mismatch
        },
    ];

    for (const f of kycFixtures) {
        await store.put(TABLES.KYC_SUBMISSIONS, {
            submissionId: randomId('kyc'),
            userId: f.userId,
            documentType: f.documentType,
            kycDocumentUrl: `https://api.tryhive.in/images/${f.userId}-gov-id-1.jpg`,
            kycSelfieUrl: `https://api.tryhive.in/images/${f.userId}-selfie-1.jpg`,
            extracted: f.extracted,
            idNumberHash: hashIdentifier(f.extracted.idNumber),
            profileSnapshot: f.profileSnapshot,
            attemptNumber: f.attemptNumber,
            status: 'pending',
            submittedAt: iso(f.hoursAgo * HOUR),
            version: 1,
        });
    }

    // An already-approved record, so the deletion queue has a KYC document to
    // reason about when it builds the retention plan (U-07).
    await store.put(TABLES.KYC_SUBMISSIONS, {
        submissionId: randomId('kyc'),
        userId: 'phone_+919812345010',
        documentType: 'passport',
        kycDocumentUrl: 'https://api.tryhive.in/images/phone_+919812345010-gov-id-1.jpg',
        extracted: { name: 'Tara Bose', dob: '1994-09-08', idNumber: 'P8812345' },
        idNumberHash: hashIdentifier('P8812345'),
        profileSnapshot: { name: 'Tara Bose', dob: '1994-09-08' },
        attemptNumber: 1,
        status: 'approved',
        submittedAt: iso(20 * DAY),
        decidedAt: iso(19 * DAY),
        decision: { outcome: 'approved', by: 'adm_ops', byEmail: 'ops@tryhive.in', at: iso(19 * DAY) },
        version: 2,
    });

    // Prior rejected attempts for Diya, so the attempt history renders.
    for (const attempt of [1, 2]) {
        await store.put(TABLES.KYC_SUBMISSIONS, {
            submissionId: randomId('kyc'),
            userId: 'phone_+919812345002',
            documentType: 'aadhaar',
            kycDocumentUrl: `https://api.tryhive.in/images/phone_+919812345002-gov-id-${attempt}.jpg`,
            extracted: { name: 'Diya Sharma', dob: '2001-11-03', idNumber: 'XXXX4451' },
            idNumberHash: hashIdentifier('XXXX4451'),
            profileSnapshot: { name: 'Diya S.', dob: '2001-11-03' },
            attemptNumber: attempt,
            status: 'rejected',
            submittedAt: iso((6 - attempt) * DAY),
            decidedAt: iso((6 - attempt) * DAY - 2 * HOUR),
            decision: {
                outcome: 'rejected',
                reasonCode: attempt === 1 ? 'blurry' : 'name_mismatch',
                reasonLabel: attempt === 1 ? 'Blurry / unreadable' : 'Name mismatch',
                by: 'adm_ops', byEmail: 'ops@tryhive.in', at: iso((6 - attempt) * DAY - 2 * HOUR),
            },
            version: 2,
        });
    }

    // ─── Moderation (§6.1) ───────────────────────────────────────────────────

    await store.put(TABLES.MODERATION_ITEMS, {
        itemId: randomId('mod'),
        type: 'new_profile',
        userId: 'phone_+919812345005',
        userName: 'Vivaan Gupta',
        status: 'pending',
        previousVersion: null,
        proposedVersion: {
            name: 'Vivaan Gupta',
            bio: 'Board games, long walks, and terrible puns. Happy to meet in public places.',
            shortTitle: 'Board games',
            tags: ['games', 'conversation'],
            profileImage: 'https://cdn.tryhive.in/p/vivaan.jpg',
        },
        createdAt: iso(20 * HOUR),
        escalated: false,
        version: 1,
    });

    // M-02 / M-03 — an edit to an already-approved profile.
    await store.put(TABLES.MODERATION_ITEMS, {
        itemId: randomId('mod'),
        type: 'profile_edit',
        userId: 'phone_+919812345001',
        userName: 'Aarav Mehta',
        status: 'pending',
        previousVersion: {
            name: 'Aarav Mehta',
            bio: 'Happy to keep you company for a walk, a coffee, or a museum afternoon.',
            shortTitle: 'Museum walks',
            tags: ['walks', 'conversation'],
            profileImage: 'https://cdn.tryhive.in/p/aarav.jpg',
        },
        proposedVersion: {
            name: 'Aarav Mehta',
            // The exact vector M-02 exists to catch.
            bio: 'Available for private sessions at your place. DM me on telegram @aarav_private for rates 😉',
            shortTitle: 'Private company',
            tags: ['walks', 'private'],
            profileImage: 'https://cdn.tryhive.in/p/aarav-new.jpg',
        },
        createdAt: iso(5 * HOUR),
        escalated: false,
        version: 1,
    });

    // ─── Reports (§6.2) ──────────────────────────────────────────────────────

    const reportFixtures = [
        {
            reporterUserId: 'phone_+919812345006', reportedUserId: 'phone_+919812345001',
            category: 'sexual_solicitation', severity: 'high', hoursAgo: 4,
            detail: 'Asked me to move the conversation to Telegram and hinted at paid private sessions.',
            relatedBookingId: 'bkg_demo_1',
        },
        {
            reporterUserId: 'phone_+919812345007', reportedUserId: 'phone_+919812345004',
            category: 'no_show', severity: 'medium', hoursAgo: 30,
            detail: 'Waited 40 minutes at the agreed cafe. No message, no arrival.',
            relatedBookingId: 'bkg_demo_2',
        },
        {
            reporterUserId: 'phone_+919812345008', reportedUserId: 'phone_+919812345002',
            category: 'safety_concern', severity: 'high', hoursAgo: 9,
            detail: 'Followed me to the metro station after I said the meeting was over.',
            relatedBookingId: 'bkg_demo_3',
        },
        {
            reporterUserId: 'phone_+919812345006', reportedUserId: 'phone_+919812345005',
            category: 'payment_issue', severity: 'low', hoursAgo: 50,
            detail: 'Asked for cash on top of the booking amount.',
            relatedBookingId: null,
        },
    ];

    for (const r of reportFixtures) {
        const reported = people.find((p) => p.id === r.reportedUserId);
        await store.put(TABLES.REPORTS, {
            reportId: randomId('rpt'),
            ...r,
            reporterName: people.find((p) => p.id === r.reporterUserId)?.name,
            reportedUserName: reported?.name,
            status: 'open',
            createdAt: iso(r.hoursAgo * HOUR),
            version: 1,
        });
    }

    // ─── Grievances (§6.3) ───────────────────────────────────────────────────

    const grievanceFixtures = [
        {
            // G-05 urgent, well inside its 24h window
            channel: 'in_app', category: 'ncii', hoursAgo: 3,
            complainantUserId: 'phone_+919812345008', complainantName: 'Sara Khan',
            againstUserId: 'phone_+919812345001',
            detail: 'A photo of me that I never consented to sharing is on this profile.',
            acknowledged: true, assignedTo: 'adm_super2',
        },
        {
            // urgent and breaching — the state the dashboard must make unmissable
            channel: 'email', category: 'morphed_image', hoursAgo: 31,
            complainantEmail: 'notauser@example.com', complainantName: 'Anonymous complainant',
            againstUserId: 'phone_+919812345004',
            detail: 'My face has been morphed onto another person\'s photo on this listing.',
            acknowledged: true, assignedTo: null,
        },
        {
            // standard, approaching the 15-day resolution deadline
            channel: 'in_app', category: 'conduct_complaint', hoursAgo: 13 * 24,
            complainantUserId: 'phone_+919812345007', complainantName: 'Rohan Das',
            againstUserId: 'phone_+919812345002',
            detail: 'Repeatedly late and dismissive across three bookings. I want this looked at.',
            acknowledged: true, assignedTo: 'adm_ops',
        },
        {
            // postal — SLA runs from physical receipt, not entry (§12)
            channel: 'postal', category: 'privacy_complaint', hoursAgo: 40,
            complainantEmail: 'legal@example.com', complainantName: 'V. Ramesh (by post)',
            againstUserId: null,
            detail: 'Written request for details of personal data held, received by post at the registered office.',
            acknowledged: false, assignedTo: null,
        },
        {
            // resolved, inside the appeal window
            channel: 'in_app', category: 'account_action_appeal', hoursAgo: 20 * 24,
            complainantUserId: 'phone_+919812345005', complainantName: 'Vivaan Gupta',
            againstUserId: null,
            detail: 'My profile was rejected and I do not understand why.',
            acknowledged: true, assignedTo: 'adm_ops',
            resolvedHoursAgo: 5 * 24,
        },
    ];

    for (const g of grievanceFixtures) {
        const receivedAt = iso(g.hoursAgo * HOUR);
        await store.put(TABLES.GRIEVANCES, {
            grievanceId: randomId('grv'),
            reference: `HIVE-GRV-2026-${String(100000 + Math.floor(Math.random() * 899999))}`,
            channel: g.channel,
            category: g.category,
            isUrgent: ['ncii', 'nudity', 'impersonation', 'morphed_image', 'minor_involved'].includes(g.category),
            detail: g.detail,
            complainantUserId: g.complainantUserId ?? null,
            complainantEmail: g.complainantEmail ?? null,
            complainantName: g.complainantName,
            againstUserId: g.againstUserId,
            receivedAt,
            enteredAt: g.channel === 'postal' ? iso(2 * HOUR) : receivedAt,
            enteredBy: g.channel === 'postal' ? 'adm_support' : 'system',
            acknowledgedAt: g.acknowledged ? iso((g.hoursAgo - 1) * HOUR) : null,
            acknowledgedBy: g.acknowledged ? 'system' : null,
            assignedTo: g.assignedTo,
            assignedToName: admins.find((a) => a.adminId === g.assignedTo)?.name ?? null,
            assignedAt: g.assignedTo ? iso((g.hoursAgo - 2) * HOUR) : null,
            urgentActionedAt: null,
            resolvedAt: g.resolvedHoursAgo ? iso(g.resolvedHoursAgo * HOUR) : null,
            resolution: g.resolvedHoursAgo
                ? {
                    outcome: 'not_upheld',
                    reasoning: 'The profile was rejected under the Community Guidelines for off-platform contact details in the bio. The rejection reason was communicated at the time and stands.',
                    by: 'adm_ops', byEmail: 'ops@tryhive.in', at: iso(g.resolvedHoursAgo * HOUR),
                }
                : null,
            appeal: null,
            notes: [],
            version: 1,
        });
    }

    // ─── Bookings, disputes ──────────────────────────────────────────────────

    const bookingFixtures = [
        { bookingId: 'bkg_demo_1', userId: 'phone_+919812345006', companionId: 'phone_+919812345001', status: 'completed', daysAgo: 2, amount: 130000 },
        { bookingId: 'bkg_demo_2', userId: 'phone_+919812345007', companionId: 'phone_+919812345004', status: 'confirmed', daysAgo: 1, amount: 95000, noShow: true },
        { bookingId: 'bkg_demo_3', userId: 'phone_+919812345008', companionId: 'phone_+919812345002', status: 'completed', daysAgo: 1, amount: 110000 },
        { bookingId: 'bkg_demo_4', userId: 'phone_+919812345006', companionId: 'phone_+919812345005', status: 'confirmed', daysAgo: 0, amount: 75000, checkInFailure: true },
        { bookingId: 'bkg_demo_5', userId: 'google_10293847561', companionId: 'phone_+919812345001', status: 'pending', daysAgo: 0, amount: 130000 },
    ];

    for (const b of bookingFixtures) {
        const created = iso(b.daysAgo * DAY + 6 * HOUR);
        await store.put(TABLES.BOOKINGS, {
            bookingId: b.bookingId,
            userId: b.userId,
            companionId: b.companionId,
            companionName: people.find((p) => p.id === b.companionId)?.name,
            serviceId: 'svc_walk',
            serviceTitle: 'City walk & conversation',
            selectedDate: new Date(now - b.daysAgo * DAY).toISOString().slice(0, 10),
            selectedTime: '17:00',
            durationHours: 2,
            message: '',
            pricePerHour: b.amount / 2,
            baseAmount: b.amount,
            platformFee: Math.round(b.amount * 0.15),
            totalAmount: b.amount,
            currency: 'INR',
            symbol: '₹',
            status: b.status,
            timeline: {
                requestedAt: created,
                acceptedAt: b.status !== 'pending' ? iso(b.daysAgo * DAY + 5 * HOUR) : null,
                paidAt: b.status !== 'pending' ? iso(b.daysAgo * DAY + 4.5 * HOUR) : null,
                checkedInAt: b.status === 'completed' ? iso(b.daysAgo * DAY + 1 * HOUR) : null,
                completedAt: b.status === 'completed' ? iso(b.daysAgo * DAY) : null,
            },
            checkInFailure: b.checkInFailure
                ? { at: iso(2 * HOUR), reason: 'GPS could not confirm proximity', reportedBy: b.userId }
                : null,
            noShowReports: b.noShow
                ? [{ by: b.userId, at: iso(20 * HOUR), reason: 'Companion did not arrive', waitedMinutes: 40 }]
                : [],
            createdAt: created,
            updatedAt: created,
            version: 1,
        });
    }

    await store.put(TABLES.DISPUTES, {
        disputeId: randomId('dsp'),
        bookingId: 'bkg_demo_2',
        raisedBy: 'phone_+919812345007',
        against: 'phone_+919812345004',
        category: 'no_show',
        detail: 'Companion did not arrive; seeker waited 40 minutes.',
        status: 'open',
        openedAt: iso(21 * HOUR),
        version: 1,
    });

    // B-09 — the distress signal.
    await store.put(TABLES.DISPUTES, {
        disputeId: randomId('dsp'),
        bookingId: 'bkg_demo_3',
        raisedBy: 'phone_+919812345008',
        against: 'phone_+919812345002',
        category: 'block_during_active_booking',
        detail: 'One party blocked the other while the booking was active',
        blockSignal: true,
        status: 'open',
        openedAt: iso(8 * HOUR),
        version: 1,
    });

    // ─── Finance ─────────────────────────────────────────────────────────────

    // F-07 — one bank account, two companion profiles.
    const muleAccount = { number: '50100234567890', ifsc: 'HDFC0001234' };

    const accounts = [
        { companionId: 'phone_+919812345001', holder: 'Aarav Mehta', number: '50100111222333', ifsc: 'HDFC0000456', bank: 'HDFC Bank', verified: true },
        { companionId: 'phone_+919812345002', holder: 'Diya Sharma', number: '10203040506070', ifsc: 'ICIC0000789', bank: 'ICICI Bank', verified: true, changedHoursAgo: 12 },
        { companionId: 'phone_+919812345004', holder: 'I Nair', number: muleAccount.number, ifsc: muleAccount.ifsc, bank: 'HDFC Bank', verified: true },
        { companionId: 'phone_+919812345005', holder: 'V Gupta', number: muleAccount.number, ifsc: muleAccount.ifsc, bank: 'HDFC Bank', verified: true },
    ];

    const accountIds = {};
    for (const a of accounts) {
        const bankAccountId = randomId('bnk');
        accountIds[a.companionId] = bankAccountId;
        await store.put(TABLES.BANK_ACCOUNTS, {
            bankAccountId,
            companionId: a.companionId,
            accountHolderName: a.holder,
            accountNumber: a.number,
            ifscCode: a.ifsc,
            bankName: a.bank,
            accountHash: hashBankAccount(a.number, a.ifsc),
            isVerified: a.verified,
            isPrimary: true,
            detailsChangedAt: a.changedHoursAgo ? iso(a.changedHoursAgo * HOUR) : null,
            createdAt: iso(30 * DAY),
        });
    }

    const payoutFixtures = [
        { companionId: 'phone_+919812345001', amount: 110500, status: 'requested', hoursAgo: 6, bookingIds: ['bkg_demo_1'] },
        { companionId: 'phone_+919812345002', amount: 93500, status: 'requested', hoursAgo: 3, bookingIds: ['bkg_demo_3'] },
        { companionId: 'phone_+919812345004', amount: 80750, status: 'failed', hoursAgo: 26, bookingIds: ['bkg_demo_2'], gatewayError: 'BENEFICIARY_ACCOUNT_INVALID: account number does not match IFSC branch' },
        { companionId: 'phone_+919812345005', amount: 63750, status: 'held', hoursAgo: 40, bookingIds: [], holdReasonCode: 'mule_signal', holdReason: 'Bank account shared across profiles' },
        // Held against an account whose bank details changed 12h ago — releasing
        // this one must run into the F-06 cooling-off guard.
        { companionId: 'phone_+919812345002', amount: 41200, status: 'held', hoursAgo: 11, bookingIds: [], holdReasonCode: 'bank_change_cooling', holdReason: 'Bank details changed — cooling-off' },
        // Settled today, so it lands in today's reconciliation window alongside
        // the gateway rows below.
        { companionId: 'phone_+919812345001', amount: 128000, status: 'paid', hoursAgo: 8, bookingIds: [], settledHoursAgo: 4 },
    ];

    const payoutIds = [];
    for (const p of payoutFixtures) {
        const payoutId = randomId('pay');
        payoutIds.push({ payoutId, ...p });
        await store.put(TABLES.PAYOUTS, {
            payoutId,
            companionId: p.companionId,
            companionName: people.find((x) => x.id === p.companionId)?.name,
            bankAccountId: accountIds[p.companionId],
            amount: p.amount,
            currency: 'INR',
            status: p.status,
            bookingIds: p.bookingIds,
            gatewayError: p.gatewayError ?? null,
            holdReasonCode: p.holdReasonCode ?? null,
            holdReason: p.holdReason ?? null,
            heldAt: p.holdReasonCode ? iso(p.hoursAgo * HOUR) : null,
            heldBy: p.holdReasonCode ? 'adm_finance' : null,
            attempts: p.status === 'failed' ? 2 : 1,
            requestedAt: iso(p.hoursAgo * HOUR),
            settledAt: p.settledHoursAgo ? iso(p.settledHoursAgo * HOUR) : null,
            version: 1,
        });
    }

    // F-08 — a settlement that disagrees with the ledger (the §12 case).
    const paidPayout = payoutIds.find((p) => p.status === 'paid');
    const today = new Date().toISOString().slice(0, 10);
    await store.put(TABLES.RECONCILIATION, {
        reconId: randomId('rec'),
        date: today,
        payoutId: paidPayout.payoutId,
        companionId: paidPayout.companionId,
        amount: paidPayout.amount,
        status: 'failed', // gateway says failed; ledger says paid
        reference: 'RZP-STL-20260805-0041',
        resolvedAt: null,
    });
    const requestedPayout = payoutIds.find((p) => p.status === 'requested');
    await store.put(TABLES.RECONCILIATION, {
        reconId: randomId('rec'),
        date: today,
        payoutId: requestedPayout.payoutId,
        companionId: requestedPayout.companionId,
        amount: requestedPayout.amount,
        status: 'paid', // gateway paid something the ledger has not caught up on
        reference: 'RZP-STL-20260805-0042',
        resolvedAt: null,
    });

    // F-10 — a refund above the dual-approval threshold, awaiting a second signature.
    await store.put(TABLES.REFUNDS, {
        refundId: randomId('rfd'),
        bookingId: 'bkg_demo_1',
        userId: 'phone_+919812345006',
        companionId: 'phone_+919812345001',
        amount: 130000, // ₹1,300 — above the ₹5,000 threshold? no; kept realistic
        currency: 'INR',
        partial: false,
        reasonCode: 'safety_incident',
        reasonLabel: 'Safety incident',
        note: 'Refunded in full pending the outcome of the solicitation report.',
        status: 'pending_approval',
        requestedBy: 'adm_support',
        requestedByEmail: 'support@tryhive.in',
        requestedAt: iso(4 * HOUR),
        threshold: 500000,
        version: 1,
    });
    await store.put(TABLES.REFUNDS, {
        refundId: randomId('rfd'),
        bookingId: 'bkg_demo_2',
        userId: 'phone_+919812345007',
        companionId: 'phone_+919812345004',
        amount: 950000, // ₹9,500 — over the threshold, needs two signatures
        currency: 'INR',
        partial: false,
        reasonCode: 'companion_no_show',
        reasonLabel: 'Companion no-show',
        note: 'Companion did not arrive; seeker waited 40 minutes and filed a report.',
        status: 'pending_approval',
        requestedBy: 'adm_finance',
        requestedByEmail: 'finance@tryhive.in',
        requestedAt: iso(18 * HOUR),
        threshold: 500000,
        version: 1,
    });

    // ─── Deletion requests (§9) ──────────────────────────────────────────────

    await store.put(TABLES.DELETION_REQUESTS, {
        requestId: randomId('del'),
        userId: 'phone_+919812345005',
        userName: 'Vivaan Gupta',
        source: 'tryhive.in/delete-account',
        reason: 'No longer using the service',
        status: 'pending',
        requestedAt: iso(3 * DAY),
        version: 1,
    });
    await store.put(TABLES.DELETION_REQUESTS, {
        requestId: randomId('del'),
        userId: 'phone_+919812345008',
        userName: 'Sara Khan',
        source: 'tryhive.in/delete-account',
        reason: 'Privacy',
        status: 'pending',
        requestedAt: iso(1 * DAY),
        version: 1,
    });
    // Clear of every blocker — this is the one that runs straight into the
    // unresolved KYC retention policy (U-07).
    await store.put(TABLES.DELETION_REQUESTS, {
        requestId: randomId('del'),
        userId: 'phone_+919812345010',
        userName: 'Tara Bose',
        source: 'tryhive.in/delete-account',
        reason: 'Moving abroad',
        status: 'pending',
        requestedAt: iso(5 * DAY),
        version: 1,
    });

    // ─── A little audit history so the log is not empty on first load ────────

    audit.invalidateTipCache();
    await audit.record({
        actor: { adminId: 'adm_ops', email: 'ops@tryhive.in', role: ROLES.OPS, sessionId: 'sess_seed' },
        action: audit.ACTIONS.KYC_REJECTED,
        targetType: 'kyc_submission',
        targetId: 'seed',
        reason: 'Blurry / unreadable',
        reasonCode: 'blurry',
        before: { status: 'pending' },
        after: { status: 'rejected' },
    });
    await audit.record({
        actor: { adminId: 'adm_finance', email: 'finance@tryhive.in', role: ROLES.FINANCE, sessionId: 'sess_seed' },
        action: audit.ACTIONS.PAYOUT_HELD,
        targetType: 'payout',
        targetId: payoutIds.find((p) => p.status === 'held').payoutId,
        reason: 'Bank account shared across profiles',
        reasonCode: 'mule_signal',
        after: { status: 'held' },
    });

    return {
        adminCount: admins.length,
        demoTotpSecret: demoSecret,
        superAdminEmail: 'naveen@tryhive.in',
        // Returned so the startup banner prints what was actually used, rather
        // than re-deriving it and risking the two drifting apart.
        seedPassword: superAdminPassword,
        usingDefaultPassword: superAdminPassword === DEFAULT_DEMO_PASSWORD,
    };
}

module.exports = { seed };
