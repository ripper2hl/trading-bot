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
    const { acquirePidLock } = require('../services/pidLock.js')
    const store = state.store

    // Limpiar base de datos de intents
    db.prepare('DELETE FROM order_intents').run()

    // =========================================================================
    // TEST 1: INMUNIDAD A ORDENES ZOMBIE TRAS UN CRASH Y VENTA PREVIA
    // =========================================================================

    const buy1 = 'buy-order-001'
    const buy2 = 'buy-order-002'

    // a) Simular BUY #1 (CONFIRMED)
    logIntent({ newClientOrderId: buy1, symbol: 'BTCUSDT', side: 'BUY', quoteOrderQty: 50, price: 60000 })
    updateIntent(buy1, 'CONFIRMED', 60000, 0.05)

    // b) Simular BUY #2 (CONFIRMED)
    logIntent({ newClientOrderId: buy2, symbol: 'BTCUSDT', side: 'BUY', quoteOrderQty: 50, price: 59000 })
    updateIntent(buy2, 'CONFIRMED', 59000, 0.05)

    // c) Simular SELL #1 -> Cierra el BUY #1 marcándolo como CLOSED en SQLite
    updateIntent(buy1, 'CLOSED')

    // Verificar en SQLite directamente que buy1 está CLOSED y buy2 está CONFIRMED
    const intent1 = db.prepare('SELECT status FROM order_intents WHERE clientOrderId = ?').get(buy1)
    const intent2 = db.prepare('SELECT status FROM order_intents WHERE clientOrderId = ?').get(buy2)
    assert.equal(intent1.status, 'CLOSED', 'El intent de BUY #1 debe estar en status CLOSED')
    assert.equal(intent2.status, 'CONFIRMED', 'El intent de BUY #2 debe estar en status CONFIRMED')

    // d) Simular crash: Borrar estado JSON local de disco y limpiar store
    resetStoreFile()
    store.put('orders', [])

    // e) Llamar a reconstructStoreFromSQLite()
    const balances = { BTC: 0.00084, USDT: 950 }
    const reconstructedActiveOrders = reconstructStoreFromSQLite({
      symbol: 'BTCUSDT',
      store,
      currentPrice: 60500,
      balances
    })

    // f) ASSERT: activeOrders contiene ÚNICAMENTE BUY #2. BUY #1 (CLOSED) no resucita.
    assert.equal(reconstructedActiveOrders.length, 1, 'Debe haber exactamente 1 orden activa reconstruida')
    assert.equal(reconstructedActiveOrders[0].id, buy2, 'La única orden activa reconstruida debe ser BUY #2')
    assert.equal(store.get('orders').length, 1, 'El store JSON debe reflejar únicamente 1 orden activa')

    console.log('PASS: TEST 1 - Inmunidad a Órdenes Zombie validada. BUY #1 (CLOSED) no fue resucitado.')

    // =========================================================================
    // TEST 2: PROTECCION MULTI-INSTANCIA (PID LOCK / SPLIT-BRAIN)
    // =========================================================================

    const pidFile = path.join(__dirname, '../data/BTCUSDT.pid')
    try { fs.unlinkSync(pidFile) } catch (e) {}

    // Adquirir lock para la instancia actual
    const releaseLock = acquirePidLock('BTCUSDT')
    assert.equal(fs.existsSync(pidFile), true, 'El archivo PID lock debe haberse creado')

    const filePid = fs.readFileSync(pidFile, 'utf8').trim()
    assert.equal(filePid, String(process.pid), 'El PID grabado debe coincidir con el PID del proceso')

    // Liberar lock limpia el archivo
    releaseLock()
    assert.equal(fs.existsSync(pidFile), false, 'Al salir se debe eliminar el archivo PID lock')

    console.log('PASS: TEST 2 - Protección Multi-Instancia (PID lock) verificada')

  } catch (err) {
    console.error('FAIL Zombie Prevention & PID Lock Test:', err)
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
