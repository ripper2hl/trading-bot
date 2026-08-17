const assert = require('assert')

process.env.MARKET1 = 'BTC'
process.env.MARKET2 = 'USDT'
process.env.USE_TESTNET = 'true'

// Mock de dependencies
const state = require('../services/state')
const { store } = state

// Simulación exacta del flujo "arranque limpio (!RESUME)" en app.js
async function simulateAppInit() {
    console.log('--- TEST: Simulación de app.js init() (Arranque Limpio) ---')
    
    // 1. En app.js, cuando no hay RESUME, primero obtiene el precio:
    // const price = await getPrice(MARKET)
    const price_de_arranque = 60000
    
    // 2. app.js guarda los saldos en el store (líneas 496-503)
    // Supongamos que el exchange nos dice que tenemos 1 BTC y 10000 USDT
    store.put('btc_balance', 1)
    store.put('usdt_balance', 10000)
    
    if (store.get('initial_btc_balance') === undefined || store.get('initial_btc_balance') === null) {
        store.put('initial_btc_balance', store.get('btc_balance'))
    }
    if (store.get('initial_usdt_balance') === undefined || store.get('initial_usdt_balance') === null) {
        store.put('initial_usdt_balance', store.get('usdt_balance'))
    }
    
    // NOTA: ELIMINAMOS la llamada intermedia a resolveInitialBaseline(MARKET2, price) 
    // que causaba la duda (ya no existe en app.js).
    
    // 3. Al final de init() (líneas 520-526 de app.js), hace:
    // const currentPrice = await getPrice(MARKET)
    // resolveInitialBaseline(MARKET2, currentPrice)
    const currentPriceAtEnd = 60000 
    
    console.log('[App.js Flow] Llamando a resolveInitialBaseline("USDT", 60000)')
    state.resolveInitialBaseline('USDT', currentPriceAtEnd)
    
    // 4. Verificación del cálculo persistido:
    const frozenTInit = store.get('initial_liquidation_value')
    const baseline = store.get('strategy_baseline_equity')
    
    console.log(`strategy_baseline_equity congelado: ${baseline} USDT (Esperado: 10000)`)
    console.log(`initial_liquidation_value congelado: ${frozenTInit} USDT (Esperado: 70000)`)
    
    assert.strictEqual(baseline, 10000, "El USDT base debe ser 10000")
    assert.strictEqual(frozenTInit, 70000, "El Liquidation Value base debe incluir el valor del BTC en arranque")
    
    // 5. Demostración: si se vuelve a llamar con un precio diferente (por ejemplo, en un RESUME futuro), 
    // NO DEBE CAMBIAR porque ya está congelado.
    console.log('[App.js Flow] Reiniciando bot (RESUME)... el precio ahora es 65000')
    state.resolveInitialBaseline('USDT', 65000)
    
    const secondFrozenTInit = store.get('initial_liquidation_value')
    console.log(`initial_liquidation_value sigue siendo: ${secondFrozenTInit} USDT (Esperado: 70000)`)
    assert.strictEqual(secondFrozenTInit, 70000, "El valor inicial no debe reescribirse en un RESUME posterior")
    
    console.log('PASS: El orden de llamadas de app.js inicializa y congela correctamente los valores iniciales.')
}

async function run() {
    // Limpiamos el estado inicial para la prueba
    store.put('initial_liquidation_value', null)
    store.put('strategy_baseline_equity', null)
    store.put('peak_equity_curve', null)
    store.put('initial_btc_balance', null)
    store.put('initial_usdt_balance', null)
    
    await simulateAppInit()
}

run().catch(err => {
    console.error(err)
    process.exit(1)
})
