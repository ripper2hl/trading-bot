process.env.TEST_MODE = 'true'
process.env.DRY_RUN = 'false'
process.env.MARKET1 = 'BTC'
process.env.MARKET2 = 'USDT'

const proxyquire = require('proxyquire')
const fs = require('fs')

let binanceMock = {
    order: async (opts) => {
        return {
            symbol: opts.symbol,
            orderId: 12345678,
            clientOrderId: opts.newClientOrderId,
            status: 'FILLED',
            executedQty: '0.00734',
            fills: [{
                price: '61234.56',
                qty: '0.00734',
                commission: '0.0001',
                commissionAsset: 'BNB'
            }]
        }
    },
    exchangeInfo: async () => ({
        symbols: [{
            symbol: 'BTCUSDT',
            baseAssetPrecision: 6,
            filters: [
                { filterType: 'LOT_SIZE', stepSize: '0.000001' },
                { filterType: 'NOTIONAL', minNotional: '10' }
            ]
        }]
    })
}

const { marketBuy } = proxyquire('./services/exchange', {
    './binance': binanceMock,
    './TelegramNotify': { NotifyTelegram: async () => {} }
})

const { db } = require('./services/ledger')

async function runTest() {
    console.log('--- Insertando intent mediante exchange.marketBuy con mock custom ---')
    await marketBuy(0.01, false)
    
    console.log('--- Consultando la fila en SQLite ---')
    const row = db.prepare('SELECT * FROM order_intents ORDER BY timestamp DESC LIMIT 1').get()
    
    console.log(JSON.stringify(row, null, 2))
    
    if (
        row.executedQty === '0.00734' &&
        row.commissionAsset === 'BNB' &&
        row.orderId === '12345678' &&
        row.price === '61234.56'
    ) {
        console.log('✅ Evidencia confirmada: Mapeo exacto. Las nuevas columnas no solo no son nulas, sino que extrajeron el valor correcto de res.executedQty, res.orderId, etc.')
    } else {
        console.error('❌ Falla en el mapeo de campos. Alguna columna no contiene el valor correcto del mock.')
    }
}

runTest()
