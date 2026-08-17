process.env.TEST_MODE = 'true'
process.env.DRY_RUN = 'true'
process.env.MARKET1 = 'BTC'
process.env.MARKET2 = 'USDT'
process.env.NOTIFY_TELEGRAM_ENABLED = 'true'
process.env.NOTIFY_TELEGRAM_ON = 'buy,sell,risk'

const assert = require('node:assert/strict')
const proxyquire = require('proxyquire')

let exitCalls = 0
let telegramRiskCalls = 0
let reconcileFailures = 0

const app = proxyquire('../app', {
    './services/websocket': {
        initWebSocket: () => {},
        getLivePrice: () => 60000,
        closeWebSocket: () => {}
    },
    './services/TelegramNotify': {
        NotifyTelegram: async (data) => {
            if (data.from === 'risk') telegramRiskCalls++
        }
    },
    './services/state': {
        ...require('../services/state'),
        reconcileBalances: async () => {
            reconcileFailures++
            throw new Error('Mock fetch failed')
        }
    },
    './utils/network': {
        ...require('../utils/network'),
        sleep: async (ms) => {
            if (ms === 1000) {
                // El sleep del DEGRADED, avanzamos rápido
                return
            }
            if (ms === 50) return
            await new Promise(resolve => setTimeout(resolve, ms))
        }
    }
})

const originalExit = process.exit
process.exit = (code) => {
    exitCalls++
    if (code === 1 && exitCalls === 1) {
        console.log('El proceso intentó salir con código 1. Evaluando estado...')
        assert.equal(reconcileFailures, 3, 'El proceso murió antes de los 3 fallos o después de más fallos!')
        assert.equal(telegramRiskCalls, 2, 'No se enviaron exactamente 2 notificaciones de riesgo!')
        
        console.log('PASS: Circuit breaker aguantó 2 fallos y cerró el proceso al 3ro enviando las notificaciones correctas.')
        originalExit(0)
    }
    originalExit(code)
}

async function runTest() {
    console.log('Iniciando test del Circuit Breaker de reconcileBalances...')
    
    const { store } = require('../services/state')
    store.put('start_time', Date.now())
    store.put('strategy_baseline_equity', 10000)
    store.put('initial_usdt_balance', 10000)

    // broadcast is an infinite loop. It will run until process.exit is called.
    app.broadcast()
}

runTest()
