process.env.TEST_MODE = 'true'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const originalArgv = process.argv.slice()
const originalEnv = { ...process.env }

process.argv = ['node', 'app.js', 'ETH', 'USDT', '40']
process.env.BINANCE_API_KEY = 'abc123'
process.env.BINANCE_API_SECRET = 'secret456'
process.env.BUY_PERCENT = '1'
process.env.SELL_PERCENT = '2'
process.env.STOP_LOSS_PERCENT = '2'
process.env.TAKE_PROFIT_PERCENT = '5'

async function runTest(label, fn) {
  try {
    await fn()
    console.log(`PASS: ${label}`)
  } catch (err) {
    console.error(`FAIL: ${label}`)
    console.error(err.stack || err.message)
    process.exitCode = 1
  }
}

function resetPersistedStoreFile() {
  const stateFile = path.join(__dirname, '../data/ETHUSDT.json')
  try {
    fs.unlinkSync(stateFile)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  fs.writeFileSync(stateFile, '{}')
}

function resetStoreState(store) {
  store.store = {}
  resetPersistedStoreFile()
  store.put('orders', [])
  store.put('profits', 0)
  store.put('fees', 0)
  store.put('sl_losses', 0)
  store.put('withdrawal_profits', 0)
  store.put('drawdown_killed', false)
  store.put('start_price', 0)
  store.put('entry_price', 0)
  store.put('eth_balance', 0)
  store.put('usdt_balance', 0)
  store.put('initial_eth_balance', 0)
  store.put('initial_usdt_balance', 0)
}

resetPersistedStoreFile()

;(async () => {
  const { recoverPendingIntent } = require('../app.js')
  const state = require('../services/state.js')
  const store = state.store

  await runTest('A - recoverPendingIntent SELL no toca entry/start price', async () => {
    resetStoreState(store)
    store.put('start_price', 100)
    store.put('entry_price', 100)
    store.put('initial_eth_balance', 10)
    store.put('initial_usdt_balance', 1000)
    store.put('eth_balance', 5)
    store.put('usdt_balance', 1500)

    const localStore = {
      values: {
        start_price: 100,
        entry_price: 100,
        initial_eth_balance: 10,
        initial_usdt_balance: 1000,
        eth_balance: 5,
        usdt_balance: 1500,
      },
      get(key) { return this.values[key] },
      put(key, value) { this.values[key] = value }
    }

    await recoverPendingIntent({ side: 'SELL', price: 110 }, { store: localStore, getBalances: async () => ({ ETH: 5, USDT: 1500 }) })

    assert.equal(localStore.get('start_price'), 100)
    assert.equal(localStore.get('entry_price'), 100)
  })

  await runTest('B - _sell partial sale only marks covered orders as sold', async () => {
    const client = require('../services/binance.js')
    const originalPrices = client.prices
    const originalGetBalances = client.accountInfo

    resetStoreState(store)
    store.put('orders', [
      { id: 'o1', amount: 1, status: 'pending', buy_price: 100, sell_price: 101 },
      { id: 'o2', amount: 2, status: 'pending', buy_price: 100, sell_price: 105 },
    ])
    store.put('eth_balance', 3)
    store.put('usdt_balance', 0)

    client.accountInfo = async () => ({ balances: [{ asset: 'ETH', free: '3' }, { asset: 'USDT', free: '0' }] })
    client.prices = async ({ symbol }) => ({ [symbol]: '101' })

    delete require.cache[require.resolve('../services/exchange.js')]
    delete require.cache[require.resolve('../controllers/tradingEngine.js')]

    const exchange = require('../services/exchange.js')
    const originalGetQuantity = exchange.getQuantity
    const originalMarketSell = exchange.marketSell
    exchange.getQuantity = async (amount) => amount
    exchange.marketSell = async () => ({ status: 'FILLED', fills: [{ price: '101' }] })

    const { _sell } = require('../controllers/tradingEngine.js')
    const result = await _sell(101, async () => {}, () => {})

    assert.ok(result)
    const orders = store.get('orders')
    assert.equal(orders.length, 1)
    assert.equal(orders[0].id, 'o2')
    assert.equal(orders[0].status, 'pending')
    assert.ok(!orders.some(order => order.id === 'o1'))

    client.prices = originalPrices
    client.accountInfo = originalGetBalances
    exchange.getQuantity = originalGetQuantity
    exchange.marketSell = originalMarketSell
  })

  await runTest('C - getFees converts BNB commission with BNB/USDT price', async () => {
    const client = require('../services/binance.js')
    const originalPrices = client.prices
    client.prices = async ({ symbol }) => {
      if (symbol === 'BNBUSDT') return { BNBUSDT: '3.5' }
      return { [symbol]: '100' }
    }

    try {
      const exchangeModule = require('../services/exchange.js')
      const fee = await exchangeModule.getFees({ commission: 0.1, commissionAsset: 'BNB' })
      assert.ok(Math.abs(fee - 0.35) < 1e-12)
    } finally {
      client.prices = originalPrices
    }
  })

  await runTest('D - MAX_OPEN_GRID_ORDERS bloquea la compra', async () => {
    process.env.MAX_OPEN_GRID_ORDERS = '2'
    resetStoreState(store)

    // CRITICAL: limpiar TODOS los módulos relevantes del caché DESPUÉS de setear env vars
    // para que cuando se requieran de nuevo, lean los nuevos valores de env
    delete require.cache[require.resolve('../config/constants.js')]
    delete require.cache[require.resolve('../services/exchange.js')]
    delete require.cache[require.resolve('../controllers/tradingEngine.js')]

    const exchange = require('../services/exchange.js')

    store.put('orders', [
      { id: 'o1', status: 'bought', amount: 1, buy_price: 100 },
      { id: 'o2', status: 'bought', amount: 1, buy_price: 101 },
    ])
    store.put('usdt_balance', 10000)
    store.put('eth_balance', 100)

    let marketBuyCalls = 0
    const originalMarketBuy = exchange.marketBuy
    exchange.marketBuy = async (...args) => {
      marketBuyCalls += 1
      return { status: 'FILLED', executedQty: '1', fills: [{ price: '100', commission: '0' }] }
    }

    // Luego require tradingEngine para que desestructure con las nuevas constantes
    const { _buy } = require('../controllers/tradingEngine.js')

    // Capturar logs para verificar que el guard fue ejecutado
    let capturedLogs = []
    const originalLog = console.log
    const originalError = console.error
    console.log = (...args) => {
      capturedLogs.push(args.join(' '))
    }
    console.error = (...args) => {
      capturedLogs.push(args.join(' '))
    }

    try {
      await _buy(100, 40, async () => {}, () => {})
      
      // Verificación 1: marketBuyCalls debe ser 0 (el guard bloqueó antes de llegar a marketBuy)
      assert.equal(marketBuyCalls, 0, `Expected marketBuyCalls to be 0 (guard should block), got ${marketBuyCalls}`)
      
      // Verificación 2: el log debe contener el mensaje del guard "[GRID]"
      const hasGuardLog = capturedLogs.some(log => log.includes('[GRID]') && log.includes('Máximo de órdenes compradas'))
      assert.ok(hasGuardLog, `Expected guard log with '[GRID]' and 'Máximo de órdenes compradas' in output, but got:\n${capturedLogs.join('\n')}`)
      
      // Verificación 3: el log NO debe contener "Buying ETH" (eso significaría que saltó el guard)
      const hasBuyingLog = capturedLogs.some(log => log.includes('Buying ETH'))
      assert.ok(!hasBuyingLog, `Guard should have prevented 'Buying ETH' log, but it appeared in:\n${capturedLogs.join('\n')}`)
    } finally {
      console.log = originalLog
      console.error = originalError
      exchange.marketBuy = originalMarketBuy
    }
  })

  await runTest('E - el kill-switch persiste a través de un reinicio simulado', async () => {
    resetStoreState(store)
    store.put('drawdown_killed', true)
    delete require.cache[require.resolve('../controllers/tradingEngine.js')]

    const freshTradingEngine = require('../controllers/tradingEngine.js')

    assert.equal(freshTradingEngine.isDrawdownKilled(), true)
    assert.equal(store.get('drawdown_killed'), true)
  })
})().catch((err) => {
  console.error('UNHANDLED:', err)
  process.exit(1)
}).finally(() => {
  process.argv = originalArgv
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key]
  }
  for (const key of Object.keys(originalEnv)) {
    process.env[key] = originalEnv[key]
  }
})
