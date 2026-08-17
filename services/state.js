/**
 * services/state.js
 * Wrapper sobre node-storage y funciones de estado/balances.
 * Toda mutacion del archivo JSON local pasa por aqui.
 */
const Storage = require('node-storage')
const moment = require('moment')
const fs = require('fs')
const Decimal = require('../utils/decimal')
const {
    MARKET1, MARKET2, MARKET,
    BALANCE_ABSOLUTE_TOLERANCE_BASE,
    BALANCE_ABSOLUTE_TOLERANCE_QUOTE,
    MAX_DAILY_LOSS_PERCENT,
    DRAWDOWN_KILL_PERCENT,
    RISK_DAY_TIMEZONE
} = require('../config/constants')

function ensureValidDecimal(value, name) {
    if (value === undefined || value === null || value === '') {
        throw new Error(`[FAIL-CLOSED] Valor faltante o vacío para ${name}`)
    }
    let d
    try {
        d = new Decimal(value)
    } catch (e) {
        throw new Error(`[FAIL-CLOSED] Fallo al instanciar Decimal para ${name}: ${value}`)
    }
    if (d.isNaN() || !d.isFinite()) {
        throw new Error(`[FAIL-CLOSED] Valor no finito o NaN para ${name}: ${value}`)
    }
    return d
}
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
    const currentBalance = new Decimal(store.get(`${market.toLowerCase()}_balance`) || 0)
    if (!currentBalance.greaterThan(balance)) {
        store.put('start_price', price) // TODO: precio sigue entrando como number en otras partes, revisar despues
    }
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
            .map(order => new Decimal(order.profit || 0))
            .reduce((prev, next) => prev.plus(next), new Decimal(0))

        const currentProfits = new Decimal(store.get('profits') || 0)
        // TODO: DECIMAL_BRIDGE
        store.put('profits', currentProfits.plus(totalSoldProfits).toDecimalPlaces(4, Decimal.ROUND_HALF_EVEN).toNumber())

        // Purga permanente de ordenes vendidas del store para evitar doble conteo
        const remainingOrders = orders.filter(order => order && order.status !== 'sold')
        store.put('orders', remainingOrders)
    }
}

function getRealProfits(price) {
    const m1Balance = new Decimal(store.get(`${MARKET1.toLowerCase()}_balance`) || 0)
    const m2Balance = new Decimal(store.get(`${MARKET2.toLowerCase()}_balance`) || 0)

    const initialBalance1 = new Decimal(store.get(`initial_${MARKET1.toLowerCase()}_balance`) || 0)
    const initialBalance2 = new Decimal(store.get(`initial_${MARKET2.toLowerCase()}_balance`) || 0)

    const dPrice = new Decimal(price || 0)

    // ((m1Balance - initialBalance1) * price + m2Balance) - initialBalance2
    const baseDiff = m1Balance.minus(initialBalance1)
    const pnlBase = baseDiff.times(dPrice)
    const totalWithM2 = pnlBase.plus(m2Balance)
    const realProfits = totalWithM2.minus(initialBalance2)

    // TODO: DECIMAL_BRIDGE (Retorna string formateado como hacia parseFloat(..).toFixed(4))
    return realProfits.toDecimalPlaces(4, Decimal.ROUND_HALF_EVEN).toFixed(4)
}

function getInitialEquity(price) {
    const initialBalance1 = new Decimal(store.get(`initial_${MARKET1.toLowerCase()}_balance`) || 0)
    const initialBalance2 = new Decimal(store.get(`initial_${MARKET2.toLowerCase()}_balance`) || 0)
    const dPrice = new Decimal(price || 0)

    const equity = initialBalance1.times(dPrice).plus(initialBalance2)
    // TODO: DECIMAL_BRIDGE
    return equity.toNumber()
}

function getCurrentEquity(price) {
    const m1Balance = new Decimal(store.get(`${MARKET1.toLowerCase()}_balance`) || 0)
    const m2Balance = new Decimal(store.get(`${MARKET2.toLowerCase()}_balance`) || 0)
    const dPrice = new Decimal(price || 0)

    const equity = m1Balance.times(dPrice).plus(m2Balance)
    // TODO: DECIMAL_BRIDGE
    return equity.toNumber()
}

