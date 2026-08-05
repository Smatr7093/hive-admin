/**
 * Tax module (PRD §8.3) — GATED, NOT IMPLEMENTED.
 *
 * This file exists so the gate is visible in the codebase rather than living
 * only in a document. F-13..F-17 are marked "P0 (if applicable)" precisely
 * because nobody yet knows whether they apply.
 *
 * What is blocked and why:
 *
 *   Hive is likely an e-commerce operator under Indian tax law, which may bring
 *   Section 194-O TDS on payments to companions and GST TCS obligations. Whether
 *   they apply, at what rate, and above what threshold depends on Siante's
 *   structure and turnover. That is a CA question.
 *
 * Why guessing is worse than waiting:
 *
 *   F-14 requires gross / deduction / net stored *separately per payout*. If
 *   payouts ship storing a single net figure and TDS turns out to apply, every
 *   Form 16A generated afterwards reconciles against a number that was never
 *   recorded. Retrofitting after six months of live payouts means companions
 *   querying certificates that do not match what they received — and the fix is
 *   a manual reconstruction of every payout in the period.
 *
 * The PRD's recommendation is to resolve this before the v2.0 payout code is
 * written, not before v2.1. That ordering is the important part.
 */

const GATE = {
    blocked: true,
    blockedOn: 'CA consultation on Section 194-O TDS and GST TCS applicability',
    blocksAlso: 'v2.0 payout data model (§5.2)',
    requirements: [
        { id: 'F-13', requirement: 'PAN collected and validated per companion, with a validation status' },
        { id: 'F-14', requirement: 'Per-payout gross / deduction / net stored and displayed separately' },
        { id: 'F-15', requirement: 'Quarterly TDS filing export in the required format' },
        { id: 'F-16', requirement: 'Form 16A generation per companion per quarter' },
        { id: 'F-17', requirement: 'GST TCS reporting export' },
    ],
    questionsForTheCA: [
        'Is Siante Technologies Private Limited an e-commerce operator under s.194-O?',
        'If so, what rate applies to companion payouts, and above what annual threshold per companion?',
        'Does the ₹5,00,000 individual/HUF exemption apply to Hive companions?',
        'Do GST TCS obligations apply at 1%, and from which turnover point?',
        'Is the platform fee or the gross booking value the base for each?',
        'Are quarterly filings 26Q, or another form, and in whose name?',
        'Data residency: must payout and tax records be stored in India? (PRD open question #4)',
    ],
    // What the payout record must carry from day one if the answer is "yes".
    dataModelIfApplicable: {
        payout: {
            grossAmountPaise: 'Booking value attributable to the companion, before any deduction',
            tdsDeductionPaise: 'Section 194-O deduction at the applicable rate',
            tdsRateBps: 'Rate in basis points, stored per payout — rates change',
            gstTcsPaise: 'GST TCS collected, if applicable',
            netAmountPaise: 'What actually reaches the bank account',
            panAtDeduction: 'PAN on file at the moment of deduction, hashed',
            financialQuarter: 'e.g. 2026-Q2 — the filing bucket',
            filingReference: 'Populated once the quarterly return is filed',
        },
    },
};

/** GET /admin/tax/status — the console renders this as an explicit blocked state. */
exports.status = (_req, res) => res.status(200).json({
    success: true,
    enabled: false,
    data: GATE,
    message: 'The tax module is gated on the CA consultation. See PRD §8.3 and §15.',
});

/** Every F-13..F-17 route answers the same way until the gate lifts. */
exports.gated = (_req, res) => res.status(501).json({
    success: false,
    code: 'TAX_MODULE_GATED',
    message: 'Not implemented — blocked on the CA consultation for 194-O TDS and GST TCS applicability (PRD §8.3, §15).',
    data: GATE,
});

exports.GATE = GATE;
