const assert = require('assert')
const { store } = require('../services/state')
const MARKET1 = 'BTC'
const MARKET2 = 'USDT'

// ==== Fórmula propuesta (aislada para el test) ====
function getLiquidationValue(currentPrice) {
    const initialQuote = parseFloat(store.get(`initial_${MARKET2.toLowerCase()}_balance`)) || 0;
    const initialBase = parseFloat(store.get(`initial_${MARKET1.toLowerCase()}_balance`)) || 0;
    
    // start_price es el precio al que arrancó el bot
    const startPrice = parseFloat(store.get('start_price')) || currentPrice;
    
    // T_init: Depositaste 10,000 USDT y tenías 0.5 BTC que valían 60k = 40,000 USDT totales "invertidos" al arrancar
    const T_init = initialQuote + (initialBase * startPrice);
    
    // Saldos actuales
    const currentQuote = parseFloat(store.get(`${MARKET2.toLowerCase()}_balance`)) || 0;
    const currentBase = parseFloat(store.get(`${MARKET1.toLowerCase()}_balance`)) || 0;
    
    // T_curr: Liquidas todo a currentPrice hoy
    const T_curr = currentQuote + (currentBase * currentPrice);
    
    const pnl = T_curr - T_init;
    const percent = T_init > 0 ? (pnl / T_init) * 100 : 0;
    
    return {
        initial: T_init,
        current: T_curr,
        pnl,
        percent
    };
}

// ==== Test ====
function runTest() {
    console.log('Iniciando test de Liquidation Value...')
    
    // Escenario 1: El bot arranca con 1 BTC a $60,000 y 10,000 USDT.
    // Total invertido inicial (start_price 60k) = 60,000 + 10,000 = 70,000 USDT.
    store.put(`initial_${MARKET1.toLowerCase()}_balance`, 1)
    store.put(`initial_${MARKET2.toLowerCase()}_balance`, 10000)
    store.put('start_price', 60000)
    
    // El bot hace un trade exitoso y termina con 1 BTC y 10,500 USDT.
    // Además, el BTC sube de $60,000 a $65,000.
    // Liquidation value = (1 * 65000) + 10500 = 75,500 USDT.
    store.put(`${MARKET1.toLowerCase()}_balance`, 1)
    store.put(`${MARKET2.toLowerCase()}_balance`, 10500)
    
    const currentPrice = 65000
    const result = getLiquidationValue(currentPrice)
    
    console.log('--- Resultados Escenario 1 ---')
    console.log(`Initial T_init: ${result.initial} USDT (Esperado: 70000)`)
    console.log(`Current T_curr: ${result.current} USDT (Esperado: 75500)`)
    console.log(`PnL Absoluto: +${result.pnl} USDT (Esperado: 5500)`)
    console.log(`PnL Porcentual: +${result.percent.toFixed(2)}%`)
    
    assert.strictEqual(result.initial, 70000)
    assert.strictEqual(result.current, 75500)
    assert.strictEqual(result.pnl, 5500)
    
    console.log('PASS: La fórmula aísla correctamente el valor total del portafolio al precio de hoy vs el precio de inicio.')
}

runTest()
