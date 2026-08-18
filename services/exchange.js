/**
 * services/exchange.js
 * Funciones de interaccion con la API de Binance.
 * Encapsula ordenes, consultas de precio, saldos y cantidades.
 */
const client = require('./binance')
const Decimal = require('../utils/decimal')
const {
    MARKET, MARKET1, MARKET2, DRY_RUN, FEE_RATE,
    DEFAULT_WITHDRAW_NETWORK, WITHDRAW_ADDRESS_BUSD, WITHDRAW_ADDRESS_USDT, POLL_INTERVAL_MS
} = require('../config/constants')
const { log, logColor, logTrade, colors } = require('../utils/logger')
const { withBackoff } = require('../utils/network')
const { store, elapsedTime } = require('./state')
const { NotifyTelegram } = require('./TelegramNotify')
const { logIntent, updateIntent } = require('./ledger')

// === ORDENES ===

function generateClientOrderId(side) {
    const marker = `${MARKET}-${side}`
    const timePart = Date.now().toString(36)
    const randomPart = Math.random().toString(36).slice(2, 8)
    return `${marker}-${timePart}-${randomPart}`.slice(0, 36)
}

async function marketBuy(amount, quoted) {
    return await marketOrder('BUY', amount, quoted)
}

async function marketSell(amount) {
    return await marketOrder('SELL', amount)
}

