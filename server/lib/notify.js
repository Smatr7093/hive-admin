/**
 * Outbound notifications.
 *
 * K-11, G-02, G-09 and M-11 all require the affected party to be told something.
 * Rather than scatter provider calls through the controllers, every one of those
 * writes a notification record and hands it to whatever transport is configured.
 *
 * bond-srv has no notification transport yet (authController still console.logs
 * OTPs — see docs/FINDINGS.md), so the default transport persists the record and
 * logs it. When SNS/SES/FCM lands, `deliver` is the one function that changes,
 * and the queued rows are the backlog to replay.
 */

const { store, TABLES } = require('./store');
const { randomId } = require('./crypto');

async function deliver(notification) {
    // Replace with SES (email) / SNS or FCM (push) when the transport exists.
    if (process.env.ADMIN_NOTIFY_VERBOSE !== '0') {
        console.log(`[notify:${notification.channel}] → ${notification.userId ?? notification.email}: ${notification.title}`);
    }
    return { delivered: false, queued: true };
}

async function notifyUser({
    userId = null,
    email = null,
    channel,
    title,
    body,
    relatedType = null,
    relatedId = null,
    automatic = false,
}) {
    const notification = {
        notificationId: randomId('ntf'),
        userId,
        email,
        channel,
        title,
        body,
        relatedType,
        relatedId,
        automatic,
        createdAt: new Date().toISOString(),
        status: 'queued',
    };
    const result = await deliver(notification);
    notification.status = result.delivered ? 'sent' : 'queued';
    await store.put(TABLES.NOTIFICATIONS, notification);
    return notification;
}

/** Anything the Super Admin needs to see on the dashboard (L-07, F-07, B-09). */
async function alertSuperAdmin({ kind, title, body, severity = 'warning', relatedType, relatedId }) {
    return notifyUser({
        userId: null,
        email: 'super-admin',
        channel: 'admin_alert',
        title,
        body,
        relatedType,
        relatedId,
        automatic: true,
    }).then(async (n) => {
        await store.patch(TABLES.NOTIFICATIONS, n.notificationId, { kind, severity });
        return n;
    });
}

async function listForUser(userId) {
    return store.list(TABLES.NOTIFICATIONS, { filter: (n) => n.userId === userId });
}

module.exports = { notifyUser, alertSuperAdmin, listForUser };