function updatePeakEquity(price) {
    const currentEquity = new Decimal(getCurrentEquity(price))
    const initialEquity = new Decimal(getInitialEquity(price))

    const storedPeakRaw = store.get('peak_equity')
    const storedPeak = new Decimal(storedPeakRaw !== undefined && storedPeakRaw !== null ? storedPeakRaw : 0)

    let peak
    if (!storedPeak.isNaN() && storedPeak.greaterThan(0)) {
        peak = Decimal.max(storedPeak, currentEquity)
    } else {
        peak = Decimal.max(initialEquity, currentEquity)
    }

    // TODO: DECIMAL_BRIDGE
    const peakNum = peak.toNumber()
    if (peakNum !== Number(storedPeakRaw)) {
        store.put('peak_equity', peakNum)
    }
    return peakNum
}

function getDrawdownFromPeak(price, providedPeak) {
    const currentEquity = new Decimal(getCurrentEquity(price))

    let peakEquity
    if (providedPeak !== undefined) {
        peakEquity = new Decimal(providedPeak)
    } else {
        const storedPeakRaw = store.get('peak_equity')
        peakEquity = new Decimal(storedPeakRaw !== undefined && storedPeakRaw !== null ? storedPeakRaw : getInitialEquity(price))
    }

    if (peakEquity.lessThanOrEqualTo(0)) return 0

    // ((currentEquity - peakEquity) / peakEquity) * 100
    const drawdown = currentEquity.minus(peakEquity).dividedBy(peakEquity).times(100)
    // TODO: DECIMAL_BRIDGE
    return drawdown.toNumber()
}

function _getTradingEquityCurveDecimal(price) {
    const frozenCapitalRaw = store.get('strategy_baseline_equity')

    let frozenCapital
    if (frozenCapitalRaw !== undefined && frozenCapitalRaw !== null && frozenCapitalRaw !== '') {
        frozenCapital = ensureValidDecimal(frozenCapitalRaw, 'strategy_baseline_equity')
    } else {
        if (!price) throw new Error('[FAIL-CLOSED] Se requiere price para calcular initialEquity por falta de baseline')
        frozenCapital = ensureValidDecimal(getInitialEquity(price), 'getInitialEquity()')
    }

    const profitsStoreRaw = store.get('profits')
    let currentProfit
    if (profitsStoreRaw !== undefined && profitsStoreRaw !== null && profitsStoreRaw !== '') {
        currentProfit = ensureValidDecimal(profitsStoreRaw, 'profits')
    } else {
        if (!price) throw new Error('[FAIL-CLOSED] Se requiere price para calcular realProfits por falta de profits persistidos')
        currentProfit = ensureValidDecimal(getRealProfits(price), 'getRealProfits()')
    }

    return frozenCapital.plus(currentProfit)
}

function getTradingEquityCurve(price) {
    return _getTradingEquityCurveDecimal(price).toNumber()
}

function _updatePeakEquityCurveDecimal(price) {
    const equityCurve = _getTradingEquityCurveDecimal(price)
    const storedPeakRaw = store.get('peak_equity_curve')

    let peak
    if (storedPeakRaw !== undefined && storedPeakRaw !== null && storedPeakRaw !== '') {
        const storedPeak = ensureValidDecimal(storedPeakRaw, 'peak_equity_curve')
        if (storedPeak.greaterThan(0)) {
            peak = Decimal.max(storedPeak, equityCurve)
        } else {
            peak = equityCurve
        }
    } else {
        peak = equityCurve
    }

    const peakNum = peak.toNumber()
    if (peakNum !== Number(storedPeakRaw)) {
        store.put('peak_equity_curve', peakNum)
    }
    return peak
}

function updatePeakEquityCurve(price) {
    return _updatePeakEquityCurveDecimal(price).toNumber()
}

