/**
 * Storage layer.
 *
 * Two drivers behind one interface:
 *   ADMIN_DATA_DRIVER=memory   in-process store, seeded with demo data (default)
 *   ADMIN_DATA_DRIVER=dynamodb DynamoDB via the same docClient bond-srv uses
 *
 * The memory driver exists so the console can be run, demoed and pen-tested
 * without an AWS account. It is not a mock of a subset — both drivers implement
 * the same operations against the same item shapes, so switching is a one-line
 * env change.
 *
 * Append-only tables (L-02) are enforced here rather than in the controllers:
 * the audit log has no update or delete path at all, so no future controller can
 * accidentally acquire one.
 */

const { TABLES, APPEND_ONLY_TABLES, TABLE_KEYS } = require('../config/tables');

const DRIVER = (process.env.ADMIN_DATA_DRIVER || 'memory').toLowerCase();

// ─── Errors ──────────────────────────────────────────────────────────────────

class ConflictError extends Error {
    constructor(message = 'Record was modified by another admin') {
        super(message);
        this.name = 'ConflictError';
        this.status = 409;
        this.code = 'VERSION_CONFLICT';
    }
}

class AppendOnlyViolation extends Error {
    constructor(table) {
        super(`Table '${table}' is append-only; updates and deletes are not permitted`);
        this.name = 'AppendOnlyViolation';
        this.status = 500;
        this.code = 'APPEND_ONLY';
    }
}

// ─── Memory driver ───────────────────────────────────────────────────────────

function createMemoryDriver() {
    /** @type {Map<string, Map<string, object>>} */
    const tables = new Map();
    for (const name of Object.values(TABLES)) tables.set(name, new Map());

    const keyOf = (table, item) => {
        const attr = TABLE_KEYS[table];
        if (!attr) throw new Error(`Unknown table '${table}'`);
        const value = typeof item === 'object' && item !== null ? item[attr] : item;
        if (value === undefined || value === null) {
            throw new Error(`Missing key attribute '${attr}' for table '${table}'`);
        }
        return String(value);
    };

    const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

    return {
        name: 'memory',

        async get(table, key) {
            return clone(tables.get(table).get(keyOf(table, key)));
        },

        async put(table, item) {
            const stored = { ...item, version: item.version ?? 1 };
            tables.get(table).set(keyOf(table, stored), clone(stored));
            return clone(stored);
        },

        async patch(table, key, patch, { expectedVersion } = {}) {
            if (APPEND_ONLY_TABLES.has(table)) throw new AppendOnlyViolation(table);
            const map = tables.get(table);
            const id = keyOf(table, key);
            const current = map.get(id);
            if (!current) return null;
            if (expectedVersion !== undefined && current.version !== expectedVersion) {
                throw new ConflictError();
            }
            const next = { ...current, ...patch, version: (current.version ?? 1) + 1 };
            map.set(id, clone(next));
            return clone(next);
        },

        async remove(table, key) {
            if (APPEND_ONLY_TABLES.has(table)) throw new AppendOnlyViolation(table);
            return tables.get(table).delete(keyOf(table, key));
        },

        async list(table, { filter, limit } = {}) {
            let items = [...tables.get(table).values()].map(clone);
            if (filter) items = items.filter(filter);
            if (limit) items = items.slice(0, limit);
            return items;
        },

        async count(table, filter) {
            const items = await this.list(table, { filter });
            return items.length;
        },

        /** Test/seed helper — not part of the driver contract used by controllers. */
        _reset() {
            for (const map of tables.values()) map.clear();
        },
    };
}

// ─── DynamoDB driver ─────────────────────────────────────────────────────────

