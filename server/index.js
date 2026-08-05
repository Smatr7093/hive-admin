/**
 * Standalone admin server.
 *
 * Two ways to run this module:
 *
 *   1. Mounted into bond-srv (production shape, AR-02):
 *        const adminRouter = require('./admin/routes');
 *        app.use('/admin', adminRouter);
 *
 *   2. Standalone (local development and the demo):
 *        npm start
 *      Runs on its own port with the in-memory driver and seeded data. Useful
 *      because it also proves the admin surface has no runtime dependency on the
 *      consumer routes — nothing here requires anything from bond-srv's
 *      middleware/authMiddleware.
 */

require('dotenv').config();

// A dev-only default so `npm start` works out of the box. In any deployed
// environment this must come from the environment, and assertSecretsAreSeparate
// rejects placeholders — see docs/SECURITY.md.
if (!process.env.ADMIN_JWT_SECRET) {
    process.env.ADMIN_JWT_SECRET = 'dev-only-admin-key-4f8b2e9d7a1c6350-local-run-do-not-ship';
}

const express = require('express');
const adminRouter = require('./routes');
const { driverName } = require('./lib/store');

const app = express();

app.use(express.json({ limit: '1mb' }));

// AR-09 — the console is served from its own subdomain and talks to this API
// cross-origin. Exact matches only, never a wildcard and never a pattern.
//
// A comma-separated list is accepted because a console hosted on Vercel gets a
// distinct hostname per preview deployment, and a team reviewing a branch will
// otherwise hit an unexplained CORS failure. Listing those origins explicitly is
// a very different thing from relaxing the check: every entry is one someone
// typed deliberately, and a hostname nobody listed still gets nothing.
const ALLOWED_ORIGINS = (process.env.ADMIN_CONSOLE_ORIGIN || 'http://localhost:3100')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, '')) // a trailing slash never matches an Origin header
    .filter(Boolean);

const ALLOWED_ORIGIN = ALLOWED_ORIGINS[0];

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-Match');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Max-Age', '600');
    }
    // Credentials are never allowed: the console holds its token in memory and
    // sends it as an Authorization header, so there is no cookie to protect and
    // no CSRF surface to speak of.
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
});

// Baseline hardening for the API responses themselves.
app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
    if (process.env.NODE_ENV === 'production') {
        res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    }
    next();
});

app.use('/admin', adminRouter);

app.get('/', (_req, res) => res.json({ service: 'hive-admin', driver: driverName }));

const PORT = process.env.ADMIN_PORT || 4000;

async function start() {
    if (driverName === 'memory') {
        const { seed } = require('./lib/seed');
        const result = await seed();
        console.log('┌─ Hive Admin (in-memory demo data) ────────────────────────');
        console.log(`│ Sign in:  ${result.superAdminEmail}`);
        console.log(`│ Password: ${result.seedPassword}`);
        console.log(`│ TOTP secret (add to your authenticator): ${result.demoTotpSecret}`);
        console.log('│ Other accounts, same password: ops@ / support@ / finance@ / readonly@tryhive.in');
        console.log('└───────────────────────────────────────────────────────────');

        // The default password is published in this repository's README. On
        // localhost that is a convenience; on any host a colleague can reach it
        // is a public login. Say so at the point it becomes true.
        if (result.usingDefaultPassword && ALLOWED_ORIGIN && !ALLOWED_ORIGIN.includes('localhost')) {
            console.warn(
                '\n⚠  The seeded accounts are using the default password, which is published in the README,\n' +
                `   and this instance answers a non-local console origin (${ALLOWED_ORIGIN}).\n` +
                '   Set ADMIN_SEED_PASSWORD before anyone outside your machine can reach this.\n'
            );
        }
    }

    // G-02 — the 24-hour acknowledgement clock does not wait for a page load.
    // The list endpoint also sweeps, so this is belt and braces for quiet nights.
    const { runAcknowledgementSweep } = require('./controllers/grievanceController');
    setInterval(() => {
        runAcknowledgementSweep().catch((err) => console.error('[grievance sweep]', err));
    }, 5 * 60 * 1000).unref();

    app.listen(PORT, () => {
        console.log(`Hive Admin API on http://localhost:${PORT}/admin  (driver: ${driverName})`);
        // Printed in full: a CORS failure caused by a trailing slash or a missing
        // scheme is very hard to see from the browser end, and very easy to spot here.
        console.log(`Console origins allowed (${ALLOWED_ORIGINS.length}):`);
        ALLOWED_ORIGINS.forEach((o) => console.log(`  · ${o}`));
    });
}

if (require.main === module) {
    start().catch((err) => {
        console.error('Failed to start admin server:', err);
        process.exit(1);
    });
}

module.exports = { app, adminRouter, start };