function _calculateTradingDrawdownDecimal(price, providedPeak) {
    const equityCurve = _getTradingEquityCurveDecimal(price)

    let peak
    if (providedPeak !== undefined && providedPeak !== null) {
        peak = ensureValidDecimal(providedPeak, 'providedPeak')
    } else {
        const storedPeakRaw = store.get('peak_equity_curve')
        if (storedPeakRaw !== undefined && storedPeakRaw !== null && storedPeakRaw !== '') {
            peak = ensureValidDecimal(storedPeakRaw, 'peak_equity_curve')
        } else {
            peak = _updatePeakEquityCurveDecimal(price)
        }
    }

    if (peak.lessThanOrEqualTo(0)) {
        throw new Error('[FAIL-CLOSED] El peak_equity_curve es <= 0 al calcular drawdown')
    }

    // ((equityCurve - peak) / peak) * 100
    return equityCurve.minus(peak).dividedBy(peak).times(100)
}

function getTradingDrawdown(price, providedPeak) {
    return _calculateTradingDrawdownDecimal(price, providedPeak).toNumber()
}

function checkTradingDrawdown(price, providedPeak) {
    if (!DRAWDOWN_KILL_PERCENT || DRAWDOWN_KILL_PERCENT <= 0) return { exceeded: false, drawdown: 0, limit: 0 };

    const dDrawdown = _calculateTradingDrawdownDecimal(price, providedPeak)
    const dLimit = ensureValidDecimal(DRAWDOWN_KILL_PERCENT, 'DRAWDOWN_KILL_PERCENT')

    const isExceeded = dDrawdown.abs().greaterThanOrEqualTo(dLimit)

    return {
        exceeded: isExceeded,
        drawdown: dDrawdown.toNumber(),
        limit: DRAWDOWN_KILL_PERCENT
    }
}

function checkDailyLoss(price) {
    if (!MAX_DAILY_LOSS_PERCENT || MAX_DAILY_LOSS_PERCENT <= 0) return { exceeded: false, loss: 0, limit: 0 };

    const tzDateStr = new Date().toLocaleDateString('en-CA', { timeZone: RISK_DAY_TIMEZONE });
    const storedDate = store.get('daily_baseline_date');
    const liq = getLiquidationValue(price);

    if (storedDate !== tzDateStr) {
        store.put('daily_baseline_date', tzDateStr);
        store.put('daily_baseline_liquidation_value', liq.current);
        return { exceeded: false, loss: 0, limit: -MAX_DAILY_LOSS_PERCENT };
    }

    const dailyBaselineRaw = store.get('daily_baseline_liquidation_value')
    let dailyBaseline
    if (dailyBaselineRaw !== undefined && dailyBaselineRaw !== null && dailyBaselineRaw !== '') {
        dailyBaseline = ensureValidDecimal(dailyBaselineRaw, 'daily_baseline_liquidation_value')
    } else {
        throw new Error('[FAIL-CLOSED] daily_baseline_liquidation_value está corrupto o vacío para el día actual')
    }

    if (dailyBaseline.lessThanOrEqualTo(0)) {
        throw new Error('[FAIL-CLOSED] dailyBaseline es <= 0 al evaluar dailyLoss')
    }

    const dCurrent = ensureValidDecimal(liq.current, 'liq.current')

    // ((liq.current - dailyBaseline) / dailyBaseline) * 100;
    const dailyLossPercent = dCurrent.minus(dailyBaseline).dividedBy(dailyBaseline).times(100);

    const dLimit = ensureValidDecimal(-MAX_DAILY_LOSS_PERCENT, 'MAX_DAILY_LOSS_PERCENT (negative)')
    const isExceeded = dailyLossPercent.lessThanOrEqualTo(dLimit)

    return {
        exceeded: isExceeded,
        loss: dailyLossPercent.toNumber(),
        limit: -MAX_DAILY_LOSS_PERCENT
    }
}

