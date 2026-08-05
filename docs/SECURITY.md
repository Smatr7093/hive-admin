# Security notes

The PRD's framing in §1 is the right one: this interface touches KYC documents,
PAN numbers, bank accounts, addresses and every user's PII in one place, which
makes it a higher-value breach target than the consumer app. It was built to that
standard. This document records what was done, what it does and does not protect
against, and what still needs doing outside the codebase.

---

## AR-03 — consumer tokens cannot become admin tokens

The PRD calls this the single most important requirement in the document. It is
enforced in four independent layers, in `middleware/adminAuth.js`:

1. **A different signing key.** `ADMIN_JWT_SECRET` must be set, be at least 32
   characters, not look like a placeholder, and not equal `JWT_SECRET`.
   `assertSecretsAreSeparate()` runs at mount time and throws — the process
   refuses to start rather than serve a dashboard whose tokens the consumer flow
   could mint.
2. **Different issuer and audience claims**, both verified (`hive-admin` /
   `hive-admin-console`). `algorithms: ['HS256']` is pinned so the token header
   cannot select `none`.
3. **A `typ: 'admin'` claim**, verified. Consumer tokens carry `{ userId }` and
   nothing else. A token reaching `/admin` without this claim is refused *and
   logged as a failed login* — it is an attack signal, not a mistake.
4. **A server-side session record.** Only the admin login flow, after a satisfied
   TOTP challenge, writes one. A perfectly-forged token for a session that never
   existed is refused.

Layer 4 is the one worth understanding: **compromise of `ADMIN_JWT_SECRET` alone
is not enough.** An attacker with the key can sign whatever they like and still
cannot get past the session lookup.

`scripts/verifyAr03.js` automates the Phase 1 gate — eight attacks across six
protected routes:

```
✓ blocked  Consumer session token (the real thing, straight from authController)
✓ blocked  Consumer token with a forged role claim
✓ blocked  Consumer token carrying the admin typ/iss/aud claims
✓ blocked  Token signed with the default consumer secret bond-srv falls back to
✓ blocked  alg:none — unsigned token
✓ blocked  Correctly signed admin token for a session that was never created
✓ blocked  Admin token with the wrong issuer
✓ blocked  MFA challenge token used as a session token
✓ blocked  No token at all
49 checks, 0 breach(es).
```

Run it in CI on every change to the auth path. A refactor that collapses two of
those layers into one will still pass every functional test.

---

## Sessions

- **8-hour absolute lifetime, 30-minute idle timeout** (AR-04), both enforced
  server-side on every request. The console mirrors them in the sidebar and warns
  two minutes before the idle cut, because being signed out mid-decision without
  notice teaches people to draft their reasons somewhere else first.
- **TOTP on every sign-in** (AR-05). There is no trusted-device cookie, no
  "remember me", and no UI affordance suggesting one should exist. New accounts
  start in `pending_enrolment` and cannot do anything until an authenticator is
  bound.

  > **The one exception: `ADMIN_DEMO_SKIP_MFA=1`.** It collapses sign-in to one
  > step so the seeded demo can be walked through without an authenticator, and
  > it is fenced so it cannot follow a `.env` file into somewhere real:
  > `demoBypassActive()` requires the in-memory driver *and* a non-production
  > `NODE_ENV`, and `assertDemoBypassIsSafe()` **refuses to boot** if the flag is
  > set alongside either. A flag that is set but silently inert is how a bypass
  > survives into production, so it fails loudly instead. Sign-ins taken this way
  > carry `mfaBypassed: true` in the audit log and a reason naming the flag, and
  > the console shows a non-dismissible banner. `npm test` forces it off and
  > asserts every one of those conditions.
- **TOTP codes cannot be replayed** — the used counter is stored, so a code
  shoulder-surfed inside its 30-second window is dead.
- **Revocation** — a Super Admin can kill every session for an admin instantly
  (PRD §12). Changing a password revokes the account's other sessions.
- **Role is read from the account record, not the token**, so a role change or a
  disable takes effect on the next request rather than the next login.

### The token lives in memory

`web/lib/api.ts` holds it in a module variable. Not `localStorage`, not a cookie.

This costs a re-login on every page refresh, which is a real ergonomic cost. It
buys: closing the tab ends the session; a stolen laptop with a locked screen has
nothing on disk; there is no cookie, so there is no CSRF surface at all; and an
injected script has no persistent store to read. For a tool used by a handful of
people in eight-hour shifts, that trade is worth making.

---

## PII

- **Masked on the way out of the server, not in the browser.** A masked field is
  never sent over the wire, so "look at the network tab" is not an unmask.
- **Support sees masked values by default** (P-01). Ops, Finance and Super Admin
  hold `pii:view_unmasked`.
- **Unmasking needs a reason from a fixed list** (P-02) and is one audit event per
  unmask (L-04).
- **Grants are per-record, per-field, per-session, and expire in 15 minutes**
  (P-03). There is no global toggle, and `/pii/unmask` explicitly refuses a `*`
  wildcard rather than letting it fall through as an unknown field.
- **Document previews are watermarked server-side** (P-04). The image is embedded
  in an SVG the server composes with the viewing admin's ID and timestamp tiled
  across it, so the watermark cannot be removed by disabling CSS or editing the
  DOM. The raw document URL never reaches the client.
- **Downloads are separate, permission-gated and separately logged** (P-05).
- **Repeated unmasking surfaces on the Super Admin dashboard** (P-06) and in
  `/admin/audit/anomalies`.

The reasoning behind masking-by-default is in the PRD and worth repeating: the
realistic breach vector is a phished or stolen support laptop, not a server
exploit. Most support work never needs a full account number.

