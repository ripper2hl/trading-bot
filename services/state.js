/**
 * services/state.js
 * Wrapper sobre node-storage y funciones de estado/balances.
 * Toda mutacion del archivo JSON local pasa por aqui.
 */
const Storage = require('node-storage')
const moment = require('moment')
const fs = require('fs')
const {
    MARKET1, MARKET2, MARKET,
    BALANCE_ABSOLUTE_TOLERANCE_BASE,
    BALANCE_ABSOLUTE_TOLERANCE_QUOTE
} = require('../config/constants')
const { log, logColor, colors } = require('../utils/logger')

const store = new Storage(`./data/${MARKET}.json`)

function elapsedTime() {
    const diff = Date.now() - store.get('start_time')
    var diffDays = diff / 86400000
    diffDays = diffDays < 1 ? '' : diffDays
    return diffDays + '' + moment.utc(diff).format('HH:mm:ss')
}

function _newPriceReset(_market, balance, price) {
    const market = _market == 1 ? MARKET1 : MARKET2
    if (!(parseFloat(store.get(`${market.toLowerCase()}_balance`)) > balance))
        store.put('start_price', price)
}

async function _updateBalances(getBalances) {
    const balances = await getBalances()
    store.put(`${MARKET1.toLowerCase()}_balance`, balances[MARKET1])
    store.put(`${MARKET2.toLowerCase()}_balance`, balances[MARKET2])
}

function _calculateProfits() {
    const orders = Array.isArray(store.get('orders')) ? store.get('orders') : []
    const sold = orders.filter(order => order && order.status === 'sold')

    if (sold.length > 0) {
        const totalSoldProfits = sold
            .map(order => order.profit)
            .reduce((prev, next) => parseFloat(prev) + parseFloat(next), 0)

        const currentProfits = parseFloat(store.get('profits') || 0)
        store.put('profits', parseFloat((currentProfits + totalSoldProfits).toFixed(4)))

        // Purga permanente de ordenes vendidas del store para evitar doble conteo
        const remainingOrders = orders.filter(order => order && order.status !== 'sold')
        store.put('orders', remainingOrders)
    }
}

function getRealProfits(price) {
    const m1Balance = parseFloat(store.get(`${MARKET1.toLowerCase()}_balance`))
    const m2Balance = parseFloat(store.get(`${MARKET2.toLowerCase()}_balance`))

    const initialBalance1 = parseFloat(store.get(`initial_${MARKET1.toLowerCase()}_balance`))
    const initialBalance2 = parseFloat(store.get(`initial_${MARKET2.toLowerCase()}_balance`))

    return parseFloat(parseFloat((m1Balance - initialBalance1) * price + m2Balance) - initialBalance2).toFixed(4)
}

/**
 * Calcula el equity base de referencia en unidades de MARKET2.
 * Formula: initial_USDT + (initial_BTC * precio_actual)
 *
 * Usa precio_actual (no congelado) a proposito: el numerador getRealProfits()
 * ya aisla el PnL de trading puro ((BTC_actual - BTC_inicial) * precio + USDT_actual - USDT_inicial),
 * asi que al dividir entre este denominador obtenemos el porcentaje de PnL
 * relativo al valor actual de la cartera, no al valor historico.
 * Esto evita que un movimiento grande de BTC distorsione los % de drawdown/TP/SL.
 *
 * Invariante: si no hay trades, getRealProfits() = 0, por lo que el % siempre es 0%
 * independientemente de cuanto cambie el precio — el BTC preexistente no genera PnL fantasma.
 */
function getInitialEquity(price) {
    const initialBalance1 = parseFloat(store.get(`initial_${MARKET1.toLowerCase()}_balance`)) || 0
    const initialBalance2 = parseFloat(store.get(`initial_${MARKET2.toLowerCase()}_balance`)) || 0
    return initialBalance1 * price + initialBalance2
}

function getCurrentEquity(price) {
    const m1Balance = parseFloat(store.get(`${MARKET1.toLowerCase()}_balance`)) || 0
    const m2Balance = parseFloat(store.get(`${MARKET2.toLowerCase()}_balance`)) || 0
    return (m1Balance * price) + m2Balance
}

function updatePeakEquity(price) {
    const currentEquity = getCurrentEquity(price)
    const initialEquity = getInitialEquity(price)
    const storedPeak = parseFloat(store.get('peak_equity'))

    let peak = (!isNaN(storedPeak) && storedPeak > 0)
        ? Math.max(storedPeak, currentEquity)
        : Math.max(initialEquity, currentEquity)

    store.put('peak_equity', peak)
    return peak
}

