process.env.TEST_MODE = 'true'

const assert = require('node:assert/strict')

const originalArgv = process.argv.slice()
const originalEnv = { ...process.env }

process.argv = ['node', 'app.js', 'ETH', 'USDT', '40']
process.env.API_KEY = 'abc123'
process.env.API_SECRET = 'secret456'
process.env.BUY_PERCENT = '1'
process.env.SELL_PERCENT = '2'
process.env.STOP_LOSS_BOT = '2'
process.env.TAKE_PROFIT_BOT = '5'

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

;(async () => {
  const { recoverPendingIntent } = require('../app.js')

  await runTest('A - recoverPendingIntent SELL no toca entry/start price', async () => {
    const store = {
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

    await recoverPendingIntent({ side: 'SELL', price: 110 }, { store, getBalances: async () => ({ ETH: 5, USDT: 1500 }) })

    assert.equal(store.get('start_price'), 100)
    assert.equal(store.get('entry_price'), 100)
  })

  await runTest('B - _sell partial sale only marks covered orders as sold', async () => {
    const state = require('../services/state.js')
    const client = require('../services/binance.js')
    const originalPrices = client.prices
    const originalGetBalances = client.accountInfo

    const store = state.store
    store.put('orders', [
      { id: 'o1', amount: 1, status: 'pending', buy_price: 100, sell_price: 101 },
      { id: 'o2', amount: 2, status: 'pending', buy_price: 100, sell_price: 105 },
    ])
    store.put('profits', 0)
    store.put('fees', 0)
    store.put('sl_losses', 0)
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
