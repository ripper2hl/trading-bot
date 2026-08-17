const assert = require('assert')
const proxyquire = require('proxyquire').noCallThru()

async function run() {
    console.log('--- Corriendo tests para Fase 4A - Decimal Migration en exchange.js ---')

    let orderMock = () => {}
    let accountInfoMock = () => {}
    let pricesMock = () => {}
    let exchangeInfoMock = () => {}

    let clientStub = {
        order: async (...args) => await orderMock(...args),
        accountInfo: async (...args) => await accountInfoMock(...args),
        prices: async (...args) => await pricesMock(...args),
        exchangeInfo: async (...args) => await exchangeInfoMock(...args),
        cancelOrder: async () => {},
        cancelOpenOrders: async () => {},
        allOrders: async () => {}
    }

    let storeStub = {
        get: () => 0,
        put: () => {}
    }

    let networkStub = {
        withBackoff: async (fn) => await fn(),
        sleep: async () => {}
    }

    let exchange = proxyquire('../services/exchange.js', {
        './binance': clientStub,
        './state': { store: storeStub, elapsedTime: () => '00:00' },
        '../utils/network': networkStub,
        './TelegramNotify': { NotifyTelegram: async () => {} },
        './ledger': { logIntent: () => {}, updateIntent: () => {} },
        '../config/constants': {
            MARKET: 'BTCUSDT', MARKET1: 'BTC', MARKET2: 'USDT', DRY_RUN: false, FEE_RATE: 0.001
        }
    })

    // Test A
    accountInfoMock = () => ({
        balances: [
            { asset: 'USDT', free: '10000.123456', locked: '0' },
            { asset: 'BTC', free: '0.12345678', locked: '0' }
        ]
    })
    const balances = await exchange.getBalances()
    assert.strictEqual(balances['USDT'], 10000.123456)
    assert.strictEqual(balances['BTC'], 0.12345678)
    console.log('PASS: A) balance 10000.123456 USDT verificado exacto')

    // Test B
    pricesMock = () => ({ 'BTCUSDT': '63262.771234' })
    const price = await exchange.getPrice('BTCUSDT')
    assert.strictEqual(price, 63262.771234)
    console.log('PASS: B) precio 63262.771234 USDT parseado correcto')

    // Test C
    exchangeInfoMock = () => ({
        symbols: [{
            baseAssetPrecision: 5,
            filters: [{ filterType: 'LOT_SIZE', stepSize: '0.00001' }]
        }]
    })
    const qty = await exchange.getQuantity('0.000080123456')
    assert.strictEqual(qty, '0.00008')
    console.log('PASS: C) quantity 0.000080123456 truncado estricto a stepSize')

    // Test D
    orderMock = () => ({
        status: 'FILLED',
        executedQty: '1',
        orderId: 1,
        fills: [{ price: '60000', commission: '0.00123456', commissionAsset: 'BNB' }]
    })
    const res = await exchange.marketBuy(1)
    assert.strictEqual(res.fills[0].commission, '0.00123456')
    console.log('PASS: D) commission detectada de fills de api')

    // Test E
    exchangeInfoMock = () => ({
        symbols: [{
            filters: [{ filterType: 'NOTIONAL', minNotional: '10.00000000' }]
        }]
    })
    const minN = await exchange.getMinBuy()
    assert.strictEqual(minN, 10)
    console.log('PASS: E) minNotional 10 extraído estrictamente')

    // Test F
    pricesMock = () => ({ 'BNBUSDT': '600.5' }) // Price BNB
    const feeUSDT = await exchange.getFees({ commission: '0.015', commissionAsset: 'BNB' })
    assert.strictEqual(feeUSDT, 9.0075) // 0.015 * 600.5 = 9.0075 exact (floating point Number might have failed this depending on decimal representability, but Decimal works exactly)
    console.log('PASS: F) cálculo de fee BNB/USDT exacto')
    
    // Test G
    orderMock = () => ({
        status: 'FILLED',
        executedQty: '2',
        orderId: 2,
        fills: [
            { price: '60000', commission: '0.001', commissionAsset: 'BNB' },
            { price: '60001', commission: '0.002', commissionAsset: 'BNB' }
        ]
    })
    const resG = await exchange.marketSell(2)
    assert.strictEqual(resG.fills[0].price, '60000')
    assert.strictEqual(resG.fills[1].price, '60001')
    console.log('PASS: G) múltiples fills soportados sin mutar el payload')

    // Test H
    pricesMock = () => ({ 'BTCUSDT': 'invalid' })
    const priceInvalid = await exchange.getPrice('BTCUSDT')
    assert(Number.isNaN(priceInvalid))
    
    pricesMock = () => ({})
    const priceNull = await exchange.getPrice('BTCUSDT')
    assert.strictEqual(priceNull, null)
    console.log('PASS: H) fallos e inputs inválidos no silenciados como cero')
    
    console.log('--- Fin de Tests de exchange.js Decimal Migration ---')
}

run().catch(console.error)
