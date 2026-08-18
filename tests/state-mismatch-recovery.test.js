process.env.TEST_MODE = 'true'
process.env.DRY_RUN = 'false'
process.env.MARKET1 = 'BTC'
process.env.MARKET2 = 'USDT'
process.env.NOTIFY_TELEGRAM_ENABLED = 'false'
process.env.BUY_ORDER_AMOUNT = '100'

const fs = require('fs')
const path = require('path')
const assert = require('node:assert/strict')
const proxyquire = require('proxyquire')
const Decimal = require('decimal.js')

const dataDir = path.join(process.cwd(), 'data')
const ledgerPath = path.join(dataDir, 'ledger.sqlite')
const storePath = path.join(dataDir, 'data.json')

function cleanEnv() {
    if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath)
    if (fs.existsSync(ledgerPath + '-wal')) fs.unlinkSync(ledgerPath + '-wal')
    if (fs.existsSync(ledgerPath + '-shm')) fs.unlinkSync(ledgerPath + '-shm')
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath)
}

// Valores del incidente de produccion
const localBase = 1.00105
const localQuote = 9934.4894476

const realBase = 1.00266
const realQuote = 9831.8014534

const boughtQty = 0.00161
const totalCost = 102.6879942
const price = 63781.3628
const commissionAsset = 'BTC'
const commission = 0 // simplificado

let getBalancesMock = async () => {
    console.log('MOCK GET BALANCES CALLED', realBase, realQuote)
    return { BTC: realBase, USDT: realQuote }
}

let binanceMock = {
    getOrder: async (opts) => ({
        symbol: opts.symbol,
        orderId: 'CRASH_123',
        clientOrderId: opts.origClientOrderId,
        status: 'FILLED',
        executedQty: boughtQty.toString(),
        price: '0.00', // Simulando falta de precio en el objeto de orden (común en MARKET)
        cummulativeQuoteQty: totalCost.toString()
    }),
    myTrades: async () => ([{
        symbol: 'BTCUSDT',
        orderId: 'CRASH_123',
        price: price.toString(),
        qty: boughtQty.toString(),
        commission: commission.toString(),
        commissionAsset: commissionAsset,
        time: Date.now()
    }]),
    prices: async () => ({ 'BTCUSDT': price.toString() }),
    getBalances: getBalancesMock,
    getPrice: async () => price.toString()
}

async function run() {
    cleanEnv()

    const { store } = require('../services/state')
    store.put(`${process.env.MARKET1.toLowerCase()}_balance`, localBase)
    store.put(`${process.env.MARKET2.toLowerCase()}_balance`, localQuote)
    store.put(`initial_${process.env.MARKET1.toLowerCase()}_balance`, localBase)
    store.put(`initial_${process.env.MARKET2.toLowerCase()}_balance`, localQuote)

    const { logIntent, updateIntent } = require('../services/ledger')
    
    // Simulamos el flujo exacto de _buy: se loguea el PENDING y luego se pasa a CONFIRMED
    logIntent({
        newClientOrderId: 'CRASH_123',
        symbol: 'BTCUSDT',
        side: 'BUY',
        quantity: boughtQty,
        price: price
    })
    updateIntent('CRASH_123', 'CONFIRMED', price, commission, boughtQty, commissionAsset, 'ORDER_123')
    
    const app = proxyquire('../app', {
        './services/binance': binanceMock,
        './services/TelegramNotify': { NotifyTelegram: async () => {} },
        './services/exchange': {
            ...require('../services/exchange'),
            getBalances: getBalancesMock,
            getPrice: async () => price.toString()
        }
    })
    
    let exitCalled = false
    const origExit = process.exit
    process.exit = (code) => {
        exitCalled = true
        console.error('Process.exit() llamado con código:', code)
    }

    try {
        console.log('--- Iniciando Recovery de App ---')
        
        await app.init()

        
        console.log('--- Llamando a reconcileBalances() ---')
        const { reconcileBalances } = require('../services/state')
        await reconcileBalances(getBalancesMock, 1)
        
        if (exitCalled) {
            console.error('FAIL: reconcileBalances() disparó process.exit(1), lo cual indica STATE MISMATCH.')
            process.exit = origExit
            process.exit(1)
        } else {
            console.log('PASS: reconcileBalances() resolvió correctamente sin STATE MISMATCH ni cuarentena.')
        }

    } catch (e) {
        console.error('FAILED:', e)
        process.exit = origExit
        process.exit(1)
    }
    
    process.exit = origExit
    process.exit(0)
}

run()
