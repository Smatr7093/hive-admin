# Findings in `bond-srv` — read this before Phase 1 ships

While building the admin surface I read the whole of `bond-srv-main`. The PRD's
security framing (§1) says the admin panel is a higher-value breach target than
the consumer app. That is true, but it assumes the consumer app is sound, and
several of the items below mean an attacker does not need the admin panel at all.

Nothing here was changed — these are consumer-side and outside the scope of what
was asked for. They are listed in the order I would fix them.

---

## 1. OTP verification is commented out — full authentication bypass

`controllers/authController.js`, `otpLogin`, lines 149–158. The three checks that
validate the OTP are commented out:

```js
// if (!stored) { ... }
// if (Date.now() > stored.expiresAt) { ... }
// if (stored.otp !== String(otp)) { ... }
```

The handler then proceeds to mint a 30-day JWT for `phone_${phone}`.

**Anyone can sign in as any phone number or email address** by posting to
`/auth/otp` with an arbitrary OTP. No prior `send-otp` call is needed — the
`otpStore` lookup result is discarded. This includes accounts belonging to
companions with KYC on file.

This is almost certainly a debugging shortcut that was never reverted. It should
be the first thing fixed, before anything in this repository ships.

## 2. A Firebase service-account private key is in the repository

`hive-sandbox-bf51e-firebase-adminsdk-fbsvc-ea4a356ba8.json` is committed at the
project root and present in `bond-srv-main.zip`. It contains a private key with
Firebase Admin privileges — which includes minting tokens for any user.

**Rotate the key in the Firebase console, remove the file from the repository and
from git history, and load the credential from the environment instead.** Anyone
who has ever had a copy of that zip holds the key; treat it as compromised.

## 3. `JWT_SECRET` has a hardcoded fallback

`middleware/authMiddleware.js:3`

```js
const JWT_SECRET = process.env.JWT_SECRET || 'hive_secret_key_change_in_prod';
```

If the environment variable is missing in any deploy, every consumer token is
signable by anyone who has read the source. The same pattern is in
`authController.js:8` for `GOOGLE_CLIENT_ID`.

The admin module deliberately does the opposite: `assertSecretsAreSeparate()`
refuses to start the process rather than fall back to a default. The consumer
side should do the same — a service that is down is recoverable, a service
signing tokens with a public secret is not.

*This is also why `verifyAr03.js` includes an explicit attack that signs an admin
token with `'hive_secret_key_change_in_prod'`. It is blocked, but only because
the admin surface uses a different key.*

## 4. The KYC "admin" endpoints have no admin check

`routes/kycRoutes.js` is mounted at `app.use("/kyc", verifyToken, kycRoutes)`.
`verifyToken` establishes only that the caller holds *some* valid consumer token.

- `PATCH /kyc/:userId/approve` — **any signed-in user can approve their own KYC**,
  or anyone else's, by passing `{ approved: true }`. This sets `isKycVerified`
  and `kycStatus: "approved"` directly on the companion record.
- `GET /kyc/pending` — returns every pending applicant's name, profile image and
  `kycDocumentUrl` to any signed-in user.
- `PATCH /kyc/:userId/upi` — any signed-in user can set **any companion's UPI ID**,
  which is the destination shown to seekers for manual payment.

Combined with finding 1, this is: sign in as anyone → approve yourself → redirect
another companion's payments.

Once the admin dashboard is live these three routes should be deleted from the
consumer surface entirely. The admin module supersedes them.

## 5. No ownership checks anywhere — IDOR throughout

The v1 security review's IDOR note is unaddressed. Every one of these takes the
subject from the request rather than from the token:

| Endpoint | Problem |
|---|---|
| `GET /bookings?userId=X` | Returns any user's booking history |
| `GET /bookings/companion?companionId=X` | Returns any companion's bookings |
| `PATCH /bookings/:bookingId` | Any user can accept, complete or cancel any booking |
| `PATCH /bookings/:bookingId/rating` | Any user can rate any booking |
| `POST /cpnlt` (`createCompanion`) | Body is written to DynamoDB verbatim, including `isVerified` and `rating` |
| `POST /kyc/presign` | `userId` comes from the body, not the token |

The fix is the same in each case: derive the subject from `req.user.userId` and
compare, or reject. `middleware/rbac.js` in this module has a `requireRecordScope`
helper that shows the shape.

## 6. Money amounts are taken from the client

`controllers/bookingController.js`, `createBooking`, lines 38–58. `pricePerHour`,
`baseAmount`, `platformFee` and `totalAmount` are all read from `req.body` and
stored as sent.

A client can book a ₹1,200 companion for ₹1. The server never consults the
companion's actual price.

This is the "server-side authority on all money amounts" item carried from the v1
review. It matters more now: the admin dashboard's refund logic caps refunds at
`booking.totalAmount`, so a manipulated booking total propagates into finance.

## 7. `GET /images/:filename` — unauthenticated-equivalent access to KYC documents

`routes/kyc.js:127`

```js
const { filename } = req.params;
const s3Key = `kyc/${filename}`;
```

Any signed-in user can fetch any KYC document if they know or can guess the
filename — and the filename is derived from `userId` plus a timestamp, and is
returned in full by `GET /kyc/pending` (finding 4).

There is no ownership check, no admin check, and `filename` is not validated
before being concatenated into the S3 key.

The admin module never exposes raw document bytes on a guessable path: previews
are watermarked and composed server-side, downloads require the
`kyc:doc:download` permission, and both are logged as separate audit events.

## 8. Consumer tokens live for 30 days with no revocation

`authController.js:47` — `expiresIn: '30d'`, and there is no session record, so a
leaked token is valid for a month and cannot be invalidated. A "sign out
everywhere" feature is impossible to build against this.

The admin module uses server-side sessions precisely so revocation is possible
(PRD §12). The consumer side would benefit from the same, or at minimum a
`tokenVersion` on the user record that `verifyToken` checks.

## 9. Smaller items

- `otpStore` is a process-local `Map`. Multi-instance deployments will fail OTP
  verification unpredictably once finding 1 is fixed. Use DynamoDB with TTL.
- `scripts/set-s3-cors.js` and the S3 bucket policy should be checked — KYC
  documents in a bucket with permissive CORS is a browser-side exfiltration path.
- `getUserBookings` does a full table `Scan` with a filter despite
  `UserCreatedAtIndex` existing on the table (`tables.yaml:92`). Correctness is
  fine; cost and latency will not be as the table grows.

---

## What this means for the rollout

PRD §13 gates Phase 1 on a penetration test of the admin surface. That gate is
the right one, but it will pass while findings 1, 4 and 7 leave the same data
reachable through the consumer API.

Suggested order:

1. Fix finding 1 (OTP bypass) — today.
2. Rotate the Firebase key (finding 2).
3. Delete the three `/kyc` admin routes from `bond-srv` once this dashboard is
   deployed (finding 4).
4. Add ownership checks and server-side pricing (findings 5, 6) before Phase 5,
   since the finance module operates on the values they produce.
5. Include the consumer API in the same pen test, not just `/admin`.