function getDrawdownFromPeak(price) {
    const currentEquity = getCurrentEquity(price)
    const peakEquity = updatePeakEquity(price)
    if (peakEquity <= 0) return 0
    return ((currentEquity - peakEquity) / peakEquity) * 100
}

function _logProfits(price) {
    const profits = parseFloat(store.get('profits'))
    var isGainerProfit = profits > 0 ? 1 : profits < 0 ? 2 : 0

    logColor(isGainerProfit == 1 ?
        colors.green : isGainerProfit == 2 ?
            colors.red : colors.gray,
        `Grid Profits (Incl. fees): ${parseFloat(store.get('profits')).toFixed(4)} ${MARKET2}`)

    const m1Balance = parseFloat(store.get(`${MARKET1.toLowerCase()}_balance`)) || 0
    const m2Balance = parseFloat(store.get(`${MARKET2.toLowerCase()}_balance`)) || 0
    const currentEquity = getCurrentEquity(price)
    const peakEquity = updatePeakEquity(price)
    const initialEquity = getInitialEquity(price)
    const ddFromPeak = getDrawdownFromPeak(price)

    logColor(colors.gray,
        `Balance: ${m1Balance} ${MARKET1}, ${m2Balance.toFixed(2)} ${MARKET2}`)
    logColor(colors.gray,
        `Current: ${parseFloat(currentEquity).toFixed(2)} ${MARKET2}, Peak: ${parseFloat(peakEquity).toFixed(2)} ${MARKET2}, Initial: ${parseFloat(initialEquity).toFixed(2)} ${MARKET2} (Drawdown: ${ddFromPeak.toFixed(2)}%)`)
}

async function reconcileBalances(getBalances, tolerancePercent = 1) {
    const balances = await getBalances()
    const localBase = parseFloat(store.get(`${MARKET1.toLowerCase()}_balance`)) || 0
    const localQuote = parseFloat(store.get(`${MARKET2.toLowerCase()}_balance`)) || 0
    const realBase = parseFloat(balances[MARKET1]) || 0
    const realQuote = parseFloat(balances[MARKET2]) || 0

    const absBaseDiff = Math.abs(realBase - localBase)
    const absQuoteDiff = Math.abs(realQuote - localQuote)

    const baseMismatch = localBase > 0
        ? (absBaseDiff / localBase) * 100
        : (realBase > 0 && absBaseDiff > BALANCE_ABSOLUTE_TOLERANCE_BASE ? 100 : 0)

    const quoteMismatch = localQuote > 0
        ? (absQuoteDiff / localQuote) * 100
        : (realQuote > 0 && absQuoteDiff > BALANCE_ABSOLUTE_TOLERANCE_QUOTE ? 100 : 0)

    const maxMismatch = Math.max(baseMismatch, quoteMismatch)

    if (maxMismatch > tolerancePercent || (localBase === 0 && realBase > BALANCE_ABSOLUTE_TOLERANCE_BASE) || (localQuote === 0 && realQuote > BALANCE_ABSOLUTE_TOLERANCE_QUOTE)) {
        const errorMessage = `[STATE MISMATCH] Desincronización grave detectada: ${MARKET1} local=${localBase}, real=${realBase}, drift=${baseMismatch.toFixed(2)}%; ${MARKET2} local=${localQuote}, real=${realQuote}, drift=${quoteMismatch.toFixed(2)}%; umbral=${tolerancePercent}%.`
        logColor(colors.red, errorMessage)
        throw new Error(errorMessage)
    }

    return {
        localBase,
        localQuote,
        realBase,
        realQuote,
        baseMismatch,
        quoteMismatch,
        maxMismatch,
    }
}

function _closeBot() {
    try {
        if (fs.existsSync(`./data/${MARKET}.json`)) {
            fs.unlinkSync(`./data/${MARKET}.json`)
        }
    } catch (ee) {
        logColor(colors.red, `[ERROR _closeBot] No se pudo eliminar el estado local: ${ee.message || ee}`)
    }
}

module.exports = {
    store,
    elapsedTime,
    _newPriceReset,
    _updateBalances,
    _calculateProfits,
    getRealProfits,
    getInitialEquity,
    getCurrentEquity,
    updatePeakEquity,
    getDrawdownFromPeak,
    _logProfits,
    reconcileBalances,
    _closeBot,
}
