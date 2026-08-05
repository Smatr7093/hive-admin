# PRD coverage — every requirement ID

Status key: **✅ built** · **🔒 gated** (blocked on a decision outside engineering) ·
**⏳ deferred** (depends on unshipped work).

---

## §3 Architecture

| ID | Requirement | Status | Where |
|---|---|---|---|
| AR-01 | Separate frontend, deployed independently | ✅ | `web/` — its own Next.js app, own build, own deploy |
| AR-02 | `/admin` namespace with completely separate auth | ✅ | `server/routes/index.js` mounts nothing from `bond-srv/middleware` |
| AR-03 | Admin tokens not mintable by the consumer flow | ✅ | `middleware/adminAuth.js`, four layers; `scripts/verifyAr03.js` proves it |
| AR-04 | 8h max lifetime, 30min idle | ✅ | `adminAuth.js` `requireAdmin`; mirrored in `web/lib/session.tsx` |
| AR-05 | Mandatory TOTP, no bypass | ✅ | `controllers/authController.js` — login returns a challenge, never a token. A demo-only bypass exists (`ADMIN_DEMO_SKIP_MFA`) that cannot engage against DynamoDB or in production and refuses to boot if configured to try — see [SECURITY.md](SECURITY.md) |
| AR-06 | Super Admin creates accounts; no self-registration | ✅ | `POST /admin/admins` + `scripts/createSuperAdmin.js`. No public registration route exists |
| AR-07 | IP allowlist, configurable, off by default | ✅ | `middleware/rateLimit.js` `ipAllowlist` |
| AR-08 | Admin endpoints rate-limited independently | ✅ | `middleware/rateLimit.js` — separate buckets, five tiers |
| AR-09 | Distinct subdomain, strict CSP, no third-party scripts | ✅ | `web/middleware.ts` nonce CSP; three runtime deps total |

## §4 Roles and PII

| ID | Requirement | Status | Where |
|---|---|---|---|
| — | Five roles, no more | ✅ | `config/constants.js` `ROLES` / `ROLE_PERMISSIONS` |
| P-01 | Bank/PAN/KYC masked by default for Support | ✅ | `lib/mask.js` `maskFor`, applied server-side |
| P-02 | Unmask needs a fixed reason, logged with actor and time | ✅ | `controllers/piiController.js`; `UNMASK_REASONS` |
| P-03 | Grants per-record, per-session — never global | ✅ | `lib/mask.js` `createGrant`; wildcard explicitly refused |
| P-04 | Document previews watermarked with admin ID + timestamp | ✅ | `kycController.watermarkedSvg` — composed server-side |
| P-05 | Downloads logged separately, Ops and Super Admin only | ✅ | `kycController.document`, `PERM.KYC_DOC_DOWNLOAD` |
| P-06 | Repeated unmasks surface to Super Admin | ✅ | `lib/mask.js` `unmaskVolumeByAdmin`; dashboard + anomalies |

## §5 KYC

| ID | Requirement | Status | Where |
|---|---|---|---|
| K-01 | Oldest first, time in queue shown | ✅ | `kycController.queue` — sort is not client-controllable |
| K-02 | Watermarked preview + extracted fields + profile side by side | ✅ | `web/app/kyc/[submissionId]/page.tsx` |
| K-03 | Age check ≥18 computed and prominent | ✅ | `ageCheck()`; approval refused without an explicit override |
| K-04 | Duplicate detection on hashed ID number | ✅ | `duplicateMatches()`, `crypto.hashIdentifier` |
| K-05 | Submission attempt count displayed | ✅ | Queue and detail |
| K-06 | Approve · Reject · Request resubmission | ✅ | Three routes, three dialogs |
| K-07 | Fixed rejection reason list | ✅ | `KYC_REJECTION_REASONS`, enforced by `requireReason` middleware |
| K-08 | Optional free-text note alongside | ✅ | `note` on every decision |
| K-09 | 3 rejections → manual review, not a hard block | ✅ | `kycController.reject` |
| K-10 | Resubmission up to 3 times in 7 days | ✅ | `requestResubmission` |
| K-11 | Companion notified of decision and reason immediately | ✅ | `lib/notify.js` on every decision path |
| K-12 | Approved records immutable; corrections supersede | ✅ | `kycController.correct` — writes a new record, links both ways |

