/**
 * services/pidLock.js
 * Control de concurrencia mediante archivo PID.
 * Evita la ejecución simultánea de múltiples instancias del bot para el mismo mercado (Split-Brain Protection).
 */
const fs = require('fs')
const path = require('path')
const { logColor, colors } = require('../utils/logger')

function acquirePidLock(market) {
    if (!market) return
    const dataDir = path.join(process.cwd(), 'data')
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true })
    }
    const pidFile = path.join(dataDir, `${market}.pid`)

    if (fs.existsSync(pidFile)) {
        try {
            const existingPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10)
            if (existingPid && existingPid !== process.pid) {
                // Verificar si el proceso con existingPid está vivo
                try {
                    process.kill(existingPid, 0)
                    logColor(colors.red, `[PID LOCK ERROR] Instancia ya en ejecución para el mercado ${market} (PID ${existingPid}).`)
                    process.exit(1)
                } catch (err) {
                    // Si lanza error, el proceso anterior ya no existe (stale PID file)
                    logColor(colors.yellow, `[PID LOCK] Limpiando archivo PID inactivo de sesión anterior para ${market} (PID ${existingPid}).`)
                }
            }
        } catch (e) {
            // Continuar si hubo error al leer
        }
    }

    fs.writeFileSync(pidFile, String(process.pid), 'utf8')

    const releasePidLock = () => {
        try {
            if (fs.existsSync(pidFile)) {
                const currentPidInFile = fs.readFileSync(pidFile, 'utf8').trim()
                if (currentPidInFile === String(process.pid)) {
                    fs.unlinkSync(pidFile)
                }
            }
        } catch (e) {}
    }

    process.on('exit', releasePidLock)
    process.on('SIGINT', () => { releasePidLock(); process.exit(0) })
    process.on('SIGTERM', () => { releasePidLock(); process.exit(0) })

    return releasePidLock
}

module.exports = {
    acquirePidLock
}
