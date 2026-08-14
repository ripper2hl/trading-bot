const Binance = require('binance-api-node').default

const isTestMode = process.env.TEST_MODE === 'true' || process.env.TEST_MODE === '1' || process.env.NODE_ENV === 'test'
const isTestnet = process.env.USE_TESTNET === 'true' || process.env.USE_TESTNET === '1'

function createStubClient() {
    return {
        prices: async () => ({}),
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
        exchangeInfo: async () => ({ symbols: [] }),
        withdraw: async () => ({ status: 'success' }),
    }
}

if (isTestMode) {
    console.log('[BINANCE] Test mode active: usando cliente stub')
    module.exports = createStubClient()
} else {
    const clientOptions = {
        apiKey: process.env.APIKEY,
        apiSecret: process.env.SECRET,
        getTime: () => Date.now(),
    }

    if (isTestnet) {
        clientOptions.httpBase = 'https://testnet.binance.vision'
        clientOptions.wsBase = 'wss://testnet.binance.vision/ws'
        console.log('[BINANCE] Conectado a TESTNET (no se usan fondos reales)')
    } else {
        console.log('[BINANCE] Conectado a PRODUCCION')
    }

    const client = Binance(clientOptions)
    module.exports = client
}
