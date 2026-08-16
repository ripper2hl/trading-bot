/**
 * services/binance.js
 * Cliente de Binance API.
 * Lee credenciales y flags de entorno desde config/constants.js (fuente unica).
 */
const {
    BINANCE_API_KEY, BINANCE_API_SECRET, USE_TESTNET, TEST_MODE
} = require('../config/constants')

function createStubClient() {
    return {
        prices: async (options) => {
            if (options && options.symbol) {
                return { [options.symbol]: '60000' }
            }
            return { BTCUSDT: '60000', ETHUSDT: '3000' }
        },
        accountInfo: async () => ({ balances: [] }),
        getOrder: async () => ({
            status: 'FILLED',
            fills: [{ price: '0', commission: '0', commissionAsset: 'USDT' }],
        }),
        order: async () => ({
            status: 'FILLED',
            orderId: 'stub-order-id',
            executedQty: '0',
            fills: [{ price: '0', commission: '0', commissionAsset: 'USDT' }],
        }),
        cancelOrder: async () => ({ status: 'CANCELED' }),
        cancelOpenOrders: async () => ({}) ,
        allOrders: async () => [],
        exchangeInfo: async () => ({
            symbols: [{
                filters: [{ filterType: 'NOTIONAL', minNotional: '5.00' }]
            }]
        }),
        withdraw: async () => ({ status: 'success' }),
        getKlines: async (symbol, interval, limit) => {
            // Mock velas para el stub
            return Array(limit).fill({
                high: '60100',
                low: '59900',
                close: '60000'
            })
        }
    }
}

if (TEST_MODE) {
    console.log('[BINANCE] Test mode active: usando cliente stub')
    module.exports = createStubClient()
} else {
    const Binance = require('binance-api-node').default

    const clientOptions = {
        apiKey: BINANCE_API_KEY,
        apiSecret: BINANCE_API_SECRET,
        getTime: () => Date.now(),
    }

    if (USE_TESTNET) {
        clientOptions.httpBase = 'https://testnet.binance.vision'
        clientOptions.wsBase = 'wss://testnet.binance.vision/ws'
        console.log('[BINANCE] Conectado a TESTNET (no se usan fondos reales)')
    } else {
        console.log('[BINANCE] Conectado a PRODUCCION')
    }

    const client = Binance(clientOptions)
    
    client.getKlines = async (symbol, interval, limit) => {
        return await client.candles({ symbol, interval, limit })
    }

    module.exports = client
}
