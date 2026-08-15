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
        price TEXT,
        fee TEXT,
        status TEXT NOT NULL,
        timestamp INTEGER NOT NULL
    );
`)

try {
    const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='order_intents'").get()
    if (tableInfo && tableInfo.sql && tableInfo.sql.includes("CHECK(status IN ('PENDING', 'CONFIRMED', 'FAILED'))")) {
        db.exec(`
            CREATE TABLE order_intents_new (
                clientOrderId TEXT PRIMARY KEY,
                symbol TEXT NOT NULL,
                side TEXT NOT NULL,
                amount TEXT NOT NULL,
                price TEXT,
                fee TEXT,
                status TEXT NOT NULL,
                timestamp INTEGER NOT NULL
            );
            INSERT INTO order_intents_new SELECT clientOrderId, symbol, side, amount, price, fee, status, timestamp FROM order_intents;
            DROP TABLE order_intents;
            ALTER TABLE order_intents_new RENAME TO order_intents;
        `)
    }
} catch (e) {}

try { db.exec("ALTER TABLE order_intents ADD COLUMN price TEXT;") } catch (e) {}
try { db.exec("ALTER TABLE order_intents ADD COLUMN fee TEXT;") } catch (e) {}

function logIntent(orderObject) {
    const amountValue = orderObject.quantity ?? orderObject.quoteOrderQty ?? 0
    const statement = db.prepare(`
        INSERT OR REPLACE INTO order_intents (clientOrderId, symbol, side, amount, price, fee, status, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)
    `)

    statement.run(
        orderObject.newClientOrderId,
        orderObject.symbol,
        orderObject.side,
        String(amountValue),
        orderObject.price ? String(orderObject.price) : null,
        orderObject.fee ? String(orderObject.fee) : null,
        Date.now()
    )

    return orderObject.newClientOrderId
}

function updateIntent(clientOrderId, status, price, fee) {
    let sql = 'UPDATE order_intents SET status = ?'
    const params = [status]
    if (price !== undefined && price !== null) {
        sql += ', price = ?'
        params.push(String(price))
    }
    if (fee !== undefined && fee !== null) {
        sql += ', fee = ?'
        params.push(String(fee))
    }
    sql += ' WHERE clientOrderId = ?'
    params.push(clientOrderId)

    return db.prepare(sql).run(...params).changes
}

function getPendingIntents() {
    const statement = db.prepare(`
        SELECT * FROM order_intents
        WHERE status = 'PENDING'
        ORDER BY timestamp ASC
    `)

    return statement.all()
}

function getConfirmedIntents(symbol) {
    const statement = symbol
        ? db.prepare(`SELECT * FROM order_intents WHERE status = 'CONFIRMED' AND symbol = ? ORDER BY timestamp ASC`)
        : db.prepare(`SELECT * FROM order_intents WHERE status = 'CONFIRMED' ORDER BY timestamp ASC`)

    return symbol ? statement.all(symbol) : statement.all()
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

/**
 * Reconstruye la vista de cache local (store JSON) desde la verdad inmutable en SQLite + Binance.
 */
function reconstructStoreFromSQLite({ symbol, store, currentPrice, balances }) {
    const confirmed = getConfirmedIntents(symbol)
    const activeOrders = []

    for (const item of confirmed) {
        if (item.side === 'BUY') {
            activeOrders.push({
                id: item.clientOrderId,
                amount: item.amount,
                buy_price: item.price || currentPrice,
                buy_fee: parseFloat(item.fee || 0),
                status: 'open',
                timestamp: item.timestamp,
            })
        }
    }

    store.put('orders', activeOrders)
    store.put('start_time', store.get('start_time') || Date.now())
    store.put('start_price', store.get('start_price') || currentPrice)
    store.put('entry_price', store.get('entry_price') || currentPrice)
    store.put('profits', store.get('profits') || 0)
    store.put('sl_losses', store.get('sl_losses') || 0)
    store.put('fees', store.get('fees') || 0)

    if (balances) {
        const symbolParts = symbol.match(/([A-Z0-9]+?)(USDT|BUSD|BTC|ETH|EUR|USD)$/)
        if (symbolParts) {
            const m1 = symbolParts[1].toLowerCase()
            const m2 = symbolParts[2].toLowerCase()
            store.put(`${m1}_balance`, balances[symbolParts[1]] || 0)
            store.put(`${m2}_balance`, balances[symbolParts[2]] || 0)
            if (store.get(`initial_${m1}_balance`) === undefined) {
                store.put(`initial_${m1}_balance`, balances[symbolParts[1]] || 0)
            }
            if (store.get(`initial_${m2}_balance`) === undefined) {
                store.put(`initial_${m2}_balance`, balances[symbolParts[2]] || 0)
            }
        }
    }

    return activeOrders
}

module.exports = {
    logIntent,
    updateIntent,
    getPendingIntents,
    getConfirmedIntents,
    getIntent,
    purgeOldIntents,
    reconstructStoreFromSQLite,
    db,
    ledgerPath,
}