async function marketOrder(side, amount, quoted) {
    const orderObject = {
        symbol: MARKET,
        side: side,
        type: 'MARKET',
        newClientOrderId: generateClientOrderId(side),
    }

    if (quoted)
        orderObject['quoteOrderQty'] = amount
    else
        orderObject['quantity'] = amount

    logIntent(orderObject)

    // === DRY-RUN: simula la orden sin ejecutarla, pero actualiza el estado local ===
    if (DRY_RUN) {
        const simPrice = await getPrice(MARKET)
        if (!simPrice) return null
        const dAmount = new Decimal(amount)
        const dSimPrice = new Decimal(simPrice)
        const dFeeRate = new Decimal(FEE_RATE)

        const dSimQty = quoted ? dAmount.dividedBy(dSimPrice) : dAmount
        const simQty = dSimQty.toNumber()

        const dSimCommission = side === 'BUY'
            ? dSimQty.times(dFeeRate)
            : dSimQty.times(dSimPrice).times(dFeeRate)
        const simCommission = dSimCommission.toNumber()
        const commissionAsset = side === 'BUY' ? MARKET1 : MARKET2

        const simResult = {
            symbol: MARKET,
            orderId: `DRY_${Date.now()}`,
            status: 'FILLED',
            executedQty: simQty,
            fills: [{
                price: String(simPrice),
                commission: String(simCommission),
                commissionAsset: commissionAsset
            }]
        }

        // Actualizar saldos locales simulados para mantener coherencia del grid
        const m1Key = `${MARKET1.toLowerCase()}_balance`
        const m2Key = `${MARKET2.toLowerCase()}_balance`

        const curM1 = new Decimal(store.get(m1Key) || 0)
        const curM2 = new Decimal(store.get(m2Key) || 0)

        if (side === 'BUY') {
            // TODO: DECIMAL_BRIDGE (state.js store balances require Number right now)
            store.put(m1Key, curM1.plus(dSimQty).minus(dSimCommission).toNumber())
            store.put(m2Key, curM2.minus(dSimQty.times(dSimPrice)).toNumber())
        } else {
            // TODO: DECIMAL_BRIDGE (state.js store balances require Number right now)
            store.put(m1Key, curM1.minus(dSimQty).toNumber())
            store.put(m2Key, curM2.plus(dSimQty.times(dSimPrice)).minus(dSimCommission).toNumber())
        }

        logTrade(`DRY_RUN_${side}`, { symbol: MARKET, quantity: simQty, price: simPrice, orderId: simResult.orderId, fee: simCommission })
        logColor(colors.yellow, `[DRY-RUN] Orden ${side} simulada: ${simQty.toFixed(6)} ${MARKET1} @ ${simPrice} ${MARKET2} (fee: ${simCommission.toFixed(6)} ${commissionAsset})`)
        updateIntent(orderObject.newClientOrderId, 'CONFIRMED', simPrice, simCommission, simResult.executedQty, commissionAsset, simResult.orderId)
        return simResult
    }

    try {
        const res = await withBackoff(() => client.order(orderObject))

        if (res && res.status === 'PARTIALLY_FILLED') {
            // TODO: DECIMAL_BRIDGE (usado para logs o recovery expecting number/null)
            const partialPrice = res.fills && res.fills[0] ? new Decimal(res.fills[0].price).toNumber() : null

            logColor(colors.red, `[RISK] Partial Fill detectado en ${MARKET} (${side}). Orden ${res.orderId} parcialmente ejecutada. Se cancela el remanente y se detiene la ejecución.`)
            try {
                await client.cancelOrder({ symbol: MARKET, orderId: res.orderId })
                logColor(colors.yellow, `[RISK] Orden parcial cancelada: ${res.orderId}`)
            } catch (cancelErr) {
                logColor(colors.red, `[RISK] No se pudo cancelar la orden parcial ${res.orderId}: ${cancelErr.message || cancelErr}`)
            }

            try {
                const currentPrice = partialPrice || await getPrice(MARKET)
                await NotifyTelegram({
                    runningTime: elapsedTime(),
                    market: MARKET,
                    market1: MARKET1,
                    market2: MARKET2,
                    price: currentPrice,
                    balance1: store.get(`${MARKET1.toLowerCase()}_balance`),
                    balance2: store.get(`${MARKET2.toLowerCase()}_balance`),
                    gridProfits: parseFloat(store.get('profits') || 0).toFixed(4),
                    realProfits: parseFloat(store.get('profits') || 0).toFixed(4),
                    start: new Date(store.get('start_time') || Date.now()).toISOString(),
                    from: 'risk'
                })
            } catch (notifyErr) {
                logColor(colors.red, `[RISK] No se pudo enviar la alarma de Partial Fill: ${notifyErr.message || notifyErr}`)
            }

            try {
                await client.cancelOpenOrders({ symbol: MARKET })
                logColor(colors.yellow, `[RISK] Cuarentena activada: órdenes abiertas de ${MARKET} canceladas antes del exit.`)
            } catch (cancelErr) {
                logColor(colors.red, `[RISK] No se pudieron cancelar las órdenes abiertas antes del exit: ${cancelErr.message || cancelErr}`)
            }

            process.exit(1)
        }

        if (res && res.status === 'FILLED') {
            // TODO: DECIMAL_BRIDGE (intent db expect number/null)
            const executedPrice = res.fills && res.fills.length > 0 ? new Decimal(res.fills[0].price).toNumber() : null
            const executedFee = res.fills && res.fills.length > 0 ? new Decimal(res.fills[0].commission).toNumber() : null
            const commissionAsset = res.fills && res.fills.length > 0 ? res.fills[0].commissionAsset : null

            updateIntent(orderObject.newClientOrderId, 'CONFIRMED', executedPrice, executedFee, res.executedQty, commissionAsset, res.orderId)
            logTrade(side, {
                symbol: MARKET,
                quantity: res.executedQty,
                price: res.fills[0].price,
                orderId: res.orderId,
                commission: res.fills[0].commission,
                commissionAsset: res.fills[0].commissionAsset
            })
        }

        if (res && res.status === 'REJECTED') {
            updateIntent(orderObject.newClientOrderId, 'FAILED')
        }

        return res
    } catch (err) {
        logColor(colors.red, `[ERROR BINANCE API] Fallo al ejecutar orden ${side} de ${amount} en ${MARKET}: ${err.message || err}`)

        // Verificar si la orden se ejecuto a pesar del error de red (previene duplicados)
        try {
            logColor(colors.yellow, '[VERIFICACION] Consultando ordenes recientes para evitar duplicados...')
            const openOrders = await client.allOrders({ symbol: MARKET, limit: 5 })
            const recentFilled = openOrders.find(o =>
                o.clientOrderId === orderObject.newClientOrderId
            )
            if (recentFilled) {
                logColor(colors.yellow, `[VERIFICACION] Orden ${recentFilled.orderId} SI se ejecuto. Usando resultado existente.`)
                return recentFilled
            }
        } catch (verifyErr) {
            logColor(colors.red, `[VERIFICACION] No se pudo verificar: ${verifyErr.message}`)
        }

        return null
    }
}

// === CONSULTAS ===

