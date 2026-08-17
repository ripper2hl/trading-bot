/**
 * config/constants.js
 * Carga de variables de entorno y argumentos CLI.
 * Centraliza toda la configuracion del bot en un solo lugar.
 *
 * REGLA: Ningun otro archivo debe leer process.env directamente.
 *        Todas las variables de entorno se importan desde aqui.
 */
require('dotenv').config()

// ─── CREDENCIALES ───────────────────────────────────────────────
const BINANCE_API_KEY = process.env.BINANCE_API_KEY || ''
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET || ''
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || ''

// ─── MERCADO (CLI / ENV) ────────────────────────────────────────
const MARKET1 = process.argv[2] || process.env.MARKET1
const MARKET2 = process.argv[3] || process.env.MARKET2
const MARKET = MARKET1 && MARKET2 ? MARKET1 + MARKET2 : null
const BUY_ORDER_AMOUNT = process.argv[4] || process.env.BUY_ORDER_AMOUNT
const RESUME = process.argv[5] === 'resume' || process.env.RESUME === 'true'

// ─── HELPERS ────────────────────────────────────────────────────

function toNumber(value, fallback) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
}

function ensureValidNumeric(value, name, fallback) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
    return fallback
}

// ─── VALIDACION DE ARRANQUE ─────────────────────────────────────

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

    if (!BINANCE_API_KEY || !BINANCE_API_SECRET) {
        errors.push('Faltan BINANCE_API_KEY y/o BINANCE_API_SECRET en el archivo .env.')
    }

    const numericChecks = {
        BUY_PERCENT: process.env.BUY_PERCENT,
        SELL_PERCENT: process.env.SELL_PERCENT,
        STOP_LOSS_PERCENT: process.env.STOP_LOSS_PERCENT,
        TAKE_PROFIT_PERCENT: process.env.TAKE_PROFIT_PERCENT,
        MAX_POSITION_PERCENT: process.env.MAX_POSITION_PERCENT,
        DRAWDOWN_KILL_PERCENT: process.env.DRAWDOWN_KILL_PERCENT,
        MAX_CAPITAL_USDT: process.env.MAX_CAPITAL_USDT,
        MAX_BTC_INVENTORY: process.env.MAX_BTC_INVENTORY,
        MAX_DAILY_LOSS_PERCENT: process.env.MAX_DAILY_LOSS_PERCENT,
        MAX_OPEN_GRID_ORDERS: process.env.MAX_OPEN_GRID_ORDERS,
        FEE_RATE: process.env.FEE_RATE,
        POLL_INTERVAL_MS: process.env.POLL_INTERVAL_MS,
        TRAILING_TP_PERCENT: process.env.TRAILING_TP_PERCENT,
    }

    const positiveNumericKeys = new Set([
        'BUY_PERCENT',
        'SELL_PERCENT',
        'STOP_LOSS_PERCENT',
        'TAKE_PROFIT_PERCENT',
        'MAX_POSITION_PERCENT',
        'DRAWDOWN_KILL_PERCENT',
        'MAX_OPEN_GRID_ORDERS',
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

// ─── PARAMETROS DE TRADING ──────────────────────────────────────
const DRY_RUN = process.env.DRY_RUN === 'true' || process.env.DRY_RUN === '1'
const BUY_PERCENT = ensureValidNumeric(process.env.BUY_PERCENT, 'BUY_PERCENT', 1)
const SELL_PERCENT = ensureValidNumeric(process.env.SELL_PERCENT, 'SELL_PERCENT', 2)
const STOP_LOSS_PERCENT = ensureValidNumeric(process.env.STOP_LOSS_PERCENT, 'STOP_LOSS_PERCENT', 2)
const TAKE_PROFIT_PERCENT = ensureValidNumeric(process.env.TAKE_PROFIT_PERCENT, 'TAKE_PROFIT_PERCENT', 5)
const MAX_POSITION_PERCENT = ensureValidNumeric(process.env.MAX_POSITION_PERCENT, 'MAX_POSITION_PERCENT', 5)
const DRAWDOWN_KILL_PERCENT = ensureValidNumeric(process.env.DRAWDOWN_KILL_PERCENT, 'DRAWDOWN_KILL_PERCENT', 10)
const MAX_CAPITAL_USDT = ensureValidNumeric(process.env.MAX_CAPITAL_USDT, 'MAX_CAPITAL_USDT', 0) // 0 = disabled
const MAX_BTC_INVENTORY = ensureValidNumeric(process.env.MAX_BTC_INVENTORY, 'MAX_BTC_INVENTORY', 0) // 0 = disabled
const MAX_DAILY_LOSS_PERCENT = ensureValidNumeric(process.env.MAX_DAILY_LOSS_PERCENT, 'MAX_DAILY_LOSS_PERCENT', 0) // 0 = disabled
const RISK_DAY_TIMEZONE = process.env.RISK_DAY_TIMEZONE || 'America/Monterrey'
const MAX_OPEN_GRID_ORDERS = ensureValidNumeric(process.env.MAX_OPEN_GRID_ORDERS, 'MAX_OPEN_GRID_ORDERS', 10)
const TRAILING_TP_PERCENT = ensureValidNumeric(process.env.TRAILING_TP_PERCENT, 'TRAILING_TP_PERCENT', 0)
const FEE_RATE = ensureValidNumeric(process.env.FEE_RATE, 'FEE_RATE', 0.001)
const POLL_INTERVAL_MS = Math.max(1000, Math.round(toNumber(process.env.POLL_INTERVAL_MS, 10000)))
const MULTIPLICADOR_ATR = ensureValidNumeric(process.env.MULTIPLICADOR_ATR, 'MULTIPLICADOR_ATR', 1)

// ─── GRID STOP-LOSS ─────────────────────────────────────────────
const GRID_STOP_LOSS_ENABLED = process.env.GRID_STOP_LOSS_ENABLED === 'true' || process.env.GRID_STOP_LOSS_ENABLED === '1'
const GRID_STOP_LOSS_PERCENT = ensureValidNumeric(process.env.GRID_STOP_LOSS_PERCENT, 'GRID_STOP_LOSS_PERCENT', 0.6)
const GRID_STOP_LOSS_FIFO = process.env.GRID_STOP_LOSS_FIFO === 'true' || process.env.GRID_STOP_LOSS_FIFO === '1'

// ─── NOTIFICACIONES ─────────────────────────────────────────────
const NOTIFY_TELEGRAM_ENABLED = process.env.NOTIFY_TELEGRAM_ENABLED === 'true' || process.env.NOTIFY_TELEGRAM_ENABLED === '1'
const NOTIFY_TELEGRAM_ON = process.env.NOTIFY_TELEGRAM_ON || ''

// ─── CICLO DE VIDA ──────────────────────────────────────────────
const SELL_ALL_ON_START = process.env.SELL_ALL_ON_START === 'true' || process.env.SELL_ALL_ON_START === '1'
const SELL_ALL_ON_CLOSE = process.env.SELL_ALL_ON_CLOSE === 'true' || process.env.SELL_ALL_ON_CLOSE === '1'
const START_AGAIN = process.env.START_AGAIN === 'true' || process.env.START_AGAIN === '1'

// ─── RETIROS ────────────────────────────────────────────────────
const WITHDRAW_PROFITS_ENABLED = process.env.WITHDRAW_PROFITS_ENABLED === 'true' || process.env.WITHDRAW_PROFITS_ENABLED === '1'
const MIN_WITHDRAW_AMOUNT = ensureValidNumeric(process.env.MIN_WITHDRAW_AMOUNT, 'MIN_WITHDRAW_AMOUNT', 0)
const DEFAULT_WITHDRAW_NETWORK = process.env.DEFAULT_WITHDRAW_NETWORK || ''
const WITHDRAW_ADDRESS_BUSD = process.env.WITHDRAW_ADDRESS_BUSD || ''
const WITHDRAW_ADDRESS_USDT = process.env.WITHDRAW_ADDRESS_USDT || ''

// ─── TOLERANCIAS DE RECONCILIACION ──────────────────────────────
const BALANCE_ABSOLUTE_TOLERANCE_BASE = ensureValidNumeric(process.env.BALANCE_ABSOLUTE_TOLERANCE_BASE, 'BALANCE_ABSOLUTE_TOLERANCE_BASE', 0.0001)
const BALANCE_ABSOLUTE_TOLERANCE_QUOTE = ensureValidNumeric(process.env.BALANCE_ABSOLUTE_TOLERANCE_QUOTE, 'BALANCE_ABSOLUTE_TOLERANCE_QUOTE', 0.1)

// ─── ENTORNO ────────────────────────────────────────────────────
const USE_TESTNET = process.env.USE_TESTNET === 'true' || process.env.USE_TESTNET === '1'
const TEST_MODE = process.env.TEST_MODE === 'true' || process.env.TEST_MODE === '1' || process.env.NODE_ENV === 'test'

module.exports = {
    // Credenciales
    BINANCE_API_KEY,
    BINANCE_API_SECRET,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    // Mercado
    MARKET1,
    MARKET2,
    MARKET,
    BUY_ORDER_AMOUNT,
    RESUME,
    // Parámetros de trading
    BUY_PERCENT,
    SELL_PERCENT,
    STOP_LOSS_PERCENT,
    TAKE_PROFIT_PERCENT,
    DRY_RUN,
    MAX_POSITION_PERCENT,
    DRAWDOWN_KILL_PERCENT,
    MAX_CAPITAL_USDT,
    MAX_BTC_INVENTORY,
    MAX_DAILY_LOSS_PERCENT,
    RISK_DAY_TIMEZONE,
    MAX_OPEN_GRID_ORDERS,
    TRAILING_TP_PERCENT,
    FEE_RATE,
    POLL_INTERVAL_MS,
    MULTIPLICADOR_ATR,
    // Grid stop-loss
    GRID_STOP_LOSS_ENABLED,
    GRID_STOP_LOSS_PERCENT,
    GRID_STOP_LOSS_FIFO,
    // Notificaciones
    NOTIFY_TELEGRAM_ENABLED,
    NOTIFY_TELEGRAM_ON,
    // Ciclo de vida
    SELL_ALL_ON_START,
    SELL_ALL_ON_CLOSE,
    START_AGAIN,
    // Retiros
    WITHDRAW_PROFITS_ENABLED,
    MIN_WITHDRAW_AMOUNT,
    DEFAULT_WITHDRAW_NETWORK,
    WITHDRAW_ADDRESS_BUSD,
    WITHDRAW_ADDRESS_USDT,
    // Entorno
    USE_TESTNET,
    TEST_MODE,
    // Tolerancias de reconciliación
    BALANCE_ABSOLUTE_TOLERANCE_BASE,
    BALANCE_ABSOLUTE_TOLERANCE_QUOTE,
    // Funciones
    validateBootstrapConfig,
}
