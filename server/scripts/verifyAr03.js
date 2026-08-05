/**
 * AR-03 verification — "consumer JWT cannot be escalated to an admin JWT".
 *
 * PRD §13 makes this the gate on Phase 1: the phase does not ship until
 * consumer→admin escalation has been attempted and failed. This script is that
 * attempt, automated, so it can run in CI on every change to the auth path
 * rather than once during a pen test.
 *
 *   node scripts/verifyAr03.js
 *
 * Exits non-zero if any attack succeeds.
 */

require('dotenv').config();

if (!process.env.ADMIN_JWT_SECRET) {
    process.env.ADMIN_JWT_SECRET = 'dev-only-admin-key-4f8b2e9d7a1c6350-local-run-do-not-ship';
}

// The demo 2FA bypass is irrelevant to AR-03 — it skips the second factor, never
// the token checks — but this gate should exercise the shipping configuration,
// so it is forced off. Set rather than deleted: index.js re-runs dotenv.config()
// on require, and dotenv will not overwrite a variable that is already set.
process.env.ADMIN_DEMO_SKIP_MFA = '0';

const jwt = require('jsonwebtoken');
const http = require('http');

const CONSUMER_SECRET = process.env.JWT_SECRET || 'hive_secret_key_change_in_prod';
const ADMIN_SECRET = process.env.ADMIN_JWT_SECRET;
const { SESSION } = require('../config/constants');

const { app } = require('../index');

let server;
let baseUrl;

function request(path, { token, method = 'GET' } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            `${baseUrl}${path}`,
            { method, headers: token ? { Authorization: `Bearer ${token}` } : {} },
            (res) => {
                let body = '';
                res.on('data', (c) => { body += c; });
                res.on('end', () => resolve({ status: res.statusCode, body }));
            }
        );
        req.on('error', reject);
        req.end();
    });
}

// Each attack is a token an attacker could plausibly hold or forge, and the
// claim that it should not reach /admin.
const attacks = [
    {
        name: 'Consumer session token (the real thing, straight from authController)',
        token: () => jwt.sign({ userId: 'phone_+919812345001' }, CONSUMER_SECRET, { expiresIn: '30d' }),
    },
    {
        name: 'Consumer token with a forged role claim',
        token: () => jwt.sign({ userId: 'phone_+919812345001', role: 'super_admin' }, CONSUMER_SECRET, { expiresIn: '30d' }),
    },
    {
        name: 'Consumer token carrying the admin typ/iss/aud claims',
        token: () => jwt.sign(
            { sub: 'adm_super', role: 'super_admin', sid: 'sess_fake', typ: SESSION.TOKEN_TYPE },
            CONSUMER_SECRET,
            { issuer: SESSION.ISSUER, audience: SESSION.AUDIENCE, expiresIn: '8h' }
        ),
    },
    {
        name: 'Token signed with the default consumer secret bond-srv falls back to',
        token: () => jwt.sign(
            { sub: 'adm_super', role: 'super_admin', sid: 'sess_fake', typ: SESSION.TOKEN_TYPE },
            'hive_secret_key_change_in_prod',
            { issuer: SESSION.ISSUER, audience: SESSION.AUDIENCE, expiresIn: '8h' }
        ),
    },
    {
        name: 'alg:none — unsigned token',
        token: () => {
            const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
            const payload = Buffer.from(JSON.stringify({
                sub: 'adm_super', role: 'super_admin', sid: 'sess_fake', typ: 'admin',
                iss: SESSION.ISSUER, aud: SESSION.AUDIENCE, exp: Math.floor(Date.now() / 1000) + 3600,
            })).toString('base64url');
            return `${header}.${payload}.`;
        },
    },
    {
        name: 'Correctly signed admin token for a session that was never created',
        // The one that matters most: even with the admin key, a token without a
        // server-side session is refused. Key compromise alone is not enough.
        token: () => jwt.sign(
            { sub: 'adm_super', role: 'super_admin', sid: 'sess_never_existed', typ: SESSION.TOKEN_TYPE },
            ADMIN_SECRET,
            { issuer: SESSION.ISSUER, audience: SESSION.AUDIENCE, expiresIn: '8h' }
        ),
    },
    {
        name: 'Admin token with the wrong issuer',
        token: () => jwt.sign(
            { sub: 'adm_super', role: 'super_admin', sid: 'sess_seed', typ: SESSION.TOKEN_TYPE },
            ADMIN_SECRET,
            { issuer: 'hive-consumer', audience: SESSION.AUDIENCE, expiresIn: '8h' }
        ),
    },
    {
        name: 'MFA challenge token used as a session token',
        token: () => jwt.sign(
            { sub: 'adm_super', typ: 'mfa_challenge' },
            ADMIN_SECRET,
            { issuer: SESSION.ISSUER, audience: SESSION.AUDIENCE, expiresIn: '5m' }
        ),
    },
];

const PROTECTED_ROUTES = [
    '/admin/dashboard',
    '/admin/kyc/queue',
    '/admin/users',
    '/admin/finance/payouts',
    '/admin/audit',
    '/admin/admins',
];

(async () => {
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    console.log('AR-03 — attempting consumer → admin privilege escalation\n');

    let failures = 0;
    let checks = 0;

    for (const attack of attacks) {
        const token = attack.token();
        const results = [];
        for (const route of PROTECTED_ROUTES) {
            const res = await request(route, { token });
            checks++;
            results.push({ route, status: res.status });
            if (res.status !== 401 && res.status !== 403) {
                failures++;
                console.log(`  ✗ BREACH  ${attack.name}`);
                console.log(`            ${route} returned ${res.status}: ${res.body.slice(0, 160)}`);
            }
        }
        const worst = Math.min(...results.map((r) => r.status));
        if (results.every((r) => r.status === 401 || r.status === 403)) {
            console.log(`  ✓ blocked  ${attack.name}  (${worst})`);
        }
    }

    // Sanity check in the other direction: an unauthenticated request must also
    // be refused, otherwise "blocked" above proves nothing.
    const anonymous = await request('/admin/dashboard');
    checks++;
    if (anonymous.status !== 401) {
        failures++;
        console.log(`  ✗ BREACH  No token at all returned ${anonymous.status}`);
    } else {
        console.log('  ✓ blocked  No token at all  (401)');
    }

    // And that the surface is actually alive, so a broken server does not read
    // as a passing test.
    const health = await request('/admin/healthz');
    if (health.status !== 200) {
        console.log('\n✗ /admin/healthz did not respond — the test above proved nothing.');
        server.close();
        process.exit(1);
    }

    console.log(`\n${checks} checks, ${failures} breach(es).`);
    server.close();

    if (failures > 0) {
        console.log('AR-03 FAILED. Phase 1 does not ship.');
        process.exit(1);
    }
    console.log('AR-03 holds: no consumer-derived or forged token reached an admin route.');
    process.exit(0);
})();