---

## The audit log

- **Append-only is structural, not a convention.** `APPEND_ONLY_TABLES` in
  `config/tables.js` makes the store throw on any update or delete against the
  audit table. There is no code path — not in a controller, not from a Super
  Admin session, not from a Node REPL inside the process — that can edit an
  entry. The smoke test asserts this from inside the process.
- **Each entry is hash-chained to the previous one.** This does not make the log
  tamper-proof; nothing at the application layer can. It makes tampering
  *detectable*: deleting or editing a row breaks every hash after it, and
  `GET /admin/audit/verify` reports exactly where.

### Still to do at the infrastructure layer

The application-level guarantee is only as good as the credentials underneath it.
Before go-live:

- Give the audit table its own IAM role holding `dynamodb:PutItem` and nothing
  else, and use it only for that write path. Today the application's normal
  credentials could delete the table.
- Enable point-in-time recovery on every admin table (`createAdminTables.js` sets
  this) and confirm it in the console.
- Consider streaming audit entries to CloudWatch Logs with a retention lock, or
  to S3 Object Lock in compliance mode. That gets you an append-only store the
  application's credentials genuinely cannot touch, which is what L-02 is really
  asking for.
- Retention is 3 years (L-06). Nothing currently deletes old entries; that is
  the safe default, but it should be a decision rather than an omission.

---

## Rate limiting and network

- Admin endpoints are limited **independently of consumer endpoints** (AR-08) —
  separate buckets, never shared state. Login is 10 per 15 minutes per IP+account,
  TOTP is 5 per 5 minutes, sensitive reads (unmask, documents) 20 per minute,
  exports 20 per hour.
- Accounts lock for 15 minutes after 5 failed passwords.
- **IP allowlist** (AR-07) is supported and off by default. IPv4 exact, prefix and
  CIDR; IPv6 ranges are not supported, so use exact matches there.

> **Known limitation:** the limiter is in-process. Behind more than one instance
> the effective limit multiplies by the instance count. That is tolerable for
> login (account lockout backs it up) but should move to DynamoDB or Redis before
> the admin surface is scaled horizontally.

---

## The console

- **Strict CSP with a per-request nonce** (`web/middleware.ts`). `script-src` is
  `'nonce-…' 'strict-dynamic'`, so only scripts Next itself emitted run —
  `'unsafe-inline'` would have made the whole policy decorative.
- `connect-src` is pinned to the admin API origin. A compromised dependency
  cannot exfiltrate a KYC document to another host; the browser will not open the
  connection.
- `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`,
  `Referrer-Policy: no-referrer` (the URL alone reveals which record was open),
  `Cache-Control: no-store`, and `robots: noindex, nocache`.
- Three runtime dependencies: `next`, `react`, `qrcode`. No icon library, no
  animation library, no analytics — every dependency here is supply-chain surface
  on the machine that renders KYC documents.
- `style-src` still needs `'unsafe-inline'` because the console styles inline. A
  style injection cannot execute code, so this is a much smaller concession than
  the script one, but it is worth closing if the styling ever moves into
  stylesheets.

---

## Concurrency and integrity

- **Optimistic locking on every mutation** (PRD §12). Clients echo the `version`
  they were shown; the DynamoDB driver uses a conditional write, so the second of
  two simultaneous actions gets a 409 rather than silently overwriting. The
  console reloads and tells the admin what happened.
- **Reasons are mandatory and come from fixed lists** (K-07, M-05, P-02, and the
  rest), enforced in middleware before the controller runs. Free-text reasons
  produce inconsistent decisions and rejection patterns nobody can query.
- **Approved KYC records are immutable** (K-12). Corrections write a new record
  carrying `supersedes`; the original keeps its decision and gains `supersededBy`.
- **Dual approval genuinely requires two people** (F-10) — the requester's own
  approval is refused by comparing admin IDs, not by asking nicely. The same
  applies to reconciliation corrections.
- **Server-side authority on money.** Refunds are capped at what was actually
  collected minus what has already been refunded, whatever the client sends.

---

## Break-glass — PRD §12 and open question 1

What the code does:

- `resetAdminMfa` is Super-Admin-only and **refuses to act on the caller's own
  account**, which makes "a second Super Admin" structural rather than a
  procedure someone has to remember.
- The last active Super Admin cannot be demoted or disabled.
- The dashboard and the admin accounts page both warn when only one Super Admin
  exists.
- Recovery codes are issued once at enrolment, stored only as hashes, and each is
  single-use.

What the code cannot do: if there is one Super Admin and they lose both their
device and their recovery codes, the only way back in is editing
`hive_admin_users` directly. **Write that procedure down, decide who is allowed
to run it, and make sure it is itself auditable.** That is the answer open
question 1 needs, and it should exist before Phase 1 ships.

---

## Threats this does not address

Stated plainly, because a security document that only lists wins is not useful:

- **A compromised admin acting within their permissions.** Everything they do is
  logged with a reason, and anomaly detection flags bulk actions, out-of-hours
  access and unusual unmask volume — but detection is after the fact. Open
  question 5 ("who reviews the reviewers?") is the unanswered part of this.
- **A compromised server.** Nothing at the application layer survives root on the
  box. The audit hash chain makes tampering detectable, which is a different and
  weaker guarantee.
- **The consumer API.** Several findings in [`FINDINGS.md`](FINDINGS.md) reach the
  same data without touching `/admin` at all. One of them is a complete
  authentication bypass. **The pen test in §15 should cover both surfaces**, or it
  will certify a hardened front door on a building with an open window.