const getBalances = async () => {
    try {
        const assets = [MARKET1, MARKET2]
        const accountInfo = await withBackoff(() => client.accountInfo())
        if (!accountInfo || !accountInfo.balances) return { [MARKET1]: 0, [MARKET2]: 0 }
        const _balances = accountInfo.balances.filter(coin => assets.includes(coin.asset))
        var parsedBalances = {}
        assets.forEach(asset => {
            const found = _balances.find(coin => coin.asset === asset)
            // TODO: DECIMAL_BRIDGE (state.js expects number map from this function right now)
            parsedBalances[asset] = found ? new Decimal(found.free).toNumber() : 0
        })
        return parsedBalances
    } catch (err) {
        logColor(colors.red, `[ERROR getBalances] ${err.message || err}`)
        throw err
    }
}

const getPrice = async (symbol) => {
    if (!symbol || typeof symbol !== 'string' || !/^[A-Za-z0-9\-._]+$/.test(symbol)) {
        return null
    }

    try {
        const prices = await withBackoff(() => client.prices({ symbol }))
        if (prices && prices[symbol]) {
            if (isNaN(parseFloat(prices[symbol]))) return NaN
            // TODO: DECIMAL_BRIDGE (all downstream tradingEngine expects a Number right now)
            return new Decimal(prices[symbol]).toNumber()
        }
        return null
    } catch (err) {
        logColor(colors.red, `[ERROR getPrice] ${err.message || err}`)
        return null
    }
}

const getPriceTick = async (symbol) => {
    if (!symbol || typeof symbol !== 'string' || !/^[A-Za-z0-9\-._]+$/.test(symbol)) {
        return null
    }

    try {
        const startTime = Date.now()
        const prices = await withBackoff(() => client.prices({ symbol }))
        const fetchLatency = Date.now() - startTime
        if (prices && prices[symbol]) {
            if (isNaN(parseFloat(prices[symbol]))) return { price: NaN, timestamp: startTime, latency: fetchLatency }
            return {
                // TODO: DECIMAL_BRIDGE (downstream expects number)
                price: new Decimal(prices[symbol]).toNumber(),
                timestamp: startTime,
                latency: fetchLatency
            }
        }
        return null
    } catch (err) {
        logColor(colors.red, `[ERROR getPriceTick] ${err.message || err}`)
        return null
    }
}

const getQuantity = async (amount) => {
    let dAmount;
    try {
        dAmount = new Decimal(amount)
        if (!dAmount.isFinite() || dAmount.lessThanOrEqualTo(0)) throw new Error()
    } catch (e) {
        throw new Error(`[RISK] Cantidad inválida para getQuantity: ${amount}`)
    }

    const { symbols } = await client.exchangeInfo({ symbol: MARKET })
    const { stepSize } = symbols[0].filters.find(filter => filter.filterType === 'LOT_SIZE')

    let dStepSize;
    try {
        dStepSize = new Decimal(stepSize)
        if (!dStepSize.isFinite() || dStepSize.lessThanOrEqualTo(0)) throw new Error()
    } catch (e) {
        throw new Error(`[RISK] stepSize inválido obtenido de Binance: ${stepSize}`)
    }

    const precision = symbols[0].baseAssetPrecision

    const steps = dAmount.dividedBy(dStepSize).floor()
    const safeQuantity = steps.times(dStepSize)

    return safeQuantity.toFixed(precision, Decimal.ROUND_DOWN)
}

async function getMinBuy() {
    const { symbols } = await client.exchangeInfo({ symbol: MARKET })
    const { minNotional } = symbols[0].filters.find(filter => filter.filterType === 'NOTIONAL')

    // TODO: DECIMAL_BRIDGE (downstream clearStart expects Number)
    return new Decimal(minNotional).toNumber()
}

async function getFees({ commission, commissionAsset }) {
    let dCommission;
    try {
        dCommission = new Decimal(commission)
        if (!dCommission.isFinite()) throw new Error()
    } catch (e) {
        throw new Error(`[RISK] Comisión inválida para cálculo de fees: ${commission}`)
    }

    if (commissionAsset === MARKET2) return dCommission

    if (commissionAsset === 'BNB') {
        const pair = MARKET2 ? `BNB${MARKET2}` : 'BNBUSDT'
        const bnbPrice = await getPrice(pair) // already converted to number downstream
        if (bnbPrice !== null && !isNaN(bnbPrice)) {
            const dBnbPrice = new Decimal(bnbPrice)
            if (dBnbPrice.greaterThan(0)) {
                return dCommission.times(dBnbPrice)
            }
        }
        return dCommission
    }

    const price = await getPrice(MARKET)
    if (price === undefined || price === null || isNaN(price)) {
        throw new Error(`[RISK] Precio inválido para cálculo de fee en base asset: ${price}`)
    }

    const dPrice = new Decimal(price)
    return dCommission.times(dPrice)
}

