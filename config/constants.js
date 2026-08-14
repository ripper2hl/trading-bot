/**
 * config/constants.js
 * Carga de variables de entorno y argumentos CLI.
 * Centraliza toda la configuracion del bot en un solo lugar.
 */
require('dotenv').config()

const MARKET1 = process.argv[2]
const MARKET2 = process.argv[3]
const MARKET = MARKET1 && MARKET2 ? MARKET1 + MARKET2 : null
const BUY_ORDER_AMOUNT = process.argv[4]

function toNumber(value, fallback) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
}

function ensureValidNumeric(value, name, fallback) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
    return fallback
}

function validateBootstrapConfig() {
    const errors = []

    if (!MARKET1 || !/^[A-Za-z0-9]+$/.test(MARKET1)) {
        errors.push('Falta el símbolo base del mercado (primer argumento: ejemplo ETH).')
    }

    if (!MARKET2 || !/^[A-Za-z0-9]+$/.test(MARKET2)) {
        errors.push('Falta el símbolo de cotización (segundo argumento: ejemplo BUSD).')
    }

    if (!BUY_ORDER_AMOUNT || Number(BUY_ORDER_AMOUNT) <= 0 || !Number.isFinite(Number(BUY_ORDER_AMOUNT))) {
        errors.push('La cantidad invertida por compra debe ser un número mayor que 0.')
    }

    if (!process.env.API_KEY || !process.env.API_SECRET) {
        errors.push('Faltan API_KEY y/o API_SECRET en el archivo .env.')
    }

    const numericChecks = {
        BUY_PERCENT: process.env.BUY_PERCENT,
        SELL_PERCENT: process.env.SELL_PERCENT,
        STOP_LOSS_BOT: process.env.STOP_LOSS_BOT,
        TAKE_PROFIT_BOT: process.env.TAKE_PROFIT_BOT,
        MAX_POSITION_PERCENT: process.env.MAX_POSITION_PERCENT,
        DRAWDOWN_KILL_PERCENT: process.env.DRAWDOWN_KILL_PERCENT,
        FEE_RATE: process.env.FEE_RATE,
        SLEEP_TIME: process.env.SLEEP_TIME,
        TRAILING_TP_PERCENT: process.env.TRAILING_TP_PERCENT,
    }

    const positiveNumericKeys = new Set([
        'BUY_PERCENT',
        'SELL_PERCENT',
        'STOP_LOSS_BOT',
        'TAKE_PROFIT_BOT',
        'MAX_POSITION_PERCENT',
        'DRAWDOWN_KILL_PERCENT',
    ])

    for (const [key, value] of Object.entries(numericChecks)) {
        if (value === undefined || value === null || value === '') continue
        if (!Number.isFinite(Number(value))) {
            errors.push(`La variable ${key} debe ser numérica.`)
            continue
        }
        if (positiveNumericKeys.has(key) && Number(value) <= 0) {
            errors.push(`La variable ${key} debe ser estrictamente mayor que 0.`)
        }
    }

    return {
        ok: errors.length === 0,
        errors,
    }
}

// === FLAGS DE PRODUCCION ===
const DRY_RUN = process.env.DRY_RUN === 'true' || process.env.DRY_RUN === '1'
const BUY_PERCENT = ensureValidNumeric(process.env.BUY_PERCENT, 'BUY_PERCENT', 1)
const SELL_PERCENT = ensureValidNumeric(process.env.SELL_PERCENT, 'SELL_PERCENT', 2)
const STOP_LOSS_BOT = ensureValidNumeric(process.env.STOP_LOSS_BOT, 'STOP_LOSS_BOT', 2)
const TAKE_PROFIT_BOT = ensureValidNumeric(process.env.TAKE_PROFIT_BOT, 'TAKE_PROFIT_BOT', 5)
const MAX_POSITION_PERCENT = ensureValidNumeric(process.env.MAX_POSITION_PERCENT, 'MAX_POSITION_PERCENT', 5)
const DRAWDOWN_KILL_PERCENT = ensureValidNumeric(process.env.DRAWDOWN_KILL_PERCENT, 'DRAWDOWN_KILL_PERCENT', 10)
const TRAILING_TP_PERCENT = ensureValidNumeric(process.env.TRAILING_TP_PERCENT, 'TRAILING_TP_PERCENT', 0)
const FEE_RATE = ensureValidNumeric(process.env.FEE_RATE, 'FEE_RATE', 0.001)
const SLEEP_TIME = Math.max(1000, Math.round(toNumber(process.env.SLEEP_TIME, 10000)))

module.exports = {
    MARKET1,
    MARKET2,
    MARKET,
    BUY_ORDER_AMOUNT,
    BUY_PERCENT,
    SELL_PERCENT,
    STOP_LOSS_BOT,
    TAKE_PROFIT_BOT,
    DRY_RUN,
    MAX_POSITION_PERCENT,
    DRAWDOWN_KILL_PERCENT,
    TRAILING_TP_PERCENT,
    FEE_RATE,
    SLEEP_TIME,
    validateBootstrapConfig,
}
