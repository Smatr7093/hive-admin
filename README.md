# Hive Admin Dashboard — v2.1

Operations console for Hive (Siante Technologies Private Limited), built to
[`hive-v21-admin-dashboard-prd.md`](../hive-v21-admin-dashboard-prd.md).

Two applications:

| | | |
|---|---|---|
| `server/` | Express, DynamoDB | The `/admin` namespace for `bond-srv` — separate auth, RBAC, append-only audit log |
| `web/` | Next.js 15, Tailwind v4 | The console. Separate app, separate deploy, strict CSP |

---

## Run it locally

Two terminals. The server seeds realistic demo data into an in-memory store, so
neither AWS nor the consumer app is needed.

```bash
cd server && npm install && npm start
```

```bash
cd web && npm install && npm run dev
```

Then open **http://localhost:3100**.

### Signing in

Every account uses the password `HiveAdmin!2026#Ops` and the same demo TOTP
secret, so one authenticator entry covers all of them.

| Email | Role | What they can see |
|---|---|---|
| `naveen@tryhive.in` | Super Admin | Everything, plus admin accounts and the audit chain |
| `grievance@tryhive.in` | Super Admin | The Grievance Officer account |
| `ops@tryhive.in` | Ops | KYC, moderation, reports, disputes — PII unmasked |
| `support@tryhive.in` | Support | Tickets and goodwill — **PII masked by default** |
| `finance@tryhive.in` | Finance | Payouts, refunds, reconciliation |
| `readonly@tryhive.in` | Read-only | Dashboard counters and nothing else |

**The local demo ships with `ADMIN_DEMO_SKIP_MFA=1` in `server/.env`**, so sign-in
is one form. Delete that line to get the real AR-05 two-step flow back.

That flag is fenced, not trusted: it only engages when the data driver is
in-memory *and* `NODE_ENV` is not production. Set it alongside either
`ADMIN_DATA_DRIVER=dynamodb` or `NODE_ENV=production` and the process refuses to
start rather than quietly ignoring it. Sign-ins taken this way are logged as
having bypassed 2FA, and the console shows a banner that cannot be dismissed.
`npm test` forces it off and asserts all of that.

### With 2FA on

The server prints the TOTP secret in its startup banner:

```
┌─ Hive Admin (in-memory demo data) ────────────────────────
│ Sign in:  naveen@tryhive.in
│ Password: HiveAdmin!2026#Ops
│ TOTP secret (add to your authenticator): JBSWY3DPEHPK3PXP…
└───────────────────────────────────────────────────────────
```

Add it to any authenticator app, or print a code from the shell:

```bash
cd server && npm run code
```

It prints the current code and the next one, so a code that is about to expire
does not mean rerunning it.

Set `ADMIN_DEMO_TOTP_SECRET` in `server/.env` to keep the secret stable across
restarts — otherwise a fresh one is generated each time. (`.env` is gitignored;
copy `.env.example`.)

Sign in as `support@` and then `ops@` to see the same records with and without
PII masking — that contrast is the clearest demonstration of §4.

> The session token is held in memory only, never in `localStorage` or a cookie.
> Refreshing the page signs you out. That is deliberate — see
> [`docs/SECURITY.md`](docs/SECURITY.md).

### Demo data

The seed is not a happy path. It includes an underage KYC applicant, two accounts
sharing one PAN, a third-attempt submission, a profile edit that adds
solicitation content to an approved profile, a breached urgent grievance, a
postal grievance backdated to its physical receipt, one bank account receiving
payouts for two companions, a gateway settlement that disagrees with the ledger,
and a deletion request blocked by an open payout. If a queue cannot render those,
it is not finished.

---

## Tests

```bash
cd server && npm test
```

95 assertions covering the 2FA gate, the RBAC matrix, PII masking and unmask
grants, the fixed reason lists, the age check, optimistic locking, dual approval,
SLA computation, and the append-only guarantee.

```bash
cd server && npm run verify:ar03
```

The Phase 1 gate from PRD §13: eight privilege-escalation attempts against six
protected routes, including a real consumer token, a token carrying forged admin
claims, `alg:none`, and a correctly-signed admin token for a session that was
never created. Exits non-zero if any of them get through. **Run this in CI on
every change to the auth path.**

---

## Deploying

### Server — mount into `bond-srv`

Copy `server/` to `bond-srv/admin/`, then in `server.js`:

```js
const adminRouter = require("./admin/routes");
app.use("/admin", adminRouter);
```

Note what is *not* in that line: `verifyToken`. The admin router authenticates
with its own middleware, its own secret, its own issuer and its own session
store. The consumer middleware is never in the chain (AR-03).

Then:

```bash
cd admin
cp .env.example .env          # fill in ADMIN_JWT_SECRET — the process refuses to start without it
ADMIN_DATA_DRIVER=dynamodb node scripts/createAdminTables.js
ADMIN_DATA_DRIVER=dynamodb node scripts/createSuperAdmin.js you@tryhive.in "Your Name"
```

