const assert = require('assert')
const fs = require('fs')

process.env.USE_TESTNET = 'true'
process.env.DRY_RUN = 'false'
process.env.BUY_ORDER_AMOUNT = '15'
process.env.MARKET1 = 'BTC'
process.env.MARKET2 = 'USDT'

const proxyquire = require('proxyquire')

let mockBinance = {
    order: async (opts) => {
        return {
            symbol: opts.symbol,
            orderId: 'stub-order',
            clientOrderId: opts.newClientOrderId,
            status: 'FILLED',
            executedQty: opts.side === 'BUY' ? '0.00025' : '0.00025',
            fills: [{
                price: '60000',
                qty: '0.00025',
                commission: '0',
                commissionAsset: 'USDT'
            }]
        }
    },
    exchangeInfo: async () => ({
        symbols: [{
            symbol: 'BTCUSDT',
            baseAssetPrecision: 6,
            filters: [
                { filterType: 'LOT_SIZE', stepSize: '0.00001' },
                { filterType: 'NOTIONAL', minNotional: '10' }
            ]
        }]
    })
}

const mockNotify = { NotifyTelegram: async () => {} }

const exchange = proxyquire('../services/exchange', {
    './binance': mockBinance,
    './TelegramNotify': mockNotify
})

const state = require('../services/state')
const { store } = state

const tradingEngine = proxyquire('../controllers/tradingEngine', {
    '../services/exchange': exchange,
    '../services/state': state,
    '../services/TelegramNotify': mockNotify
})

async function runTests() {
    console.log('Iniciando tests combinados (Liquidation Value y Counters)...')
    
    store.put(`initial_btc_balance`, 1) // 1 BTC preexistente
    store.put(`initial_usdt_balance`, 10000)
    store.put('start_price', 60000)
    store.put('btc_balance', 1)
    store.put('usdt_balance', 10000)
    store.put('orders', [])
    store.put('total_buys', 0)
    store.put('total_sells', 0)
    store.put('completed_cycles', 0)
    state.resolveInitialBaseline('USDT', 60000) // Se inicializa con precio 60000

    // 1. Verificamos valores iniciales sin trades
    let currentPrice = 60000
    let liq = state.getLiquidationValue(currentPrice)
    assert.strictEqual(liq.initial, 70000)
    assert.strictEqual(liq.current, 70000)
    assert.strictEqual(liq.pnl, 0)
    assert.strictEqual(store.get('total_buys'), 0)
    
    console.log('PASS: Liquidation inicial correcto (Sin PnL fantasma)')
    
    // 2. Ejecutar un BUY (Simulado por tradingEngine._buy)
    await tradingEngine._buy(60000, 15, async () => {}, () => {})
    
    // Validar el incremento del contador de BUY
    assert.strictEqual(store.get('total_buys'), 1)
    assert.strictEqual(store.get('total_sells'), 0)
    assert.strictEqual(store.get('completed_cycles'), 0)
    
    console.log('PASS: total_buys incrementó correctamente a 1 tras _buy')
    
    // 3. Ejecutar un SELL (Simulado por tradingEngine._sell) que cierra esa orden
    // Subimos el precio para que _sell lo capture
    currentPrice = 61000
    await tradingEngine._sell(currentPrice, async () => {}, () => {})
    
    assert.strictEqual(store.get('total_sells'), 1)
    assert.strictEqual(store.get('completed_cycles'), 1)
    
    console.log('PASS: total_sells incrementó a 1 y completed_cycles incrementó a 1 tras _sell de una orden completa')
    
    // 4. Verificamos que Liquidation Value haya calculado coherentemente
    // Se invirtió 15 USDT al comprar y se vendió a 61000. 15 USDT / 60000 = 0.00025 BTC
    // Venta de 0.00025 BTC a 61000 = 15.25 USDT. Ganancia = +0.25 USDT.
    // El BTC preexistente (1 BTC) ahora vale 61000 (+1000 PnL)
    // Liquidation PnL = +1000 (del BTC pasivo) + 0.25 (del trade) = 1000.25
    
    store.put('usdt_balance', 10000.25)
    store.put('btc_balance', 1) // El balance base regresa a 1 tras el ciclo de compra/venta
    
    // Simulamos que el engine modificó el start_price repetidamente (ej: precio cayó y se reseteó el reference price)
    store.put('start_price', 65000)
    assert.strictEqual(store.get('start_price'), 65000)
    
    liq = state.getLiquidationValue(currentPrice)
    assert.strictEqual(liq.initial, 70000) // T_init NO DEBE CAMBIAR
    assert.strictEqual(liq.current, 71000.25)
    assert.strictEqual(liq.pnl, 1000.25)
    
    console.log('PASS: Liquidation Value incorpora la apreciación del asset más la ganancia operativa (1000.25 PnL)')
    console.log('PASS: T_init en Liquidation Value NO cambia aunque start_price se actualizó a 61000')
    
    // 5. Test Partial Fill o Múltiples Cierres Simultáneos
    store.put('orders', [
        { id: '1', amount: '0.0001', buy_price: '60000', sell_price: '60500', status: 'bought' },
        { id: '2', amount: '0.0001', buy_price: '60000', sell_price: '60500', status: 'bought' }
    ])
    
    // Modificamos el mock para que "venda parcialmente" limitándolo desde el exchange o simulando que se vendieron 2
    // Pero solo usaremos _sell normal que intentará agruparlas
    await tradingEngine._sell(61000, async () => {}, () => {})
    
    assert.strictEqual(store.get('total_sells'), 2)
    assert.strictEqual(store.get('completed_cycles'), 3)
    
    console.log('PASS: Contador total_sells sumó 1 (2 en total) y completed_cycles sumó 2 órdenes cerradas juntas (3 en total).')
    
    console.log('Todos los tests de counters y Liquidation Value pasaron.')
}

runTests().catch(err => {
    console.error(err)
    process.exit(1)
})
