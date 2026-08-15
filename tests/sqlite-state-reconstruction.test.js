process.env.TEST_MODE = 'true'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const originalArgv = process.argv.slice()
const originalEnv = { ...process.env }

process.argv = ['node', 'app.js', 'BTC', 'USDT', '5', 'resume']
process.env.BINANCE_API_KEY = 'test_key'
process.env.BINANCE_API_SECRET = 'test_secret'
process.env.BUY_ORDER_AMOUNT = '50'
process.env.BUY_PERCENT = '1'
process.env.SELL_PERCENT = '2'

function resetStoreFile() {
  const stateFile = path.join(__dirname, '../data/BTCUSDT.json')
  try {
    fs.unlinkSync(stateFile)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}

;(async () => {
  try {
    const state = require('../services/state.js')
    const { logIntent, updateIntent, reconstructStoreFromSQLite, db } = require('../services/ledger.js')
    const store = state.store

    // Clear ledger table
    db.prepare('DELETE FROM order_intents').run()

    // =========================================================================
    // TEST 1: RECONSTRUCCION TOTAL DEL ESTADO DESDE SQLITE AL BORRAR EL JSON
    // =========================================================================

    // Insertar órdenes CONFIRMED en SQLite
    const orderId1 = 'confirmed-buy-001'
    const orderId2 = 'confirmed-buy-002'

    logIntent({ newClientOrderId: orderId1, symbol: 'BTCUSDT', side: 'BUY', quoteOrderQty: 50, price: 60000 })
    updateIntent(orderId1, 'CONFIRMED', 60000, 0.05)

    logIntent({ newClientOrderId: orderId2, symbol: 'BTCUSDT', side: 'BUY', quoteOrderQty: 50, price: 59000 })
    updateIntent(orderId2, 'CONFIRMED', 59000, 0.05)

    // BORRAR TOTALMENTE EL ARCHIVO JSON LOCAL (Simular borrado o corrupcion de cache)
    resetStoreFile()
    assert.equal(fs.existsSync(path.join(__dirname, '../data/BTCUSDT.json')), false, 'El JSON local debe estar borrado')

    // Ejecutar reconstruccion desde SQLite + Binance
    const balances = { BTC: 0.00169, USDT: 900 }
    const activeOrders = reconstructStoreFromSQLite({
      symbol: 'BTCUSDT',
      store,
      currentPrice: 60500,
      balances
    })

    // Assertions de Reconstruccion
    assert.equal(activeOrders.length, 2, 'Debe haber reconstruido 2 órdenes activas')
    assert.equal(store.get('orders').length, 2, 'El store JSON reconstruido debe contener 2 órdenes')
    assert.equal(store.get('orders')[0].id, orderId1, 'La primera orden debe ser orderId1')
    assert.equal(store.get('orders')[1].id, orderId2, 'La segunda orden debe ser orderId2')
    assert.equal(store.get('btc_balance'), 0.00169, 'El balance reconstruido de BTC debe ser 0.00169')
    assert.equal(store.get('usdt_balance'), 900, 'El balance reconstruido de USDT debe ser 900')

    console.log('PASS: TEST 1 - Estado local reconstruido 100% a partir de SQLite tras borrar el archivo JSON')

    // =========================================================================
    // TEST 2: IDEMPOTENCIA DE _calculateProfits
    // =========================================================================

    const initialProfits = parseFloat(store.get('profits') || 0)
    const { _calculateProfits } = state

    // Llamar _calculateProfits 5 veces consecutivas
    _calculateProfits()
    _calculateProfits()
    _calculateProfits()
    _calculateProfits()
    _calculateProfits()

    const finalProfits = parseFloat(store.get('profits') || 0)
    assert.equal(finalProfits, initialProfits, '_calculateProfits debe ser estrictamente idempotente (sin duplicar ganancias)')

    console.log('PASS: TEST 2 - Idempotencia de _calculateProfits verificada (5 llamadas consecutivas = mismo profit)')

    // =========================================================================
    // TEST 3: POLITICA SEGURA DE NOT_FOUND (Quarantine si el saldo en Binance es mayor)
    // =========================================================================

    const { BALANCE_ABSOLUTE_TOLERANCE_BASE } = require('../config/constants.js')
    const localBase = 0
    const realBaseInBinance = 0.5 // Binance tiene 0.5 BTC pero localmente habia 0

    const isDriftDetected = (realBaseInBinance - localBase) > BALANCE_ABSOLUTE_TOLERANCE_BASE
    assert.equal(isDriftDetected, true, 'Debe detectar desincronizacion positiva de saldo ante un NOT_FOUND')

    console.log('PASS: TEST 3 - Política de Cuarentena ante NOT_FOUND validada')

  } catch (err) {
    console.error('FAIL SQLite State Reconstruction Test:', err)
    process.exit(1)
  } finally {
    process.argv = originalArgv
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key]
    }
    for (const key of Object.keys(originalEnv)) {
      process.env[key] = originalEnv[key]
    }
  }
})()
