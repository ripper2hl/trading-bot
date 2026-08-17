const assert = require('assert')

process.env.MARKET1 = 'BTC'
process.env.MARKET2 = 'USDT'
process.env.USE_TESTNET = 'true'
process.env.POLL_INTERVAL_MS = '100'

const proxyquire = require('proxyquire')
const { logColor, colors } = require('../utils/logger')

function getProxiedModules(overrides = {}) {
    const mockConstants = {
        ...require('../config/constants'),
        ...overrides
    }
    
    const state = proxyquire('../services/state', {
        '../config/constants': mockConstants
    })
    
    const tradingEngine = proxyquire('../controllers/tradingEngine', {
        '../config/constants': mockConstants,
        '../services/state': state
    })
    
    return { state, store: state.store, checkDailyLoss: state.checkDailyLoss, tradingEngine, mockConstants }
}

async function runTests() {
    console.log('Iniciando tests de Risk Limits...')
    
    // --- SETUP STATE ---
    let { store } = getProxiedModules()
    store.put('start_price', 60000)
    store.put('btc_balance', 0)
    store.put('usdt_balance', 10000)
    store.put('initial_btc_balance', 0)
    store.put('initial_usdt_balance', 10000)
    store.put('initial_liquidation_value', 10000)
    
    const price = 60000
    
    // --- 1. TEST MAX_CAPITAL_USDT ---
    console.log('\n--- 1. TEST MAX_CAPITAL_USDT ---')
    let envA = getProxiedModules({ MARKET: 'TEST_CAPITAL', MAX_CAPITAL_USDT: 100, MAX_BTC_INVENTORY: 0, BUY_ORDER_AMOUNT: 50 })
    
    // Simular que ya gastamos 60 USDT en órdenes pendientes/compradas
    envA.store.put('orders', [
        { status: 'bought', amount: 60 / 60000, buy_price: 60000 }
    ])
    
    // El engine intenta comprar 50 USDT (projectedExposure = 60 + 50 = 110 > 100)
    await envA.tradingEngine._buy(price, 50, async () => {}, () => {})
    
    // Comprobar que no se creó la orden "pending" porque fue bloqueada
    let ordersAfterCapital = envA.store.get('orders')
    assert.strictEqual(ordersAfterCapital.length, 1, "La orden debió ser bloqueada por MAX_CAPITAL_USDT")
    console.log('PASS: MAX_CAPITAL_USDT bloquea compras si la exposición proyectada excede el límite.')
    
    
    // --- 2. TEST MAX_BTC_INVENTORY ---
    console.log('\n--- 2. TEST MAX_BTC_INVENTORY ---')
    let envB = getProxiedModules({ MARKET: 'TEST_INVENTORY', MAX_CAPITAL_USDT: 0, MAX_BTC_INVENTORY: 0.01, BUY_ORDER_AMOUNT: 300 })
    
    // Simular que el bot ya tiene 0.009 BTC en órdenes
    envB.store.put('orders', [
        { status: 'bought', amount: 0.009, buy_price: 60000 }
    ])
    
    // El engine intenta comprar 0.005 BTC adicionales (projectedInventory = 0.009 + 0.005 = 0.014 > 0.01)
    await envB.tradingEngine._buy(price, 300, async () => {}, () => {})
    
    // Comprobar que no se creó la orden
    let ordersAfterBTC = envB.store.get('orders')
    assert.strictEqual(ordersAfterBTC.length, 1, "La orden debió ser bloqueada por MAX_BTC_INVENTORY")
    console.log('PASS: MAX_BTC_INVENTORY bloquea compras si el inventario de BTC del bot excede el límite.')
    
    
    // --- 3. TEST MAX_DAILY_LOSS_PERCENT ---
    console.log('\n--- 3. TEST MAX_DAILY_LOSS_PERCENT ---')
    let envC = getProxiedModules({ MARKET: 'TEST_DAILYLOSS', MAX_DAILY_LOSS_PERCENT: 2 }) // Limite -2%
    
    const tzDateStr = new Date().toLocaleDateString('en-CA', { timeZone: envC.mockConstants.RISK_DAY_TIMEZONE });
    
    // Configurar estado en envC
    envC.store.put('start_price', 60000)
    envC.store.put('btc_balance', 0)
    envC.store.put('initial_btc_balance', 0)
    envC.store.put('initial_usdt_balance', 10000)
    envC.store.put('initial_liquidation_value', 10000)
    
    // Caso A: No excede el límite
    envC.store.put('daily_baseline_date', tzDateStr)
    envC.store.put('daily_baseline_liquidation_value', 10000)
    envC.store.put('usdt_balance', 9900) // Pérdida del 1% (9900 < 10000)
    
    let resA = envC.checkDailyLoss(price)
    console.log(resA)
    assert.strictEqual(resA.exceeded, false)
    assert.strictEqual(resA.loss, -1)
    console.log('PASS: Daily Loss de -1% permitido (límite -2%).')
    
    // Caso B: Excede el límite
    envC.store.put('usdt_balance', 7899) // Pérdida mayor al 21% para garantizar que pase el <= -2%
    let resB = envC.checkDailyLoss(price)
    assert.strictEqual(resB.exceeded, true)
    assert.strictEqual(resB.loss, -21.01)
    console.log('PASS: Daily Loss de -21% detectado correctamente y marcado como exceeded.')
    
    // Caso C: Cambio de día (el contador se resetea)
    envC.store.put('daily_baseline_date', '2020-01-01') // Fecha simulada del ayer
    envC.store.put('daily_baseline_liquidation_value', 10000) // Baseline ayer
    
    // Se evalúa hoy con el usdt_balance en 7899. Debería resetear el baseline a 7899 y retornar 0 de loss
    let resC = envC.checkDailyLoss(price)
    assert.strictEqual(resC.exceeded, false)
    assert.strictEqual(resC.loss, 0)
    assert.strictEqual(envC.store.get('daily_baseline_date'), tzDateStr)
    assert.strictEqual(envC.store.get('daily_baseline_liquidation_value'), 7899)
    console.log('PASS: Cambio de día resetea automáticamente el baseline al current Liquidation Value.')
    
    console.log('\nTodos los tests de límites de riesgo pasaron.')
}

runTests().catch(err => {
    console.error(err)
    process.exit(1)
})
