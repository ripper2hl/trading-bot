process.env.TEST_MODE = 'true'
process.env.DRY_RUN = 'true'
process.env.MARKET1 = 'BTC'
process.env.MARKET2 = 'USDT'
process.env.BUY_ORDER_AMOUNT = '15'
process.env.BINANCE_API_KEY = 'test'
process.env.BINANCE_API_SECRET = 'test'
process.env.BUY_PERCENT = '1'
process.env.STOP_LOSS_PERCENT = '2'
process.env.TAKE_PROFIT_PERCENT = '5'

const assert = require('node:assert/strict')
const proxyquire = require('proxyquire')

const originalArgv = process.argv.slice()
const originalEnv = { ...process.env }

let evaluateCalls = 0
let mutexHits = 0
let currentConcurrency = 0
let maxConcurrency = 0

// Mock dependencies
const app = proxyquire('../app', {
    './services/websocket': {
        initWebSocket: () => {},
        getLivePrice: () => 60000
    },
    './services/state': {
        ...require('../services/state'),
        reconcileBalances: async () => {
            currentConcurrency++
            if (currentConcurrency > maxConcurrency) maxConcurrency = currentConcurrency
            evaluateCalls++
            // Simular operación async lenta (500ms)
            await new Promise(resolve => setTimeout(resolve, 500))
            currentConcurrency--
        },
        _updateBalances: async () => {}
    },
    './utils/network': {
        ...require('../utils/network'),
        sleep: async (ms) => {
            if (ms === 50) {
                mutexHits++
                // Forzar salida del loop para la iteración rebotada
                throw new Error('MutexBounceError')
            }
            if (ms >= 1000) {
                // Forzar salida del loop al terminar la evaluación principal
                throw new Error('EndLoopError')
            }
            await new Promise(resolve => setTimeout(resolve, ms))
        }
    },
    './utils/logger': {
        ...require('../utils/logger'),
        logColor: (color, msg) => {
            // Silenciar errores inducidos intencionalmente para no ensuciar el output
            if (!msg.includes('MutexBounceError') && !msg.includes('EndLoopError')) {
                console.log(msg)
            }
        }
    }
})

async function runTest() {
    console.log('Iniciando test de ráfaga de WebSockets (5 ticks simultáneos)...')
    
    // Configuramos DRY_RUN para que no intente ejecutar nada real
    process.env.DRY_RUN = 'true'
    
    // Forzamos un estado limpio en el store antes de evaluar el ciclo
    const { store } = require('../services/state')
    store.put('start_time', Date.now())
    store.put('strategy_baseline_equity', 10000)
    store.put('peak_equity_curve', 10000)
    store.put('initial_usdt_balance', 10000)
    store.put('initial_btc_balance', 0)
    store.put('btc_balance', 0)
    store.put('usdt_balance', 10000)
    store.put('orders', [])
    store.put('profits', 0)
    store.put('start_price', 60000)
    store.put('entry_price', 60000)
    store.put('withdrawal_profits', 0)
    store.put('sl_losses', 0)
    store.put('start_time', Date.now())

    // Disparamos 5 llamadas al ciclo completo (simulando 5 mensajes WS rapidísimos)
    const calls = []
    for (let i = 0; i < 5; i++) {
        // Envolvemos en catch para atrapar el error inducido que rompe el while(true)
        calls.push(app.broadcast().catch(e => {
            if (e.message !== 'EndLoopError') throw e
        }))
    }

    // Esperamos a que todas las promesas (loops) terminen
    await Promise.all(calls)

    console.log(`Evaluaciones ejecutadas totales: ${evaluateCalls}`)
    console.log(`Veces que el mutex rebotó un tick solapado: ${mutexHits}`)
    console.log(`Concurrencia máxima detectada: ${maxConcurrency}`)

    assert.equal(evaluateCalls, 1, 'Se ejecutó más de una evaluación genuina!')
    assert.equal(mutexHits, 4, 'El mutex no rebotó exactamente las 4 llamadas solapadas!')
    assert.equal(maxConcurrency, 1, 'La concurrencia superó a 1')

    console.log('PASS: Mutex maneja ráfagas concurrentes correctamente')
    process.exit(0)
}

runTest().catch(err => {
    console.error('FAILED:', err)
    process.exit(1)
})
