/**
 * Loads the demo fixtures into whatever store is configured.
 *
 * The in-memory driver seeds itself on every start. DynamoDB does not, so a
 * hosted demo needs this run once:
 *
 *   ADMIN_DATA_DRIVER=dynamodb \
 *   ADMIN_SEED_PASSWORD="…" \
 *   ADMIN_DEMO_TOTP_SECRET="…" \
 *   node scripts/seedDemoData.js
 *
 * This writes demo companions, bookings, KYC submissions and grievances into
 * real tables. It refuses to run against tables that already hold data unless
 * --force is passed, so it cannot quietly scribble fixtures over live records.
 *
 * NEVER run this against the production tables. There is no undo.
 */

require('dotenv').config();

const { store, TABLES, driverName } = require('../lib/store');
const { seed } = require('../lib/seed');
const audit = require('../lib/audit');

const force = process.argv.includes('--force');

(async () => {
    console.log(`Seeding demo data into the ${driverName} store.\n`);

    if (driverName === 'memory') {
        console.warn('⚠ The in-memory driver seeds itself on every start — running this achieves nothing.');
        console.warn('  Set ADMIN_DATA_DRIVER=dynamodb if you meant to seed real tables.\n');
        process.exit(1);
    }

    // A safety interlock, not a nicety: the failure mode is fixtures on top of
    // real companions, and the tables this touches include KYC submissions.
    const occupied = [];
    for (const table of [TABLES.ADMIN_USERS, TABLES.COMPANIONS, TABLES.KYC_SUBMISSIONS, TABLES.GRIEVANCES]) {
        const existing = await store.list(table, { limit: 1 });
        if (existing.length > 0) occupied.push(table);
    }

    if (occupied.length && !force) {
        console.error('✗ These tables already contain data:\n');
        occupied.forEach((t) => console.error(`    ${t}`));
        console.error('\n  Refusing to seed over them. If this really is a throwaway demo environment,');
        console.error('  rerun with --force. If there is any chance these are real records, stop.\n');
        process.exit(1);
    }

    if (force && occupied.length) {
        console.warn('⚠ --force given; seeding on top of existing data.\n');
    }

    if (!process.env.ADMIN_SEED_PASSWORD) {
        console.warn('⚠ ADMIN_SEED_PASSWORD is not set, so the accounts will use the default from');
        console.warn('  the README — which is public. Set it before anyone else can reach this.\n');
    }

    audit.invalidateTipCache();
    const result = await seed();

    console.log('✓ Demo data written.\n');
    console.log(`  Accounts:    ${result.adminCount}`);
    console.log(`  Sign in as:  ${result.superAdminEmail}`);
    console.log(`  Password:    ${result.seedPassword}`);
    console.log(`  TOTP secret: ${result.demoTotpSecret}`);
    console.log('\n  Other accounts, same password: ops@ / support@ / finance@ / readonly@tryhive.in\n');

    if (result.usingDefaultPassword) {
        console.warn('⚠ Using the default password. Set ADMIN_SEED_PASSWORD and reseed before sharing.\n');
    }

    process.exit(0);
})().catch((err) => {
    console.error('Seeding failed:', err.message);
    process.exit(1);
});
