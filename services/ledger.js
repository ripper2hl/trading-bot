const fs = require('fs')
const path = require('path')
const Database = require('better-sqlite3')

const dataDir = path.join(process.cwd(), 'data')
const ledgerPath = path.join(dataDir, 'ledger.sqlite')

if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
}

const db = new Database(ledgerPath)
db.pragma('journal_mode = WAL')

db.exec(`
    CREATE TABLE IF NOT EXISTS order_intents (
        clientOrderId TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        amount TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('PENDING', 'CONFIRMED', 'FAILED')),
        timestamp INTEGER NOT NULL
    );
`)

function logIntent(orderObject) {
    const amountValue = orderObject.quantity ?? orderObject.quoteOrderQty ?? 0
    const statement = db.prepare(`
        INSERT OR REPLACE INTO order_intents (clientOrderId, symbol, side, amount, status, timestamp)
        VALUES (?, ?, ?, ?, 'PENDING', ?)
    `)

    statement.run(
        orderObject.newClientOrderId,
        orderObject.symbol,
        orderObject.side,
        String(amountValue),
        Date.now()
    )

    return orderObject.newClientOrderId
}

function updateIntent(clientOrderId, status) {
    const statement = db.prepare(`
        UPDATE order_intents
        SET status = ?
        WHERE clientOrderId = ?
    `)

    return statement.run(status, clientOrderId).changes
}

function getPendingIntents() {
    const statement = db.prepare(`
        SELECT * FROM order_intents
        WHERE status = 'PENDING'
        ORDER BY timestamp ASC
    `)

    return statement.all()
}

function getIntent(clientOrderId) {
    const statement = db.prepare(`
        SELECT * FROM order_intents
        WHERE clientOrderId = ?
    `)

    return statement.get(clientOrderId)
}

function purgeOldIntents(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - maxAgeMs
    const statement = db.prepare(`
        DELETE FROM order_intents
        WHERE status != 'PENDING' AND timestamp < ?
    `)

    return statement.run(cutoff).changes
}

module.exports = {
    logIntent,
    updateIntent,
    getPendingIntents,
    getIntent,
    purgeOldIntents,
    db,
    ledgerPath,
}
