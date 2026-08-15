process.env.TEST_MODE = 'true'
process.argv = ['node', 'app.js', 'BTC', 'USDT', '5']
process.env.BINANCE_API_KEY = 'test_key'
process.env.BINANCE_API_SECRET = 'test_secret'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const state = require('../services/state.js')
const { getPriceTick } = require('../services/exchange.js')
const store = state.store

;(async () => {
  try {
    // =========================================================================
    // TEST 1: CÁLCULO DE PEAK EQUITY Y DRAWDOWN DESDE EL MÁXIMO (PEAK)
    // =========================================================================

    // Configurar estado inicial: 1 BTC a $10,000 + $10,000 USDT = $20,000 Initial Equity
    store.put('initial_btc_balance', 1)
    store.put('initial_usdt_balance', 10000)
    store.put('peak_equity', 0) // reset peak

    // Caso A: Al inicio con BTC a $10,000, Equity = $20,000. Peak = $20,000. Drawdown = 0%
    store.put('btc_balance', 1)
    store.put('usdt_balance', 10000)
    let price = 10000

    let currentEquity = state.getCurrentEquity(price)
    let peakEquity = state.updatePeakEquity(price)
    let ddPercent = state.getDrawdownFromPeak(price)

    assert.equal(currentEquity, 20000, 'Current equity inicial debe ser $20,000')
    assert.equal(peakEquity, 20000, 'Peak equity debe ser $20,000')
    assert.equal(ddPercent, 0, 'Drawdown inicial debe ser 0%')

    // Caso B: El bot hace ganancias o el mercado sube a BTC $30,000 -> Equity = $40,000. Peak se actualiza a $40,000
    price = 30000
    currentEquity = state.getCurrentEquity(price)
    peakEquity = state.updatePeakEquity(price)
    ddPercent = state.getDrawdownFromPeak(price)

    assert.equal(currentEquity, 40000, 'Current equity en la cima debe ser $40,000')
    assert.equal(peakEquity, 40000, 'Peak equity debe actualizarse a $40,000')
    assert.equal(ddPercent, 0, 'Drawdown en la cima debe ser 0%')

    // Caso C: El mercado cae y el equity baja a $30,000 (caída de $10,000 desde el peak de $40,000)
    // Drawdown desde el peak = (30000 - 40000) / 40000 * 100 = -25%
    store.put('btc_balance', 0.66666667)
    store.put('usdt_balance', 10000)
    price = 30000 // Equity = 0.66666667 * 30000 + 10000 = 30000
    currentEquity = state.getCurrentEquity(price)
    peakEquity = state.updatePeakEquity(price)
    ddPercent = state.getDrawdownFromPeak(price, peakEquity)

    assert.equal(peakEquity, 40000, 'Peak equity debe mantenerse en $40,000')
    assert.equal(Math.round(currentEquity), 30000, 'Current equity debe ser $30,000')
    assert.equal(Math.round(ddPercent), -25, 'Drawdown desde el máximo debe ser -25%')

    console.log('PASS: TEST 1 - Peak Equity & Real Drawdown desde el máximo histórico verificado')

    // =========================================================================
    // TEST 2: CIRCUIT BREAKER DE ALTA LATENCIA DE RED (HIGH LATENCY)
    // =========================================================================

    const tick = await getPriceTick('BTCUSDT')
    assert.ok(tick, 'getPriceTick debe devolver un objeto tick')
    assert.ok(typeof tick.price === 'number', 'tick.price debe ser numérico')
    assert.ok(typeof tick.latency === 'number', 'tick.latency debe ser numérico')
    assert.ok(tick.latency < 3000, 'La latencia de red debe ser inferior a 3000ms')

    console.log('PASS: TEST 2 - Circuit Breaker de Alta Latencia verificado')

    // =========================================================================
    // TEST 3: CÁLCULO DE TRADING DRAWDOWN (SOLO PnL DE OPERACIONES DEL BOT)
    // =========================================================================
    store.put('initial_btc_balance', 0)
    store.put('initial_usdt_balance', 10000)
    store.put('btc_balance', 0)
    store.put('usdt_balance', 10000)
    store.put('profits', 500) // Profit de trading acumulado = +500 USDT (+5% de $10,000)
    store.put('peak_trading_profit', 0)

    let peakTrading = state.updatePeakTradingProfit(10000)
    assert.equal(peakTrading, 500, 'Peak Trading Profit debe actualizarse a $500')

    // Si el bot sufre una pérdida en operaciones y profit cae a $100 USDT (+1%)
    // Trading Drawdown = (100 - 500) / 10000 * 100 = -4%
    store.put('profits', 100)
    let tradingDD = state.getTradingDrawdown(10000, peakTrading)
    assert.equal(tradingDD, -4, 'Trading Drawdown desde el máximo de ganancias debe ser -4%')

    console.log('PASS: TEST 3 - Trading Drawdown desde el máximo de ganancias verificado')

  } catch (err) {
    console.error('FAIL Peak Equity & Stale Price Test:', err)
    process.exit(1)
  }
})()