function getLiquidationValue(price) {
    const tInitRaw = store.get('initial_liquidation_value')
    let T_init
    if (tInitRaw !== undefined && tInitRaw !== null && tInitRaw !== '') {
        T_init = ensureValidDecimal(tInitRaw, 'initial_liquidation_value')
    } else {
        if (!price) throw new Error('[FAIL-CLOSED] Falta price para calcular fallback initial_liquidation_value')
        T_init = ensureValidDecimal(resolveInitialBaseline(MARKET2, price), 'resolveInitialBaseline()')
    }

    const quoteRaw = store.get(`${MARKET2.toLowerCase()}_balance`)
    const currentQuote = ensureValidDecimal(quoteRaw !== undefined && quoteRaw !== null ? quoteRaw : 0, 'currentQuote')

    const baseRaw = store.get(`${MARKET1.toLowerCase()}_balance`)
    const currentBase = ensureValidDecimal(baseRaw !== undefined && baseRaw !== null ? baseRaw : 0, 'currentBase')

    const dPrice = ensureValidDecimal(price !== undefined && price !== null ? price : 0, 'price en getLiquidationValue')

    const T_curr = currentQuote.plus(currentBase.times(dPrice))

    const pnl = T_curr.minus(T_init)

    let percent = new Decimal(0)
    if (T_init.greaterThan(0)) {
        percent = pnl.dividedBy(T_init).times(100)
    }

    // TODO: DECIMAL_BRIDGE
    return {
        initial: T_init.toNumber(),
        current: T_curr.toNumber(),
        pnl: pnl.toNumber(),
        percent: percent.toNumber()
    }
}

function _logProfits(price) {
    const profits = parseFloat(store.get('profits'))
    var isGainerProfit = profits > 0 ? 1 : profits < 0 ? 2 : 0

    logColor(isGainerProfit == 1 ?
        colors.green : isGainerProfit == 2 ?
            colors.red : colors.gray,
        `Grid Profits (Incl. fees): ${parseFloat(store.get('profits')).toFixed(4)} ${MARKET2}`)

    const liq = getLiquidationValue(price)
    const isGainerLiq = liq.pnl > 0 ? 1 : liq.pnl < 0 ? 2 : 0
    logColor(isGainerLiq == 1 ? colors.green : isGainerLiq == 2 ? colors.red : colors.gray,
        `Liquidation Value: ${liq.current.toFixed(2)} ${MARKET2} (vs ${liq.initial.toFixed(2)} ${MARKET2}) ==> PnL: ${liq.pnl >= 0 ? '+' : ''}${liq.pnl.toFixed(2)} ${MARKET2} (${liq.percent >= 0 ? '+' : ''}${liq.percent.toFixed(2)}%)`)

    const m1Balance = parseFloat(store.get(`${MARKET1.toLowerCase()}_balance`)) || 0
    const m2Balance = parseFloat(store.get(`${MARKET2.toLowerCase()}_balance`)) || 0
    const currentEquity = getCurrentEquity(price)
    const initialEquity = getInitialEquity(price)
    const equityCurve = getTradingEquityCurve(price)
    const peakCurve = updatePeakEquityCurve(price)
    const tradingDD = getTradingDrawdown(price, peakCurve)

    logColor(colors.gray,
        `Balance: ${m1Balance} ${MARKET1}, ${m2Balance.toFixed(2)} ${MARKET2}`)
    logColor(colors.gray,
        `Current Equity: ${parseFloat(currentEquity).toFixed(2)} ${MARKET2}, Initial: ${parseFloat(initialEquity).toFixed(2)} ${MARKET2}`)
    logColor(colors.gray,
        `Equity Curve: ${equityCurve.toFixed(2)} ${MARKET2}, Peak Curve: ${peakCurve.toFixed(2)} ${MARKET2}, Trading Drawdown: ${tradingDD.toFixed(2)}%`)

    logColor(colors.gray,
        `Historial: ${parseInt(store.get('total_buys')) || 0} compras | ${parseInt(store.get('total_sells')) || 0} ventas | ${parseInt(store.get('completed_cycles')) || 0} ciclos completos`)
}

