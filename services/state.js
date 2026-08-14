/**
 * services/state.js
 * Wrapper sobre node-storage y funciones de estado/balances.
 * Toda mutacion del archivo JSON local pasa por aqui.
 */
const Storage = require('node-storage')
const moment = require('moment')
const fs = require('fs')
const { MARKET1, MARKET2, MARKET } = require('../config/constants')
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
    const orders = store.get('orders')
    const sold = orders.filter(order => order.status === 'sold')

    const totalSoldProfits = sold.length > 0 ?
        sold.map(order => order.profit).reduce((prev, next) =>
            parseFloat(prev) + parseFloat(next)) : 0

    store.put('profits', totalSoldProfits + parseFloat(store.get('profits')))
}

function getRealProfits(price) {
    const m1Balance = parseFloat(store.get(`${MARKET1.toLowerCase()}_balance`))
    const m2Balance = parseFloat(store.get(`${MARKET2.toLowerCase()}_balance`))

    const initialBalance1 = parseFloat(store.get(`initial_${MARKET1.toLowerCase()}_balance`))
    const initialBalance2 = parseFloat(store.get(`initial_${MARKET2.toLowerCase()}_balance`))

    return parseFloat(parseFloat((m1Balance - initialBalance1) * price + m2Balance) - initialBalance2).toFixed(4)
}

function _logProfits(price) {
    const profits = parseFloat(store.get('profits'))
    var isGainerProfit = profits > 0 ? 1 : profits < 0 ? 2 : 0

    logColor(isGainerProfit == 1 ?
        colors.green : isGainerProfit == 2 ?
            colors.red : colors.gray,
        `Grid Profits (Incl. fees): ${parseFloat(store.get('profits')).toFixed(4)} ${MARKET2}`)

    const m1Balance = parseFloat(store.get(`${MARKET1.toLowerCase()}_balance`))
    const m2Balance = parseFloat(store.get(`${MARKET2.toLowerCase()}_balance`))
    const initialBalance = parseFloat(store.get(`initial_${MARKET2.toLowerCase()}_balance`))

    logColor(colors.gray,
        `Balance: ${m1Balance} ${MARKET1}, ${m2Balance.toFixed(2)} ${MARKET2}`)
    logColor(colors.gray,
        `Current: ${parseFloat(m1Balance * price + m2Balance).toFixed(2)} ${MARKET2}, Initial: ${initialBalance.toFixed(2)} ${MARKET2}`)
}

async function reconcileBalances(getBalances, tolerancePercent = 1) {
    const balances = await getBalances()
    const localBase = parseFloat(store.get(`${MARKET1.toLowerCase()}_balance`)) || 0
    const localQuote = parseFloat(store.get(`${MARKET2.toLowerCase()}_balance`)) || 0
    const realBase = parseFloat(balances[MARKET1]) || 0
    const realQuote = parseFloat(balances[MARKET2]) || 0

    const baseMismatch = localBase > 0 ? Math.abs(realBase - localBase) / localBase * 100 : 0
    const quoteMismatch = localQuote > 0 ? Math.abs(realQuote - localQuote) / localQuote * 100 : 0
    const maxMismatch = Math.max(baseMismatch, quoteMismatch)

    if (maxMismatch > tolerancePercent) {
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
    _logProfits,
    reconcileBalances,
    _closeBot,
}