## §6.1 Moderation

| ID | Requirement | Status | Where |
|---|---|---|---|
| M-01 | Queue for new companion profiles | ✅ | `moderationController.queue`, `type: new_profile` |
| M-02 | Edited profiles re-enter approval | ✅ | `type: profile_edit`; `submitEdit()` is the hook for the consumer app |
| M-03 | Side-by-side diff | ✅ | `moderationController.detail` returns a field-level diff |
| M-04 | Previous approved version stays live while pending | ✅ | The edit is never applied until approval; stated on screen |
| M-05 | Fixed rejection reasons, aligned to the guidelines | ✅ | `MODERATION_REJECTION_REASONS` |
| M-06 | Escalate on suspected sexual solicitation | ✅ | Reasons carry `escalates: true` — escalation is automatic, not remembered |

## §6.2 Reports

| ID | Requirement | Status | Where |
|---|---|---|---|
| M-07 | Every report becomes a timestamped ticket | ✅ | `TABLES.REPORTS` |
| M-08 | Reporter, reported party, category, detail, booking | ✅ | `reportController.detail` |
| M-09 | Reporter identity never disclosed | ✅ | Enforcement notices are composed server-side; the user profile omits who they reported |
| M-10 | Enforcement ladder inline | ✅ | `ENFORCEMENT_ACTIONS`; `applyEnforcement` carries each into the systems it affects |
| M-11 | Every action needs a reason and is logged | ✅ | 10-character minimum, then `audit.record` |
| M-12 | Prior reports involving either party on the ticket | ✅ | `reportController.detail` `history` |

## §6.3 Grievance SLA

| ID | Requirement | Status | Where |
|---|---|---|---|
| G-01 | In-app, email and postal all become tickets | ✅ | `POST /admin/grievances`, `GRIEVANCE_CHANNELS` |
| G-02 | Automatic acknowledgement within 24h | ✅ | `runAcknowledgementSweep` — idempotent, on every list request and a 5-min timer |
| G-03 | Countdowns to both deadlines | ✅ | `lib/sla.js` `computeSla` |
| G-04 | Colour-coded escalation; breach unmissable | ✅ | Four states, one colour scale, used identically everywhere |
| G-05 | Separate urgent track, 24h action deadline | ✅ | `URGENT_GRIEVANCE_CATEGORIES`; `urgentAction` is its own clock |
| G-06 | Urgent tickets cannot be filtered out of view | ✅ | Filters apply to the standard track only; urgent items are unioned back in and labelled `pinnedByUrgency` |
| G-07 | Assignment; unassigned flagged after 4h | ✅ | `sla.assignment` |
| G-08 | Resolution requires a decision and reasoning | ✅ | 20-character minimum, refused otherwise |
| G-09 | Complainant told the outcome and the reason | ✅ | `grievanceController.resolve` → `notify` |
| G-10 | Appeal path recorded, 30-day window tracked | ✅ | `recordAppeal` / `decideAppeal`; window computed from resolution |
| G-11 | Export for a date range | ✅ | `GET /admin/grievances/export` — JSON or CSV, both SLA clocks, the export itself logged |
| G-12 | Retained 180 days from resolution | ✅ | `sla.retention.purgeableAfter`; nothing deletes before it |

## §7 Bookings and disputes

