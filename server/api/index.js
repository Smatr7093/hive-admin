/**
 * Vercel serverless entry point for the admin API.
 *
 * Vercel invokes the exported handler per request rather than running a
 * long-lived process, so this file exports the Express app instead of calling
 * `listen`. `index.js` already guards its own `start()` behind
 * `require.main === module`, so requiring it here is side-effect free.
 *
 * ── The one thing that matters ──────────────────────────────────────────────
 *
 * ADMIN_DATA_DRIVER must be `dynamodb` here. The `memory` driver keeps admin
 * sessions in process memory, and serverless invocations do not share memory:
 * the login that mints a session and the next request that checks it can land in
 * different instances, so every user is signed out immediately after signing in.
 * It fails in a way that looks like a bug in the auth code rather than a hosting
 * mismatch, which is why this file refuses to start rather than let it happen.
 *
 * See docs/DEPLOYING.md § "All-Vercel".
 */

if ((process.env.ADMIN_DATA_DRIVER || 'memory').toLowerCase() !== 'dynamodb') {
    throw new Error(
        'ADMIN_DATA_DRIVER must be "dynamodb" on Vercel. The in-memory driver stores admin ' +
        'sessions in process memory, which serverless invocations do not share — every sign-in ' +
        'would be immediately invalidated. Set ADMIN_DATA_DRIVER=dynamodb, or host the API ' +
        'somewhere with a long-lived process (see docs/DEPLOYING.md).'
    );
}

const { app } = require('../index');

module.exports = app;
