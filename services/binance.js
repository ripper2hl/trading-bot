const Binance = require('binance-api-node').default

const isTestnet = process.env.USE_TESTNET === 'true' || process.env.USE_TESTNET === '1'

const clientOptions = {
    apiKey: process.env.APIKEY,
    apiSecret: process.env.SECRET,
    getTime: () => Date.now(),
}

// Apuntar a la Testnet de Binance si la variable de entorno lo indica
if (isTestnet) {
    clientOptions.httpBase = 'https://testnet.binance.vision'
    clientOptions.wsBase = 'wss://testnet.binance.vision/ws'
    console.log('[BINANCE] Conectado a TESTNET (no se usan fondos reales)')
} else {
    console.log('[BINANCE] Conectado a PRODUCCION')
}

const client = Binance(clientOptions)

module.exports = client