function createDynamoDriver() {
    // Required lazily so the memory driver never pulls in the AWS SDK.
    const {
        GetCommand, PutCommand, UpdateCommand, DeleteCommand, ScanCommand,
    } = require('@aws-sdk/lib-dynamodb');
    const { docClient } = require(process.env.ADMIN_DOCCLIENT_PATH || '../../../config/db');

    const keyObj = (table, item) => {
        const attr = TABLE_KEYS[table];
        const value = typeof item === 'object' && item !== null ? item[attr] : item;
        return { [attr]: String(value) };
    };

    // Attribute names that collide with DynamoDB reserved words show up all over
    // these item shapes (status, role, name, action, timestamp...), so every
    // patch goes through placeholders.
    const buildUpdate = (patch, nextVersion) => {
        const names = {};
        const values = { ':__v': nextVersion };
        const sets = ['#__version = :__v'];
        names['#__version'] = 'version';
        let i = 0;
        for (const [k, v] of Object.entries(patch)) {
            if (k === 'version') continue;
            const n = `#p${i}`;
            const val = `:p${i}`;
            names[n] = k;
            values[val] = v;
            sets.push(`${n} = ${val}`);
            i++;
        }
        return { UpdateExpression: `SET ${sets.join(', ')}`, names, values };
    };

    return {
        name: 'dynamodb',

        async get(table, key) {
            const res = await docClient.send(new GetCommand({ TableName: table, Key: keyObj(table, key) }));
            return res.Item ?? undefined;
        },

        async put(table, item) {
            const stored = { ...item, version: item.version ?? 1 };
            await docClient.send(new PutCommand({ TableName: table, Item: stored }));
            return stored;
        },

        async patch(table, key, patch, { expectedVersion } = {}) {
            if (APPEND_ONLY_TABLES.has(table)) throw new AppendOnlyViolation(table);
            const current = await this.get(table, key);
            if (!current) return null;
            if (expectedVersion !== undefined && current.version !== expectedVersion) {
                throw new ConflictError();
            }
            const nextVersion = (current.version ?? 1) + 1;
            const { UpdateExpression, names, values } = buildUpdate(patch, nextVersion);
            try {
                const res = await docClient.send(new UpdateCommand({
                    TableName: table,
                    Key: keyObj(table, key),
                    UpdateExpression,
                    // The conditional write is what actually makes §12's
                    // "two admins action the same ticket" case safe — the read
                    // above only narrows the race, it does not close it.
                    ConditionExpression: 'attribute_not_exists(#__version) OR #__version = :__expected',
                    ExpressionAttributeNames: names,
                    ExpressionAttributeValues: { ...values, ':__expected': current.version ?? 1 },
                    ReturnValues: 'ALL_NEW',
                }));
                return res.Attributes;
            } catch (err) {
                if (err.name === 'ConditionalCheckFailedException') throw new ConflictError();
                throw err;
            }
        },

        async remove(table, key) {
            if (APPEND_ONLY_TABLES.has(table)) throw new AppendOnlyViolation(table);
            await docClient.send(new DeleteCommand({ TableName: table, Key: keyObj(table, key) }));
            return true;
        },

        async list(table, { filter, limit } = {}) {
            // Scan + in-process predicate, matching the access pattern already
            // used across bond-srv's controllers. Admin queues are operator-sized
            // (hundreds, not millions); if a queue outgrows that, the fix is a GSI
            // per queue, not a bigger scan.
            const items = [];
            let ExclusiveStartKey;
            do {
                const res = await docClient.send(new ScanCommand({ TableName: table, ExclusiveStartKey }));
                items.push(...(res.Items ?? []));
                ExclusiveStartKey = res.LastEvaluatedKey;
            } while (ExclusiveStartKey);
            let out = filter ? items.filter(filter) : items;
            if (limit) out = out.slice(0, limit);
            return out;
        },

        async count(table, filter) {
            return (await this.list(table, { filter })).length;
        },
    };
}

// ─── Export ──────────────────────────────────────────────────────────────────

const driver = DRIVER === 'dynamodb' ? createDynamoDriver() : createMemoryDriver();

module.exports = {
    store: driver,
    TABLES,
    ConflictError,
    AppendOnlyViolation,
    driverName: driver.name,
};
