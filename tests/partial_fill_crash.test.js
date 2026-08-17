process.env.TEST_MODE = 'true'
process.env.DRY_RUN = 'false'
process.env.MARKET1 = 'BTC'
process.env.MARKET2 = 'USDT'
process.env.NOTIFY_TELEGRAM_ENABLED = 'false'

const fs = require('fs')
const path = require('path')
const assert = require('node:assert/strict')
const proxyquire = require('proxyquire')

// Asegurar un ledger limpio
const dataDir = path.join(process.cwd(), 'data')
const ledgerPath = path.join(dataDir, 'ledger.sqlite')
if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath)
if (fs.existsSync(ledgerPath + '-wal')) fs.unlinkSync(ledgerPath + '-wal')
if (fs.existsSync(ledgerPath + '-shm')) fs.unlinkSync(ledgerPath + '-shm')

let binanceMock = {
    order: async (opts) => {
        // Mock PARTIALLY_FILLED
        return {
            symbol: opts.symbol,
            orderId: 'PARTIAL_123',
            clientOrderId: opts.newClientOrderId,
            status: 'PARTIALLY_FILLED',
            executedQty: '0.005000', // Pedimos 0.01 pero solo llenó 0.005
            fills: [{
                price: '60000',
                qty: '0.005000',
                commission: '0.000005',
                commissionAsset: 'BTC'
            }]
        }
    },
    cancelOrder: async () => ({ status: 'CANCELED' }),
    cancelOpenOrders: async () => ([]),
    prices: async () => ({ 'BTCUSDT': '60000' }),
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

// 1. Simular la caída durante marketOrder en exchange.js
async function simulateCrashDuringOrder() {
    console.log('--- FASE 1: Simular disparo y crash en Partial Fill ---')
    let exitCalled = false
    const exchange = proxyquire('../services/exchange', {
        './binance': binanceMock,
        './TelegramNotify': { NotifyTelegram: async () => {} }
    })
    
    const originalExit = process.exit
    process.exit = (code) => {
        exitCalled = true
        console.log('Crash simulado (process.exit) disparado correctamente tras el Partial Fill.')
    }
    
    // Disparamos la orden directamente, evadiendo _buy()
    // Pedimos 0.01 BTC
    await exchange.marketBuy(0.01, false)
    
    // Restaurar exit
    process.exit = originalExit
    assert.equal(exitCalled, true, 'El bot NO hizo process.exit(1) tras el Partial Fill!')
}

// 2. Simular el reinicio y recuperación en init()
async function simulateRecovery() {
    console.log('--- FASE 2: Simular reinicio y reconciliación de SQLite ---')
    
    // Borrar el store JSON para obligar la reconstrucción desde SQLite
    const storePath = path.join(dataDir, 'data.json')
    if (fs.existsSync(storePath)) {
        fs.unlinkSync(storePath)
    }

    const { reconstructStoreFromSQLite, getPendingIntents } = require('../services/ledger')
    const { store } = require('../services/state')
    
    // Mock recuperar Binance order
    binanceMock.getOrder = async (opts) => {
        return {
            symbol: opts.symbol,
            orderId: 'PARTIAL_123',
            clientOrderId: opts.origClientOrderId,
            status: 'PARTIALLY_FILLED',
            executedQty: '0.005000', // El executed real!
            cummulativeQuoteQty: '300.00'
        }
    }
    binanceMock.myTrades = async () => ([{
        symbol: 'BTCUSDT',
        orderId: 'PARTIAL_123',
        price: '60000',
        qty: '0.005000',
        commission: '0.000005',
        commissionAsset: 'BTC',
        time: Date.now()
    }])

    console.log('Llamando a la lógica de recovery de init()...')
    const pendingIntents = getPendingIntents()
    for (const intent of pendingIntents) {
        const order = await binanceMock.getOrder({ symbol: 'BTCUSDT', origClientOrderId: intent.clientOrderId })
        if (order && (order.status === 'FILLED' || order.status === 'PARTIALLY_FILLED')) {
            const { updateIntent } = require('../services/ledger')
            const { store, getBalances } = require('../services/state')
            let fillPrice = parseFloat(order.price || 0)
            let fillFee = 0
            let commissionAsset = null
            
            const trades = await binanceMock.myTrades({ symbol: 'BTCUSDT', orderId: order.orderId })
            if (trades && trades.length > 0) {
                let totalCost = 0
                let totalQty = 0
                for (const trade of trades) {
                    totalCost += parseFloat(trade.price) * parseFloat(trade.qty)
                    totalQty += parseFloat(trade.qty)
                    fillFee += parseFloat(trade.commission)
                    commissionAsset = trade.commissionAsset
                }
                if (totalQty > 0) fillPrice = totalCost / totalQty
            }
            
            updateIntent(intent.clientOrderId, 'CONFIRMED', fillPrice, fillFee, order.executedQty, commissionAsset, order.orderId)
            intent.price = fillPrice
            intent.fee = fillFee
            intent.executedQty = order.executedQty
            intent.commissionAsset = commissionAsset
            intent.orderId = order.orderId
            const app = proxyquire('../app', {
                './services/binance': binanceMock,
                './services/TelegramNotify': { NotifyTelegram: async () => {} }
            })
            await app.recoverPendingIntent(intent, { store, getBalances: async () => ({ BTC: 0.005, USDT: 9900 }) })
        }
    }
    
    console.log('Llamando a reconstructStoreFromSQLite...')
    await reconstructStoreFromSQLite({
        symbol: 'BTCUSDT',
        store: store,
        currentPrice: 60000,
        balances: { BTC: 0.005, USDT: 9900 }
    })
    
    const orders = store.get('orders') || []
    console.log('Órdenes recuperadas en el store:', orders)
    
    assert.equal(orders.length, 1, 'No se recuperó la orden en el store JSON!')
    const recoveredOrder = orders[0]
    
    console.log('Cantidad recuperada:', recoveredOrder.amount)
    
    if (parseFloat(recoveredOrder.amount) !== 0.005) {
        throw new Error(`CRITICAL BUG: La orden recuperó la cantidad original pedida (0.01) o no seteó la cantidad ejecutada real! (amount=${recoveredOrder.amount})`)
    }
    
    console.log('PASS: El partial fill fue recuperado con la cantidad ejecutada correcta.')
}

async function run() {
    await simulateCrashDuringOrder()
    await simulateRecovery()
    process.exit(0)
}

run().catch(e => {
    console.error('FAILED:', e)
    process.exit(1)
})