| ID | Requirement | Status | Where |
|---|---|---|---|
| B-01 | Search by ID, user, companion, date, status | ✅ | `bookingController.search` |
| B-02 | Full timeline with timestamps | ✅ | `buildTimeline` — unreached stages render as gaps, not omissions |
| B-03 | Force-complete with reason, logged | ✅ | `BOOKING_FORCE_REASONS` |
| B-04 | Force-cancel with refund, with reason, logged | ✅ | Raises a refund; amount capped server-side |
| B-05 | Check-in failure tickets | ✅ | `checkInFailure` on the booking detail |
| B-06 | No-show reports from both parties | ✅ | `noShowReports` |
| B-07 | Manual reliability adjustment, logged | ✅ | `adjustReliability` |
| B-08 | Dispute queue with 24h window state | ✅ | `bookingController.disputes` |
| B-09 | Alert on a block during an active booking | ✅ | `recordBlockDuringBooking` — Super Admin alert, top of the queue, labelled a safety signal |

## §8.1–8.2 Finance

| ID | Requirement | Status | Where |
|---|---|---|---|
| F-01 | Payout queue across all states | ✅ | `financeController.payouts` |
| F-02 | Hold with reason, logged | ✅ | `PAYOUT_HOLD_REASONS` |
| F-03 | Release with reason, logged | ✅ | Blocked inside the cooling-off window without an override |
| F-04 | Failed payout detail + retry | ✅ | Gateway error surfaced verbatim |
| F-05 | Verified fund account, masked per §4 | ✅ | Via `maskFor` |
| F-06 | 48h cooling-off after a bank change | ✅ | `coolingOffState`; override alerts Super Admin |
| F-07 | Alert when one account serves several profiles | ✅ | `hashBankAccount` collisions — flagged on the payout, the account, and the dashboard |
| F-08 | Daily reconciliation with discrepancies flagged | ✅ | Five discrepancy types including the §12 failed-after-paid case |
| F-09 | Manual refund, full or partial, with reason | ✅ | Amount capped at what was collected minus what was already refunded |
| F-10 | Dual approval above a threshold | ✅ | Requester's own approval refused by comparing admin IDs. Default ₹5,000, configurable |
| F-11 | Refund history per user and companion | ✅ | `refundHistory` |
| F-12 | Goodwill credits for Support below a ceiling | ✅ | `issueGoodwill`, ₹500 default |

## §8.3 Tax — 🔒 gated

| ID | Requirement | Status | Where |
|---|---|---|---|
| F-13 | PAN collected and validated per companion | 🔒 | `controllers/taxController.js` |
| F-14 | Per-payout gross / deduction / net stored separately | 🔒 | Data model sketched in `taxController.GATE` |
| F-15 | Quarterly TDS filing export | 🔒 | |
| F-16 | Form 16A per companion per quarter | 🔒 | |
| F-17 | GST TCS reporting export | 🔒 | |

All five return `501` with the blocking dependency attached. `GET /admin/tax/status`
returns the gate, the questions for the CA, and the payout fields that must exist
from day one if the answer is yes. The console renders it as an explicit blocked
state. **The PRD's own recommendation — resolve this before v2.0 payout code is
written — is the load-bearing part.**

## §9 Users

| ID | Requirement | Status | Where |
|---|---|---|---|
| U-01 | Search by name, phone, email, ID | ✅ | `userController.search` |
| U-02 | Full profile: registration, verification, bookings, reports, moderation | ✅ | `userController.detail` |
| U-03 | Suspend with reason and duration, logged | ✅ | `SUSPENSION_REASONS` |
| U-04 | Permanent removal, Super Admin only | ✅ | `requireSuperAdmin`; refused while obligations are open |
| U-05 | Process deletion requests | ✅ | `deletionQueue` / `processDeletion` |
| U-06 | Queue shows blockers | ✅ | `deletionBlockers` — payouts, disputes, active bookings, open grievances |
| U-07 | Retention state per deleted account, with basis | 🔒 | `retentionPlan` is built and shown; the **KYC branch is blocked** — see below |
| U-08 | Blocked-contact-share attempt history | ⏳ | Depends on v2.2 chat. Declared in the API and rendered as pending, not omitted |

