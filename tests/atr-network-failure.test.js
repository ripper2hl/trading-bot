const assert = require('assert')
const path = require('path')

// 1. Cargar el módulo original y mockear getKlines en la caché de Node
const exchangePath = path.resolve(__dirname, '../services/exchange.js')
require(exchangePath)
const exchangeModule = require.cache[exchangePath].exports

const originalGetKlines = exchangeModule.getKlines
exchangeModule.getKlines = async () => {
    throw new Error('SIMULATED_NETWORK_REJECTION')
}

// 2. Ahora requerir app y store
const { updateDynamicGrid } = require('../app.js')
const { store } = require('../services/state.js')

;(async () => {
    try {
        // Pre-poblar el store con valores sanos
        store.put('dynamic_buy_percent', 1.55)
        store.put('dynamic_sell_percent', 1.65)

        // 3. Ejecutar updateDynamicGrid, que llamará al getKlines mockeado
        await updateDynamicGrid(63000)

        // 4. Verificaciones
        const dynBuy = store.get('dynamic_buy_percent')
        const dynSell = store.get('dynamic_sell_percent')

        assert.strictEqual(dynBuy, 1.55, 'dynamic_buy_percent fue corrompido tras error de red')
        assert.strictEqual(dynSell, 1.65, 'dynamic_sell_percent fue corrompido tras error de red')

        console.log('PASS: updateDynamicGrid captura fallas de red, no crashea y preserva el grid anterior.')
    } catch (err) {
        console.error('FAIL ATR Network Test: Crasheó la función en lugar de hacer try/catch.', err)
        process.exit(1)
    } finally {
        // Restaurar el mock
        exchangeModule.getKlines = originalGetKlines
    }
})()
