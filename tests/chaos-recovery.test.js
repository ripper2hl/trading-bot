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

function resetPersistedFiles() {
  const stateFile = path.join(__dirname, '../data/BTCUSDT.json')
  try {
    fs.unlinkSync(stateFile)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  fs.writeFileSync(stateFile, '{}')
}

resetPersistedFiles()

;(async () => {
  try {
    const client = require('../services/binance.js')
    const state = require('../services/state.js')
    const { logIntent, getIntent, db } = require('../services/ledger.js')
    const store = state.store

    // Reset database order_intents
    db.prepare('DELETE FROM order_intents').run()

    // 1. Insertar intent PENDING de BUY en la DB SQLite
    const testOrderId = 'chaos-test-buy-001'
    const intentObj = {
      newClientOrderId: testOrderId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      quoteOrderQty: 50,
    }
    logIntent(intentObj)

    const initialIntent = getIntent(testOrderId)
    assert.equal(initialIntent.status, 'PENDING', 'Intent debe iniciar como PENDING en SQLite')

    // 2. Mockear cliente de Binance para responder FILLED en getOrder
    let getOrderCalled = false
    let marketOrderCalled = false

    const originalGetOrder = client.getOrder
    const originalOrder = client.order

    client.getOrder = async ({ symbol, origClientOrderId }) => {
      getOrderCalled = true
      if (origClientOrderId === testOrderId) {
        return {
          symbol,
          orderId: 998877,
          clientOrderId: testOrderId,
          status: 'FILLED',
          executedQty: '0.00083333',
          fills: [{ price: '60000', commission: '0.00000083' }]
        }
      }
      return null
    }

    client.order = async () => {
      marketOrderCalled = true
      throw new Error('NO SE DEBE ENVIAR NINGUNA ORDEN NUEVA A BINANCE DURANTE LA RECUPERACION')
    }

    // Prepare store state
    store.put('orders', [])
    store.put('btc_balance', 0)
    store.put('usdt_balance', 1000)
    store.put('initial_btc_balance', 0)
    store.put('initial_usdt_balance', 1000)

    // 3. Ejecutar flujo de reconciliacion de bootstrap (como en app.js init)
    delete require.cache[require.resolve('../app.js')]
    const app = require('../app.js')

    const pendingIntents = require('../services/ledger.js').getPendingIntents()
    assert.equal(pendingIntents.length, 1, 'Debe haber 1 intent PENDING')

    for (const intent of pendingIntents) {
      const order = await client.getOrder({ symbol: intent.symbol, origClientOrderId: intent.clientOrderId })
      if (order && order.status === 'FILLED') {
        const price = parseFloat(order.fills?.[0]?.price || 0)
        intent.price = price
        const mockGetBalances = async () => ({ BTC: 0.00083333, USDT: 950 })
        await app.recoverPendingIntent(intent, { store, getBalances: mockGetBalances })
      }
    }

    // Restore original client methods
    client.getOrder = originalGetOrder
    client.order = originalOrder

    // 4. Afirmaciones (Assertions)
    // a) Status en SQLite cambia a CONFIRMED
    const updatedIntent = getIntent(testOrderId)
    assert.equal(updatedIntent.status, 'CONFIRMED', 'El status en SQLite debe haber cambiado a CONFIRMED')

    // b) NO se envió ninguna orden nueva a Binance
    assert.equal(marketOrderCalled, false, 'No se debió haber enviado ninguna orden nueva a Binance')
    assert.equal(getOrderCalled, true, 'Se debió haber consultado el estado de la orden en Binance')

    // c) Balances locales actualizados
    assert.equal(store.get('btc_balance'), 0.00083333, 'El balance local de BTC debe haberse actualizado')
    assert.equal(store.get('usdt_balance'), 950, 'El balance local de USDT debe haberse actualizado')
    assert.equal(store.get('start_price'), 60000, 'El start_price debe haberse actualizado al precio de ejecución')

    console.log('PASS: Chaos Recovery Integration Test - PENDING Intent reconciliado sin duplicar órdenes')
  } catch (err) {
    console.error('FAIL Chaos Recovery Test:', err)
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
