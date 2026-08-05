/**
 * Prints a current TOTP code for the seeded demo accounts.
 *
 * Demo convenience only — every seeded admin shares one authenticator secret so
 * a single entry covers all five roles. Nothing like this exists for real
 * accounts: their secrets are generated per admin at enrolment and are never
 * readable back out of the store.
 *
 *   npm run code
 */

require('dotenv').config();

const { totpCodeAt } = require('../lib/crypto');

const secret = process.env.ADMIN_DEMO_TOTP_SECRET;

if (!secret) {
    console.error('ADMIN_DEMO_TOTP_SECRET is not set in server/.env.');
    console.error('Without it the seeder generates a fresh secret on every start and prints it');
    console.error('in the startup banner — read it from there, or pin it in .env.');
    process.exit(1);
}

const step = Math.floor(Date.now() / 1000 / 30);
const secondsLeft = 30 - (Math.floor(Date.now() / 1000) % 30);

console.log(`\n  ${totpCodeAt(secret, step)}   (valid for ${secondsLeft}s)`);
// Codes near the end of their window are useless by the time they are typed, so
// always offer the next one rather than making someone rerun this.
console.log(`  ${totpCodeAt(secret, step + 1)}   (next)\n`);
