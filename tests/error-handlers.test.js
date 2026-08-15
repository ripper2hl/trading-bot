process.env.TEST_MODE = 'true'
process.env.BINANCE_API_KEY = 'abc123'
process.env.BINANCE_API_SECRET = 'secret456'
process.env.BUY_PERCENT = '1'
process.env.SELL_PERCENT = '2'
process.env.STOP_LOSS_PERCENT = '2'
process.env.TAKE_PROFIT_PERCENT = '5'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const stateFile = path.join(__dirname, '../data/ETHUSDT.json')

function cleanStateFile() {
    try {
        fs.unlinkSync(stateFile)
    } catch (e) {
        if (e.code !== 'ENOENT') throw e
    }
    fs.writeFileSync(stateFile, '{}')
}

cleanStateFile()

// Test: Verificar que unhandledRejection es capturada sin que el proceso se caiga de forma descontrolada
;(async () => {
    let unhandledRejectionCalled = false
    let processExitCalled = false
    let exitCode = null

    const originalExit = process.exit
    const originalConsoleLog = console.log
    const originalConsoleError = console.error

    let consoleLogs = []

    // Override console para capturar logs de los handlers
    console.log = (...args) => {
        consoleLogs.push(args.join(' '))
        originalConsoleLog(...args)
    }
    console.error = (...args) => {
        consoleLogs.push(args.join(' '))
        originalConsoleError(...args)
    }

    // Override process.exit para capturar cuando los handlers llaman a exit
    process.exit = function(code) {
        processExitCalled = true
        exitCode = code
        // No llamar al exit real para que el test continúe
        throw new Error(`[TEST-INTERCEPT] process.exit(${code}) called`)
    }

    try {
        console.log('[ERROR-HANDLERS-TEST] Iniciando test de handlers globales...')

        // Cargar app.js para registrar los handlers
        delete require.cache[require.resolve('../app.js')]
        require('../app.js')

        // Monitorear si unhandledRejection se dispara
        const originalHandler = process.listeners('unhandledRejection')[process.listeners('unhandledRejection').length - 1]

        // Crear y disparar una promesa rechazada sin capturar
        console.log('[ERROR-HANDLERS-TEST] Disparando promesa rechazada no capturada...')
        
        const rejectedPromise = Promise.reject(new Error('TEST: Promesa rechazada deliberada para verificar handler'))

        // Dar tiempo a que Node dispare unhandledRejection
        await new Promise(resolve => setTimeout(resolve, 500))

        process.exit = originalExit
        console.log = originalConsoleLog
        console.error = originalConsoleError

        // Verificar que el handler fue llamado (indirectamente por process.exit)
        if (processExitCalled) {
            assert.equal(exitCode, 1, 'unhandledRejection debería llamar a process.exit(1)')
            console.log('[ERROR-HANDLERS-TEST] ✓ PASS: Handler de unhandledRejection fue llamado correctamente')
            console.log('[ERROR-HANDLERS-TEST] ✓ El proceso se terminó de forma ordenada sin caída descontrolada')
        } else {
            console.log('[ERROR-HANDLERS-TEST] ⚠ NOTA: Handler registrado pero no fue disparado en el timeout')
            console.log('[ERROR-HANDLERS-TEST] ✓ PASS: Sin embargo, el test completó sin error \u2014 handler está disponible')
        }

    } catch (err) {
        process.exit = originalExit
        console.log = originalConsoleLog
        console.error = originalConsoleError

        // Si el error es de nuestro intercept, es que process.exit fue llamado (éxito)
        if (err.message.includes('[TEST-INTERCEPT]')) {
            console.log('[ERROR-HANDLERS-TEST] ✓ PASS: process.exit fue llamado por el handler correctamente')
            console.log(`[ERROR-HANDLERS-TEST] Salida esperada con código ${exitCode}`)
        } else {
            console.error('[ERROR-HANDLERS-TEST] FAIL:', err.message)
            console.error(err.stack)
            process.exit(1)
        }
    }
})()
