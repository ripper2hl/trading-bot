const fs = require('fs')
const path = require('path')

const LOG_DIR = path.join(process.cwd(), 'logs')

// Crear directorio de logs si no existe
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true })
}

const colors = {
    green: '\x1b[32m%s\x1b[0m',
    red: '\x1b[31m%s\x1b[0m',
    gray: '\x1b[37m%s\x1b[0m',
    yellow: '\x1b[33m%s\x1b[0m',
    cyan: '\x1b[36m%s\x1b[0m'
}

/**
 * Genera el nombre de archivo de log del dia actual (YYYY-MM-DD.log)
 */
function getLogFileName() {
    const now = new Date()
    const dateStr = now.toISOString().split('T')[0]
    return path.join(LOG_DIR, `${dateStr}.log`)
}

/**
 * Escribe una linea de log estructurado (JSON) al archivo del dia
 */
function writeToFile(level, message, meta = {}) {
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        message: typeof message === 'string' ? message.trim() : String(message),
        ...meta
    }

    const line = JSON.stringify(entry) + '\n'

    try {
        fs.appendFileSync(getLogFileName(), line)
    } catch (err) {
        // No interrumpir el bot si no se puede escribir el log
    }
}

/**
 * Log con color a consola + archivo persistente
 */
const logColor = (color, content) => {
    console.log(color, content)
    const level = color === colors.red ? 'ERROR'
        : color === colors.green ? 'INFO'
            : color === colors.yellow ? 'WARN'
                : 'DEBUG'
    writeToFile(level, content)
}

/**
 * Log sin color a consola + archivo persistente
 */
const log = (content) => {
    console.log(content)
    writeToFile('INFO', content)
}

/**
 * Log estructurado de operacion de trading (compra, venta, orden)
 * Incluye metadatos especificos para auditoria
 */
const logTrade = (action, data) => {
    const entry = {
        timestamp: new Date().toISOString(),
        level: 'TRADE',
        action,
        ...data
    }

    const line = JSON.stringify(entry) + '\n'
    try {
        fs.appendFileSync(getLogFileName(), line)
    } catch (err) { }

    // Tambien a consola en formato legible
    const summary = `[TRADE] ${action} | ${data.symbol || ''} | qty: ${data.quantity || ''} | price: ${data.price || ''} | orderId: ${data.orderId || 'N/A'}`
    console.log(colors.yellow, summary)
}

module.exports = {
    logColor,
    log,
    logTrade,
    writeToFile,
    colors
}