> **U-07.** Every other retention category resolves and records its basis. KYC does
> not: `tryhive.in/privacy` says the data is deleted on account deletion,
> `tryhive.in/delete-account` says it is retained up to 8 years for financial
> compliance. `ADMIN_KYC_RETENTION_POLICY` defaults to `unresolved` and the queue
> refuses to complete any deletion holding KYC records, because U-07 requires the
> record to state which basis applied and there is no correct answer to record yet.
> Setting it to `delete` or `retain` unblocks it.

## §10 Audit log

| ID | Requirement | Status | Where |
|---|---|---|---|
| L-01 | Actor, role, time, target, action, reason, before/after | ✅ | `lib/audit.js` `record` |
| L-02 | Append-only — nobody can edit or delete | ✅ | Enforced by the store via `APPEND_ONLY_TABLES`, plus a hash chain to make tampering detectable |
| L-03 | Searchable by actor, target, action, date | ✅ | `auditController.search` |
| L-04 | Every unmask and document view its own event | ✅ | `pii.unmasked`, `document.viewed`, `document.downloaded` |
| L-05 | Every login, failed login and 2FA failure | ✅ | Including tokens rejected at the `typ` check |
| L-06 | Retained 3 years minimum | ✅ | `SLA.AUDIT_RETENTION_DAYS`; nothing deletes |
| L-07 | Anomaly alerts: bulk, out-of-hours, unusual unmask volume | ✅ | `auditController.anomalies` — all three, plus auth failures |
| L-08 | Export for a date range | ✅ | JSON or CSV; the export is itself logged |

## §11 Operational dashboard

Every counter listed in the PRD is present, in that order:
open KYC with oldest age · grievances by SLA state with breach count · urgent-track
outstanding · reports by severity · payouts pending/failed/held · bookings in
dispute · deletion requests pending and blocked · admin actions in 24h by role.

Counters only — no charts, no revenue, no BI. `controllers/dashboardController.js`.

## §12 Edge cases

| Case | Handled |
|---|---|
| Admin account compromised | ✅ `POST /admin/admins/:id/revoke-sessions` — one click from the account row |
| Super Admin loses 2FA device | ✅ Reset is Super-Admin-only and refuses the caller's own account. Break-glass procedure still needs writing (open question 1) |
| Two admins action the same ticket | ✅ Optimistic locking; conditional write on DynamoDB; the console reloads and explains |
| Grievance arrives by post | ✅ `receivedAt` required and separate from `enteredAt`; SLA runs from receipt |
| Complainant is not a Hive user | ✅ `complainantEmail` alone is sufficient |
| Companion deletes with an open grievance | ✅ Deletion deferred, blocker surfaced |
| Payout fails after the ledger says paid | ✅ `failed_after_paid` discrepancy; correction is dual-approved |
| KYC name differs due to marriage | ✅ Not a rejection reason; the screen says so and the note carries the decision |
| Law enforcement request | ✅ `G-11` / `L-08` exports, both logged with the stated reason |

## §13 Rollout

| Phase | Scope | Gate | State |
|---|---|---|---|
| 1 | Auth, RBAC, audit, admin accounts | AR-03 verified by attempted escalation | ✅ built; `npm run verify:ar03` automates the gate. **External pen test still required** |
| 2 | KYC + profile moderation | Median decision < 12h for a week | ✅ built; the dashboard tracks the metric |
| 3 | Grievance SLA queue | 100% acknowledgement in 24h over 20 tickets | ✅ built; acknowledgement is automatic, and the export evidences it |
| 4 | Bookings, disputes, users | Zero unlogged privileged actions in a sample | ✅ built; no mutation route exists without `audit.record` |
| 5 | Finance | Zero reconciliation discrepancies over 100 payouts | ✅ built |
| 6 | Tax | CA consultation | 🔒 gated |