Create **two** Super Admins. PRD §12 requires a second one to reset a lost 2FA
device, and `resetAdminMfa` refuses to act on the caller's own account. With one
Super Admin and a lost phone there is no recovery path from the console.

### Console — separate subdomain

`admin.tryhive.in`, not a path on the marketing site (AR-01, AR-09).

```bash
cd web
NEXT_PUBLIC_ADMIN_API=https://api.tryhive.in npm run build
npm start
```

`NEXT_PUBLIC_ADMIN_API` is pinned into the CSP `connect-src`, so the console can
only talk to that one origin. Set `ADMIN_CONSOLE_ORIGIN` on the server to match —
it is the only origin the API accepts cross-origin requests from.

---

## Where things are

```
server/
  config/constants.js      Roles, the permission matrix, every fixed reason list, SLA windows
  config/tables.js         Table names; APPEND_ONLY_TABLES is what enforces L-02
  lib/store.js             Two drivers (memory, dynamodb) behind one interface
  lib/crypto.js            scrypt, TOTP, hashing — zero npm dependencies
  lib/audit.js             The append-only log and its hash chain
  lib/mask.js              PII masking and per-record unmask grants
  lib/sla.js               Grievance clock computation
  lib/seed.js              Demo fixtures
  middleware/adminAuth.js  AR-02 … AR-05. Read this first.
  middleware/rbac.js       Permission gates, reason enforcement, optimistic locking
  middleware/rateLimit.js  AR-07, AR-08
  controllers/             One per PRD section
  routes/index.js          Every route, annotated with the requirement it satisfies
  scripts/verifyAr03.js    The Phase 1 gate

web/
  middleware.ts            Per-request CSP nonce (AR-09)
  lib/api.ts               API client; the token lives here and only here
  lib/session.tsx          Session, idle countdown, permission checks
  components/              Shell, login, the reason dialog, the masked-value control
  app/                     One route per queue
```

---

## What is not built, and why

**§8.3 — the tax module (F-13 … F-17).** Gated on the CA consultation for 194-O
TDS and GST TCS applicability. The endpoints exist and return `501` with the
blocking dependency attached; the console shows the gate as an explicit blocked
state with the questions to ask. Building against a guess would mean companions
querying Form 16A figures that do not reconcile with what they were paid, and the
retrofit after six months of live payouts is a manual reconstruction of every
one. The PRD's own recommendation is to resolve this **before the v2.0 payout
code is written**, not before v2.1 — that ordering is the important part.

**U-07 — the KYC branch of the deletion retention record.** `tryhive.in/privacy`
says KYC data is deleted on account deletion; `tryhive.in/delete-account` says it
is retained up to 8 years for financial compliance. Both cannot be true. Rather
than pick one and quietly encode it, `ADMIN_KYC_RETENTION_POLICY` defaults to
`unresolved` and the deletion queue refuses to complete any deletion involving a
KYC record until someone sets it to `delete` or `retain`. Everything else in the
deletion queue works — blockers, deferral, the retention plan for all other
categories.

**U-08 — blocked-contact-share history.** Depends on v2.2 chat. The panel is
present and says so, rather than being silently absent.

---

## Open questions from PRD §14

Where the code takes a position, it is noted:

1. **Break-glass for a lost Super Admin 2FA device.** Partially handled:
   `resetAdminMfa` is Super-Admin-only and refuses the caller's own account, the
   last active Super Admin cannot be demoted or disabled, and the dashboard warns
   when there is only one. The documented human procedure is still needed.
2. **Dual-approval threshold.** Implemented at ₹5,000 as recommended,
   configurable via `ADMIN_DUAL_APPROVAL_THRESHOLD`. Needs confirmation.
3. **Is the Grievance Officer distinct from Super Admin?** Currently modelled as a
   Super Admin account (`grievance@tryhive.in`). If the published notice names an
   individual with specific duties, that argues for a distinct role.
4. **Data residency.** Not decided in code. `createAdminTables.js` uses
   `AWS_REGION` and defaults to `ap-south-1`.
5. **Who reviews the reviewers?** Unanswered. `GET /admin/audit/anomalies`
   surfaces Super Admin activity alongside everyone else's, which is visibility,
   not review.
6. **Retention of rejected KYC documents.** Still unspecified. Rejected
   submissions are currently retained indefinitely.

---

## Also read

- [`docs/DEPLOYING.md`](docs/DEPLOYING.md) — hosting it for your team, and what changes for the real thing
- [`docs/PRD-COVERAGE.md`](docs/PRD-COVERAGE.md) — every requirement ID and where it lives
- [`docs/SECURITY.md`](docs/SECURITY.md) — how AR-03 is enforced, and what to harden before go-live
- [`docs/FINDINGS.md`](docs/FINDINGS.md) — **issues found in `bond-srv` while building this.**
  One of them is a complete authentication bypass. Read it before Phase 1 ships.
