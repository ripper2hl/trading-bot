process.env.TEST_MODE = 'true'
process.env.DRY_RUN = 'true'
process.env.MARKET1 = 'BTC'
process.env.MARKET2 = 'USDT'

const proxyquire = require('proxyquire')

let telegramCalled = false

const websocket = proxyquire('../services/websocket', {
    './TelegramNotify': {
        NotifyTelegram: async (data) => {
            console.log('✅ NotifyTelegram fue invocado exitosamente con datos:', data)
            telegramCalled = true
        }
    }
})

// Configurar mock data para que los selects funcionen y no tiren error
const { store } = require('../services/state')
store.put('start_time', Date.now())
store.put('strategy_baseline_equity', 10000)
store.put('initial_usdt_balance', 10000)
store.put('initial_btc_balance', 0)
store.put('btc_balance', 0)
store.put('usdt_balance', 10000)

console.log('Llamando a notifyWsRisk(false)...')
websocket.notifyWsRisk(false).then(() => {
    if (!telegramCalled) {
        console.error('❌ NotifyTelegram nunca fue llamado.')
        process.exit(1)
    }
    console.log('OK: El runtime completo probó que notifyWsRisk funciona perfectamente sin ReferenceErrors.')
    process.exit(0)
})
