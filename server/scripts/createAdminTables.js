/**
 * Creates the admin-owned DynamoDB tables.
 *
 * Mirrors bond-srv/scripts/createTables.js in style. For production prefer the
 * CloudFormation template (admin-tables.yaml) so the audit table's separate
 * write role is provisioned with it — L-02 wants the write path held by
 * credentials that cannot update or delete.
 *
 *   ADMIN_DATA_DRIVER=dynamodb node scripts/createAdminTables.js
 */

require('dotenv').config();

const { DynamoDBClient, CreateTableCommand, DescribeTableCommand, UpdateTimeToLiveCommand } = require('@aws-sdk/client-dynamodb');
const { TABLES } = require('../config/tables');

const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-south-1' });

// Only the admin-owned tables. The consumer tables already exist.
const definitions = [
    { name: TABLES.ADMIN_USERS, key: 'adminId' },
    { name: TABLES.ADMIN_SESSIONS, key: 'sessionId', ttlAttribute: 'ttl' },
    { name: TABLES.AUDIT_LOG, key: 'eventId' },
    { name: TABLES.KYC_SUBMISSIONS, key: 'submissionId' },
    { name: TABLES.MODERATION_ITEMS, key: 'itemId' },
    { name: TABLES.REPORTS, key: 'reportId' },
    { name: TABLES.GRIEVANCES, key: 'grievanceId' },
    { name: TABLES.DISPUTES, key: 'disputeId' },
    { name: TABLES.PAYOUTS, key: 'payoutId' },
    { name: TABLES.REFUNDS, key: 'refundId' },
    { name: TABLES.BANK_ACCOUNTS, key: 'bankAccountId' },
    { name: TABLES.RECONCILIATION, key: 'reconId' },
    { name: TABLES.DELETION_REQUESTS, key: 'requestId' },
    { name: TABLES.UNMASK_GRANTS, key: 'grantId', ttlAttribute: 'ttl' },
    { name: TABLES.NOTIFICATIONS, key: 'notificationId' },
];

async function exists(name) {
    try {
        await client.send(new DescribeTableCommand({ TableName: name }));
        return true;
    } catch (err) {
        if (err.name === 'ResourceNotFoundException') return false;
        throw err;
    }
}

async function createTable({ name, key, ttlAttribute }) {
    if (await exists(name)) {
        console.log(`· ${name} already exists`);
        return;
    }

    await client.send(new CreateTableCommand({
        TableName: name,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [{ AttributeName: key, AttributeType: 'S' }],
        KeySchema: [{ AttributeName: key, KeyType: 'HASH' }],
        // L-06 / G-12 — retention floors are long, and a dropped table takes the
        // evidence with it. PITR is cheap insurance on every one of these.
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        SSESpecification: { Enabled: true },
        Tags: [
            { Key: 'Project', Value: 'hive' },
            { Key: 'Surface', Value: 'admin' },
            { Key: 'DataClass', Value: name === TABLES.AUDIT_LOG ? 'audit' : 'sensitive' },
        ],
    }));
    console.log(`✓ ${name} created`);

    if (ttlAttribute) {
        // Sessions and unmask grants are short-lived by design; letting DynamoDB
        // expire them means an abandoned grant cannot outlive its window because
        // a sweep job stopped running.
        await new Promise((r) => setTimeout(r, 5000));
        try {
            await client.send(new UpdateTimeToLiveCommand({
                TableName: name,
                TimeToLiveSpecification: { Enabled: true, AttributeName: ttlAttribute },
            }));
            console.log(`  ↳ TTL enabled on ${ttlAttribute}`);
        } catch (err) {
            console.warn(`  ↳ Could not enable TTL yet (${err.name}); rerun this script once the table is ACTIVE`);
        }
    }
}

(async () => {
    console.log(`Creating admin tables in ${process.env.AWS_REGION || 'ap-south-1'}…\n`);
    for (const def of definitions) {
        try {
            await createTable(def);
        } catch (err) {
            console.error(`✗ ${def.name}: ${err.message}`);
        }
    }
    console.log('\nDone. Next: node scripts/createSuperAdmin.js');
    console.log('Reminder: the audit table should be written by a role holding dynamodb:PutItem only (L-02).');
})();