async function reconcileBalances(getBalances, tolerancePercent = 1) {
    const balances = await getBalances()
    const localBase = new Decimal(store.get(`${MARKET1.toLowerCase()}_balance`) || 0)
    const localQuote = new Decimal(store.get(`${MARKET2.toLowerCase()}_balance`) || 0)
    const realBase = new Decimal(balances[MARKET1] || 0)
    const realQuote = new Decimal(balances[MARKET2] || 0)

    const absBaseDiff = realBase.minus(localBase).absoluteValue()
    const absQuoteDiff = realQuote.minus(localQuote).absoluteValue()

    let baseMismatch = new Decimal(0)
    if (localBase.greaterThan(0)) {
        baseMismatch = absBaseDiff.dividedBy(localBase).times(100)
    } else if (realBase.greaterThan(0) && absBaseDiff.greaterThan(BALANCE_ABSOLUTE_TOLERANCE_BASE)) {
        baseMismatch = new Decimal(100)
    }

    let quoteMismatch = new Decimal(0)
    if (localQuote.greaterThan(0)) {
        quoteMismatch = absQuoteDiff.dividedBy(localQuote).times(100)
    } else if (realQuote.greaterThan(0) && absQuoteDiff.greaterThan(BALANCE_ABSOLUTE_TOLERANCE_QUOTE)) {
        quoteMismatch = new Decimal(100)
    }

    const maxMismatch = Decimal.max(baseMismatch, quoteMismatch)

    if (maxMismatch.greaterThan(tolerancePercent) ||
        (localBase.isZero() && realBase.greaterThan(BALANCE_ABSOLUTE_TOLERANCE_BASE)) ||
        (localQuote.isZero() && realQuote.greaterThan(BALANCE_ABSOLUTE_TOLERANCE_QUOTE))) {

        // TODO: DECIMAL_BRIDGE
        const baseMisNum = baseMismatch.toNumber()
        const quoteMisNum = quoteMismatch.toNumber()

        const errorMessage = `[STATE MISMATCH] Desincronización grave detectada: ${MARKET1} local=${localBase.toNumber()}, real=${realBase.toNumber()}, drift=${baseMisNum.toFixed(2)}%; ${MARKET2} local=${localQuote.toNumber()}, real=${realQuote.toNumber()}, drift=${quoteMisNum.toFixed(2)}%; umbral=${tolerancePercent}%.`
        logColor(colors.red, errorMessage)
        throw new Error(errorMessage)
    }

    // TODO: DECIMAL_BRIDGE
    return {
        localBase: localBase.toNumber(),
        localQuote: localQuote.toNumber(),
        realBase: realBase.toNumber(),
        realQuote: realQuote.toNumber(),
        baseMismatch: baseMismatch.toNumber(),
        quoteMismatch: quoteMismatch.toNumber(),
        maxMismatch: maxMismatch.toNumber(),
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

function resolveInitialBaseline(market2 = MARKET2, fallbackPrice = 0) {
    const existing = store.get('strategy_baseline_equity')
    let baseline = new Decimal(0)

    if (existing !== undefined && existing !== null) {
        baseline = new Decimal(existing)
    } else {
        const quoteKey = `initial_${market2.toLowerCase()}_balance`
        const fallbackQuoteKey = `${market2.toLowerCase()}_balance`
        const val1 = store.get(quoteKey)
        const val2 = store.get(fallbackQuoteKey)

        baseline = new Decimal(val1 !== undefined && val1 !== null ? val1 : (val2 !== undefined && val2 !== null ? val2 : 0))
        // TODO: DECIMAL_BRIDGE
        store.put('strategy_baseline_equity', baseline.toNumber())
    }

    const existingPeak = store.get('peak_equity_curve')
    if (existingPeak === undefined || existingPeak === null) {
        // TODO: DECIMAL_BRIDGE
        store.put('peak_equity_curve', baseline.toNumber())
    }

    const liqValue = store.get('initial_liquidation_value')
    if (liqValue === undefined || liqValue === null) {
        const baseRaw = store.get(`initial_${MARKET1.toLowerCase()}_balance`)
        const base = new Decimal(baseRaw !== undefined && baseRaw !== null ? baseRaw : 0)
        const dFallback = new Decimal(fallbackPrice || 0)
        // TODO: DECIMAL_BRIDGE
        store.put('initial_liquidation_value', baseline.plus(base.times(dFallback)).toNumber())
    }

    // TODO: DECIMAL_BRIDGE
    return baseline.toNumber()
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
    getTradingEquityCurve,
    updatePeakEquityCurve,
    getTradingDrawdown,
    checkTradingDrawdown,
    _logProfits,
    getLiquidationValue,
    reconcileBalances,
    resolveInitialBaseline,
    checkDailyLoss,
    _closeBot,
}
