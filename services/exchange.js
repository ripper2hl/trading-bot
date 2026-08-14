/**
 * services/exchange.js
 * Funciones de interaccion con la API de Binance.
 * Encapsula ordenes, consultas de precio, saldos y cantidades.
 */
const client = require('./binance')
const { MARKET, MARKET1, MARKET2, DRY_RUN, FEE_RATE } = require('../config/constants')
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

        const simQty = quoted ? (amount / simPrice) : amount
        const simCommission = side === 'BUY'
            ? simQty * FEE_RATE
            : simQty * simPrice * FEE_RATE
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
        const curM1 = parseFloat(store.get(m1Key)) || 0
        const curM2 = parseFloat(store.get(m2Key)) || 0

        if (side === 'BUY') {
            store.put(m1Key, curM1 + simQty - simCommission)
            store.put(m2Key, curM2 - (simQty * simPrice))
        } else {
            store.put(m1Key, curM1 - simQty)
            store.put(m2Key, curM2 + (simQty * simPrice) - simCommission)
        }

        logTrade(`DRY_RUN_${side}`, { symbol: MARKET, quantity: simQty, price: simPrice, orderId: simResult.orderId, fee: simCommission })
        logColor(colors.yellow, `[DRY-RUN] Orden ${side} simulada: ${simQty.toFixed(6)} ${MARKET1} @ ${simPrice} ${MARKET2} (fee: ${simCommission.toFixed(6)} ${commissionAsset})`)
        updateIntent(orderObject.newClientOrderId, 'CONFIRMED')
        return simResult
    }

    try {
        const res = await withBackoff(() => client.order(orderObject))

        if (res && res.status === 'PARTIALLY_FILLED') {
            const partialPrice = res.fills && res.fills[0] ? parseFloat(res.fills[0].price) : null
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

            process.exit(1)
        }

        if (res && res.status === 'FILLED') {
            updateIntent(orderObject.newClientOrderId, 'CONFIRMED')
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
            parsedBalances[asset] = found ? parseFloat(found.free) : 0
        })
        return parsedBalances
    } catch (err) {
        logColor(colors.red, `[ERROR getBalances] ${err.message || err}`)
        throw err
    }
}

const getPrice = async (symbol) => {
    try {
        const prices = await withBackoff(() => client.prices({ symbol }))
        if (prices && prices[symbol]) {
            return parseFloat(prices[symbol])
        }
        return null
    } catch (err) {
        logColor(colors.red, `[ERROR getPrice] ${err.message || err}`)
        return null
    }
}

const getQuantity = async (amount) => {
    const { symbols } = await client.exchangeInfo({ symbol: MARKET })
    const { stepSize } = symbols[0].filters.find(filter => filter.filterType === 'LOT_SIZE')
    const precision = symbols[0].baseAssetPrecision

    const steps = Math.floor(Number(amount) / Number(stepSize))
    const safeQuantity = Number(steps * Number(stepSize))
    return safeQuantity.toFixed(precision)
}

async function getMinBuy() {
    const { symbols } = await client.exchangeInfo({ symbol: MARKET })
    const { minNotional } = symbols[0].filters.find(filter => filter.filterType === 'NOTIONAL')
    return parseFloat(minNotional)
}

async function getFees({ commission, commissionAsset }) {
    if (commissionAsset === MARKET2) return commission
    const price = await getPrice(MARKET)
    return price * commission
}

async function withdraw(profits, price) {
    const { sleep } = require('../utils/network')
    const { SLEEP_TIME } = require('../config/constants')

    await _sellAll()
    console.log('Procesando retiro...')
    await sleep(SLEEP_TIME * 2)

    await client.withdraw({
        coin: MARKET2,
        network: process.env.DEFAULT_WITHDRAW_NETWORK,
        address: MARKET2 === 'BUSD'
            ? process.env.WITHDRAW_ADDRESS_BUSD
            : process.env.WITHDRAW_ADDRESS_USDT,
        amount: profits,
    })

    store.put('withdrawal_profits', parseFloat(store.get('withdrawal_profits')) + profits)
    console.log('Cerrando bot...')
    await sleep(SLEEP_TIME * 2)
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
    const minSell = (await getMinBuy()) / price
    if (totalAmount >= parseFloat(minSell)) {
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
        if (totalAmount > 0) {
            const lotQuantity = await getQuantity(totalAmount)
            if (parseFloat(lotQuantity) > 0) {
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

module.exports = {
    marketBuy,
    marketSell,
    getBalances,
    getPrice,
    getQuantity,
    getMinBuy,
    getFees,
    withdraw,
    clearStart,
    _sellAll,
    logFail,
}
