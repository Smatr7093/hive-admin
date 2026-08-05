/**
 * Bootstrap the first Super Admin (AR-06).
 *
 * This is the only way an admin account comes into existence without another
 * admin creating it, and it runs from a shell on the server — not from a route.
 * There is deliberately no self-registration endpoint anywhere in this module.
 *
 *   ADMIN_DATA_DRIVER=dynamodb node scripts/createSuperAdmin.js you@tryhive.in "Your Name"
 *
 * Prints a temporary password once. The account starts in `pending_enrolment`
 * and cannot do anything until an authenticator is bound on first sign-in.
 *
 * Open question #1 in the PRD — break-glass. Create at least TWO Super Admins
 * before going live: §12 requires a second Super Admin to reset a lost 2FA
 * device, and resetAdminMfa refuses to act on the caller's own account. With one
 * Super Admin and a lost phone, there is no recovery path short of touching the
 * database directly.
 */

require('dotenv').config();

const { store, TABLES, driverName } = require('../lib/store');
const { hashPassword, randomId, validatePasswordStrength } = require('../lib/crypto');
const { ROLES } = require('../config/constants');
const audit = require('../lib/audit');

const [, , email, ...nameParts] = process.argv;
const name = nameParts.join(' ');

if (!email || !name) {
    console.error('Usage: node scripts/createSuperAdmin.js <email> <full name>');
    process.exit(1);
}

function generatePassword() {
    // 20 characters of base64url plus one of each required class.
    return `${randomId('Hv').slice(3)}${randomId('x').slice(2, 8)}!aA9`;
}

(async () => {
    if (driverName === 'memory') {
        console.warn('⚠ Running against the in-memory driver — this account will not persist.');
        console.warn('  Set ADMIN_DATA_DRIVER=dynamodb to create a real one.\n');
    }

    const existing = await store.list(TABLES.ADMIN_USERS, {
        filter: (a) => a.email.toLowerCase() === email.toLowerCase(),
    });
    if (existing.length) {
        console.error(`An admin with the email ${email} already exists (${existing[0].adminId}).`);
        process.exit(1);
    }

    const password = process.env.ADMIN_BOOTSTRAP_PASSWORD || generatePassword();
    const errors = validatePasswordStrength(password);
    if (errors.length) {
        console.error(`Password ${errors.join(', ')}`);
        process.exit(1);
    }

    const admin = {
        adminId: randomId('adm'),
        email: email.toLowerCase(),
        name,
        role: ROLES.SUPER_ADMIN,
        status: 'pending_enrolment',
        passwordHash: hashPassword(password),
        totpSecret: null,
        createdAt: new Date().toISOString(),
        createdBy: 'bootstrap-script',
        failedLogins: 0,
    };

    await store.put(TABLES.ADMIN_USERS, admin);

    await audit.record({
        actor: { adminId: 'bootstrap', role: 'system', email: 'bootstrap-script' },
        action: audit.ACTIONS.ADMIN_CREATED,
        targetType: 'admin',
        targetId: admin.adminId,
        reason: 'Bootstrap Super Admin created from the server shell',
        after: { email: admin.email, role: admin.role },
    });

    const supers = await store.list(TABLES.ADMIN_USERS, {
        filter: (a) => a.role === ROLES.SUPER_ADMIN && a.status !== 'disabled',
    });

    console.log('\n✓ Super Admin created');
    console.log(`  adminId:  ${admin.adminId}`);
    console.log(`  email:    ${admin.email}`);
    console.log(`  password: ${password}`);
    console.log('\n  This password is shown once. Deliver it out of band, not by email to the same address.');
    console.log('  On first sign-in the account must bind an authenticator before it can do anything.\n');

    if (supers.length < 2) {
        console.warn('⚠ There is only one Super Admin. PRD §12 requires a second one to recover a lost 2FA device.');
        console.warn('  Create a second Super Admin before this goes anywhere near production.\n');
    }

    process.exit(0);
})();
