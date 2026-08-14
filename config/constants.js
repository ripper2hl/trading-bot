/**
 * config/constants.js
 * Carga de variables de entorno y argumentos CLI.
 * Centraliza toda la configuracion del bot en un solo lugar.
 */
require('dotenv').config()

const MARKET1 = process.argv[2]
const MARKET2 = process.argv[3]
const MARKET = MARKET1 + MARKET2
const BUY_ORDER_AMOUNT = process.argv[4]

// === FLAGS DE PRODUCCION ===
const DRY_RUN = process.env.DRY_RUN === 'true' || process.env.DRY_RUN === '1'
const MAX_POSITION_PERCENT = parseFloat(process.env.MAX_POSITION_PERCENT || 5)
const DRAWDOWN_KILL_PERCENT = parseFloat(process.env.DRAWDOWN_KILL_PERCENT || 10)
const TRAILING_TP_PERCENT = parseFloat(process.env.TRAILING_TP_PERCENT || 0)
const FEE_RATE = parseFloat(process.env.FEE_RATE || 0.001)
const SLEEP_TIME = parseInt(process.env.SLEEP_TIME || 10000)

module.exports = {
    MARKET1,
    MARKET2,
    MARKET,
    BUY_ORDER_AMOUNT,
    DRY_RUN,
    MAX_POSITION_PERCENT,
    DRAWDOWN_KILL_PERCENT,
    TRAILING_TP_PERCENT,
    FEE_RATE,
    SLEEP_TIME,
}
