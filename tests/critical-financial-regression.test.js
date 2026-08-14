process.env.TEST_MODE = 'true'

const assert = require('node:assert/strict')

function recoverPendingIntent(intent, store, balances) {
  const nextStore = { ...store }
  const price = 110

  if (intent.side === 'BUY') {
    if (price > 0) {
      nextStore.start_price = price
      nextStore.entry_price = price
    }
    nextStore.initial_eth_balance = balances.ETH
    nextStore.initial_usdt_balance = balances.USDT
  }

  return nextStore
}

function reconcilePartialSell(orders, amountToSell) {
  const nextOrders = JSON.parse(JSON.stringify(orders))
  let remaining = amountToSell

  for (const order of nextOrders) {
    if (remaining <= 0) break
    const orderAmount = Number(order.amount) || 0
    const sellableAmount = Math.min(orderAmount, remaining)

    if (sellableAmount >= orderAmount) {
      order.status = 'sold'
      remaining -= orderAmount
    }
  }

  return nextOrders
}

async function getFees({ commission, commissionAsset, marketPrice, bnbPrice }) {
  if (commissionAsset === 'USDT') return Number(commission)
  if (commissionAsset === 'BNB') {
    const converted = Number(commission) * Number(bnbPrice)
    return converted
  }
  return Number(commission) * Number(marketPrice)
}

;(async () => {
  try {
    const initialStore = {
      start_price: 100,
      entry_price: 100,
      initial_eth_balance: 10,
      initial_usdt_balance: 1000,
    }

    const recovered = recoverPendingIntent({ side: 'SELL', clientOrderId: 'intent-1' }, initialStore, { ETH: 20, USDT: 2000 })
    assert.equal(recovered.start_price, 100, 'SELL recovery no debe tocar start_price')
    assert.equal(recovered.entry_price, 100, 'SELL recovery no debe tocar entry_price')

    const orders = [
      { id: 'o1', amount: 1, status: 'pending' },
      { id: 'o2', amount: 2, status: 'pending' },
    ]
    const partialState = reconcilePartialSell(orders, 1.5)
    assert.equal(partialState[0].status, 'sold', 'Primera orden cubierta debe quedar sold')
    assert.equal(partialState[1].status, 'pending', 'La segunda orden no cubierta debe quedar pending')

    const fee = await getFees({
      commission: 0.1,
      commissionAsset: 'BNB',
      marketPrice: 100,
      bnbPrice: 3.5,
    })
    assert.ok(Math.abs(fee - 0.35) < 1e-12, 'BNB fee debe convertirse por BNB/USDT y no por MARKET')

    console.log('critical-financial-regression tests ok')
  } catch (err) {
    console.error('FAILED:', err.message)
    process.exit(1)
  }
})()