async function withdraw(profits, price) {
    const { sleep } = require('../utils/network')

    await _sellAll()
    console.log('Procesando retiro...')
    await sleep(POLL_INTERVAL_MS * 2)

    await client.withdraw({
        coin: MARKET2,
        network: DEFAULT_WITHDRAW_NETWORK,
        address: MARKET2 === 'BUSD'
            ? WITHDRAW_ADDRESS_BUSD
            : WITHDRAW_ADDRESS_USDT,
        amount: profits,
    })

    store.put('withdrawal_profits', parseFloat(store.get('withdrawal_profits')) + profits)
    console.log('Cerrando bot...')
    await sleep(POLL_INTERVAL_MS * 2)
}

// === OPERACIONES DE CICLO DE VIDA ===

function logFail() {
    logColor(colors.red, 'No se ha podido vender el saldo inicial.')
    logColor(colors.red, 'Debes venderlo manualmente en Binance.')
    process.exit()
}

async function clearStart(closeBot) {
    const { sleep } = require('../utils/network')

    closeBot()
    const balances = await getBalances()
    const totalAmount = balances[MARKET1]
    const price = await getPrice(MARKET)

    if (price === undefined || price === null || isNaN(price) || price <= 0) {
        logColor(colors.red, `[ERROR clearStart] Precio inválido o cero: ${price}. Abortando sweep.`)
        return logFail()
    }
    if (totalAmount === undefined || totalAmount === null || isNaN(totalAmount)) {
        logColor(colors.red, `[ERROR clearStart] Balance inválido: ${totalAmount}. Abortando sweep.`)
        return logFail()
    }

    const minBuy = await getMinBuy()
    if (minBuy === undefined || minBuy === null || isNaN(minBuy)) {
        logColor(colors.red, `[ERROR clearStart] MinBuy inválido: ${minBuy}. Abortando sweep.`)
        return logFail()
    }

    const minSell = new Decimal(minBuy).dividedBy(new Decimal(price))

    if (new Decimal(totalAmount).greaterThanOrEqualTo(minSell)) {
        try {
            const lotQuantity = await getQuantity(totalAmount)
            const res = await marketSell(lotQuantity)
            if (res && res.status === 'FILLED') {
                logColor(colors.green, 'Iniciando en modo limpio...')
                await sleep(3000)
            } else {
                logFail()
            }
        } catch (err) {
            logColor(colors.red, `[ERROR clearStart] ${err.message || err}`)
            logFail()
        }
    }
}

async function _sellAll() {
    const { sleep } = require('../utils/network')

    await sleep(3000)
    try {
        const balances = await getBalances()
        const totalAmount = balances[MARKET1]

        if (totalAmount === undefined || totalAmount === null || isNaN(totalAmount)) {
            logColor(colors.red, `[ERROR _sellAll] Balance inválido: ${totalAmount}. Abortando sweep.`)
            return
        }

        if (totalAmount > 0) {
            const lotQuantity = await getQuantity(totalAmount)
            if (lotQuantity === undefined || lotQuantity === null || isNaN(parseFloat(lotQuantity))) {
                logColor(colors.red, `[ERROR _sellAll] lotQuantity inválido: ${lotQuantity}. Abortando sweep.`)
                return
            }
            if (new Decimal(lotQuantity).greaterThan(0)) {
                const res = await marketSell(lotQuantity)
                if (res && res.status === 'FILLED') {
                    logColor(colors.green, 'Bot detenido correctamente: Todo vendido')
                } else {
                    logFail()
                }
            }
        }
    } catch (err) {
        logColor(colors.red, `[ERROR _sellAll] No se pudo vender la totalidad de las monedas: ${err.message || err}`)
    }
}

async function getKlines(symbol, interval, limit) {
    const klines = await withBackoff(() => client.getKlines(symbol, interval, limit))
    return klines
}

module.exports = {
    marketBuy,
    marketSell,
    getBalances,
    getPrice,
    getPriceTick,
    getQuantity,
    getMinBuy,
    getFees,
    clearStart,
    _sellAll,
    withdraw,
    getKlines,
    logFail
}
