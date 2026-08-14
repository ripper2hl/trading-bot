require('dotenv').config()
const Storage = require('node-storage')
const fs = require('fs')
const moment = require('moment')
const { log, logColor, logTrade, colors } = require('./utils/logger')
const client = require('./services/binance')
const { NotifyTelegram } = require('./services/TelegramNotify')

const MARKET1 = process.argv[2]
const MARKET2 = process.argv[3]
const MARKET = MARKET1 + MARKET2
const BUY_ORDER_AMOUNT = process.argv[4]

// === FLAGS DE PRODUCCION ===
const DRY_RUN = process.env.DRY_RUN === 'true' || process.env.DRY_RUN === '1'
const MAX_POSITION_PERCENT = parseFloat(process.env.MAX_POSITION_PERCENT || 5) // Max % del balance por orden
const DRAWDOWN_KILL_PERCENT = parseFloat(process.env.DRAWDOWN_KILL_PERCENT || 10) // Kill-switch si cae X% en 24h
const TRAILING_TP_PERCENT = parseFloat(process.env.TRAILING_TP_PERCENT || 0) // 0 = desactivado, venta estatica original

const store = new Storage(`./data/${MARKET}.json`)
const sleep = (timeMs) => new Promise(resolve => setTimeout(resolve, timeMs))

// Estado para el kill-switch de drawdown (se actualiza cada ciclo)
let drawdownKilled = false

/**
 * Exponential backoff: reintenta una funcion async con pausas crecientes ante errores de red/rate-limit
 * @param {Function} fn - Funcion async a ejecutar
 * @param {number} maxRetries - Maximo de reintentos (default 3)
 * @param {number} baseDelayMs - Delay base en ms (default 2000)
 */
async function withBackoff(fn, maxRetries = 3, baseDelayMs = 2000) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn()
        } catch (err) {
            const statusCode = err.code || err.statusCode || (err.response && err.response.status)
            const isRateLimit = statusCode === 429 || statusCode === 418
            const isNetworkError = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(err.code)

            if ((isRateLimit || isNetworkError) && attempt < maxRetries) {
                const delay = baseDelayMs * Math.pow(2, attempt)
                logColor(colors.yellow, `[BACKOFF] Reintento ${attempt + 1}/${maxRetries} en ${delay}ms (${isRateLimit ? 'Rate Limit 429' : err.code})`)
                await sleep(delay)
            } else {
                throw err
            }
        }
    }
}

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

async function _updateBalances() {
    const balances = await getBalances()
    store.put(`${MARKET1.toLowerCase()}_balance`, balances[MARKET1])
    store.put(`${MARKET2.toLowerCase()}_balance`, balances[MARKET2])
}

async function _calculateProfits() {
    const orders = store.get('orders')
    const sold = orders.filter(order => {
        return order.status === 'sold'
    })

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
    var isGainerProfit = profits > 0 ?
        1 : profits < 0 ? 2 : 0

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

async function getFees({ commission, commissionAsset }) {
    if (commissionAsset === MARKET2) return commission
    const price = await getPrice(MARKET)
    return price * commission
}

async function _buy(price, amount) {
    // === KILL-SWITCH: no operar si se activo el drawdown ===
    if (drawdownKilled) {
        logColor(colors.red, '[KILL-SWITCH] Bot detenido por drawdown. No se ejecutan compras.')
        return
    }

    const currentBalance = parseFloat(store.get(`${MARKET2.toLowerCase()}_balance`))

    // === LIMITE DE POSICION: nunca comprometer mas del X% del balance en una sola orden ===
    const maxAllowed = currentBalance * (MAX_POSITION_PERCENT / 100)
    if (parseFloat(BUY_ORDER_AMOUNT) > maxAllowed) {
        logColor(colors.yellow, `[POSICION] Orden de ${BUY_ORDER_AMOUNT} ${MARKET2} excede el ${MAX_POSITION_PERCENT}% del balance (${maxAllowed.toFixed(2)} ${MARKET2}). Orden bloqueada.`)
        return
    }

    if (currentBalance >= BUY_ORDER_AMOUNT) {
        var orders = store.get('orders')

        // Ajuste predictivo por comisiones: SELL_PERCENT representa la ganancia NETAL objetivo tras comisiones
        const feeRate = parseFloat(process.env.FEE_RATE || 0.001) // 0.1% tasa por defecto por operacion
        const targetNetPercent = parseFloat(process.env.SELL_PERCENT) / 100

        // Formula que garantiza ganancia neta target descontando comisiones de compra y venta
        const netMultiplier = (1 + targetNetPercent) / ((1 - feeRate) * (1 - feeRate))
        const targetSellPrice = price * netMultiplier
        var slFactor = parseFloat(process.env.STOP_LOSS_GRID || 0.6) * price / 100

        const order = {
            buy_price: price,
            sell_price: targetSellPrice,
            sl_price: price - slFactor,
            sold_price: 0,
            status: 'pending',
            profit: 0,
            buy_fee: 0,
            sell_fee: 0,
        }

        log(`
            Buying ${MARKET1} (Target Net Profit: ${process.env.SELL_PERCENT}%)
            ==================
            amountIn: ${parseFloat(BUY_ORDER_AMOUNT).toFixed(2)} ${MARKET2}
            amountOut: ${(BUY_ORDER_AMOUNT / price).toFixed(6)} ${MARKET1}
            Target Sell Price: ${targetSellPrice.toFixed(4)} ${MARKET2}
        `)

        const res = await marketBuy(amount, true)
        if (res && res.status === 'FILLED') {
            order.status = 'bought'
            order.id = res.orderId
            order.buy_fee = parseFloat((await getFees(res.fills[0])))
            order.amount = res.executedQty - res.fills[0].commission
            store.put('fees', parseFloat(store.get('fees')) + order.buy_fee)
            order.buy_price = parseFloat(res.fills[0].price)

            orders.push(order)
            store.put('start_price', order.buy_price)
            await _updateBalances()

            logColor(colors.green, '=============================')
            logColor(colors.green, `Bought ${order.amount} ${MARKET1} for ${parseFloat(BUY_ORDER_AMOUNT).toFixed(2)} ${MARKET2}, Price: ${order.buy_price}\n`)
            logColor(colors.green, '=============================')

            await _calculateProfits()

            _notifyTelegram(price, 'buy')
        } else {
            logColor(colors.red, '[ADVERTENCIA] La orden de compra no se completo o fallo en Binance.')
            _newPriceReset(2, BUY_ORDER_AMOUNT, price)
        }
    } else _newPriceReset(2, BUY_ORDER_AMOUNT, price)
}

function canNotifyTelegram(from) {
    return process.env.NOTIFY_TELEGRAM_ON.includes(from)
}

function _notifyTelegram(price, from) {
    moment.locale('es')
    if (process.env.NOTIFY_TELEGRAM
        && canNotifyTelegram(from))
        NotifyTelegram({
            runningTime: elapsedTime(),
            market: MARKET,
            market1: MARKET1,
            market2: MARKET2,
            price: price,
            balance1: store.get(`${MARKET1.toLowerCase()}_balance`),
            balance2: store.get(`${MARKET2.toLowerCase()}_balance`),
            gridProfits: parseFloat(store.get('profits')).toFixed(4),
            realProfits: getRealProfits(price),
            start: moment(store.get('start_time')).format('DD/MM/YYYY HH:mm'),
            from
        })
}

async function marketBuy(amount, quoted) {
    return await marketOrder('BUY', amount, quoted)
}

async function marketOrder(side, amount, quoted) {
    const orderObject = {
        symbol: MARKET,
        side: side,
        type: 'MARKET',
    }

    if (quoted)
        orderObject['quoteOrderQty'] = amount
    else
        orderObject['quantity'] = amount

    // === DRY-RUN: simula la orden sin ejecutarla, pero actualiza el estado local ===
    if (DRY_RUN) {
        const simPrice = await getPrice(MARKET)
        if (!simPrice) return null

        const feeRate = parseFloat(process.env.FEE_RATE || 0.001)
        const simQty = quoted ? (amount / simPrice) : amount
        const simCommission = side === 'BUY'
            ? simQty * feeRate           // Comision en MARKET1 al comprar
            : simQty * simPrice * feeRate // Comision en MARKET2 al vender
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
        return simResult
    }

    try {
        // Ejecutar con exponential backoff ante rate-limits o errores de red
        const res = await withBackoff(() => client.order(orderObject))

        // Log estructurado de la operacion real
        if (res && res.status === 'FILLED') {
            logTrade(side, {
                symbol: MARKET,
                quantity: res.executedQty,
                price: res.fills[0].price,
                orderId: res.orderId,
                commission: res.fills[0].commission,
                commissionAsset: res.fills[0].commissionAsset
            })
        }

        return res
    } catch (err) {
        logColor(colors.red, `[ERROR BINANCE API] Fallo al ejecutar orden ${side} de ${amount} en ${MARKET}: ${err.message || err}`)

        // Verificar si la orden se ejecuto a pesar del error de red (previene duplicados)
        try {
            logColor(colors.yellow, '[VERIFICACION] Consultando ordenes recientes para evitar duplicados...')
            const openOrders = await client.allOrders({ symbol: MARKET, limit: 5 })
            const recentFilled = openOrders.find(o =>
                o.side === side && o.status === 'FILLED' &&
                (Date.now() - o.time) < 30000 // Ordenes de los ultimos 30 segundos
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

async function marketSell(amount) {
    return await marketOrder('SELL', amount)
}

async function clearStart() {
    await _closeBot()
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

function logFail() {
    logColor(colors.red, 'No se ha podido vender el saldo inicial.')
    logColor(colors.red, 'Debes venderlo manualmente en Binance.')
    process.exit()
}

async function _sellAll() {
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

async function _closeBot() {
    try {
        if (fs.existsSync(`./data/${MARKET}.json`)) {
            fs.unlinkSync(`./data/${MARKET}.json`)
        }
    } catch (ee) {
        logColor(colors.red, `[ERROR _closeBot] No se pudo eliminar el estado local: ${ee.message || ee}`)
    }
}

function getOrderId() {
    const fifoStrategy = process.env.STOP_LOSS_GRID_IS_FIFO
    const orders = store.get('orders')
    const index = fifoStrategy ? 0 : orders.length - 1

    return store.get('orders')[index].id
}

function getToSold(price, changeStatus) {
    const orders = store.get('orders')
    const toSold = []

    for (var i = 0; i < orders.length; i++) {
        var order = orders[i]

        // Condicion de Stop-Loss de Grid (sin cambios)
        const isStopLossHit = process.env.USE_STOP_LOSS_GRID
            && getOrderId() === order.id
            && store.get(`${MARKET2.toLowerCase()}_balance`) < BUY_ORDER_AMOUNT
            && price < order.sl_price

        if (isStopLossHit) {
            if (changeStatus) {
                order.sold_price = price
                order.status = 'selling'
            }
            toSold.push(order)
            continue
        }

        // === TRAILING TAKE-PROFIT ===
        if (price >= order.sell_price) {
            if (TRAILING_TP_PERCENT > 0) {
                // Activar o actualizar el pico maximo alcanzado para esta orden
                if (!order.peak_price || price > order.peak_price) {
                    order.peak_price = price
                }

                // Calcular retroceso desde el pico
                const retrace = ((order.peak_price - price) / order.peak_price) * 100

                if (retrace >= TRAILING_TP_PERCENT) {
                    // El precio retrocedio lo suficiente desde el pico: VENDER
                    if (changeStatus) {
                        order.sold_price = price
                        order.status = 'selling'
                    }
                    toSold.push(order)
                }
                // Si no ha retrocedido lo suficiente, seguimos rastreando el pico
            } else {
                // Modo clasico: venta estatica inmediata al cruzar sell_price
                if (changeStatus) {
                    order.sold_price = price
                    order.status = 'selling'
                }
                toSold.push(order)
            }
        } else if (order.peak_price) {
            // El precio cayo por debajo del sell_price despues de haber estado en trailing
            // Resetear el pico para evitar venta prematura si vuelve a subir
            delete order.peak_price
        }
    }

    return toSold
}

async function _sell(price) {
    const orders = store.get('orders')
    const toSold = getToSold(price, true)

    if (toSold.length > 0) {
        var totalAmount = parseFloat(toSold.map(order => order.amount).reduce((prev, next) => parseFloat(prev) + parseFloat(next)))
        
        // Barrido de polvo LIMITADO: solo barrer si el exceso es una fraccion minuscula (< 1%)
        // Esto protege capital externo al bot que pueda estar en la misma cuenta
        let availableBalance = 0
        try {
            const balances = await getBalances()
            availableBalance = balances[MARKET1] || 0
        } catch (e) {
            availableBalance = parseFloat(store.get(`${MARKET1.toLowerCase()}_balance`)) || 0
        }

        let amountToSell = totalAmount
        const dustExcess = availableBalance - totalAmount
        const dustThreshold = totalAmount * 0.01 // 1% del monto de ordenes
        if (dustExcess > 0 && dustExcess <= dustThreshold) {
            // El exceso es polvo real del bot (fracciones de redondeo), lo incluimos
            amountToSell = availableBalance
            logColor(colors.gray, `[DUST] Barriendo polvo: +${dustExcess.toFixed(8)} ${MARKET1}`)
        } else if (availableBalance < totalAmount && availableBalance > 0) {
            // No hay suficiente saldo, vendemos lo que haya
            amountToSell = availableBalance
        }
        // Si dustExcess > dustThreshold, hay capital externo al bot: NO tocarlo

        if (amountToSell > 0) {
            log(`
                Selling ${MARKET1} (Incluye barrido de polvo acumulado)
                =================
                amountIn: ${amountToSell.toFixed(6)} ${MARKET1}
                amountOut: ${parseFloat(amountToSell * price).toFixed(2)} ${MARKET2}
            `)

            const lotQuantity = await getQuantity(amountToSell)
            if (parseFloat(lotQuantity) <= 0) {
                logColor(colors.red, '[ADVERTENCIA] Cantidad a vender por debajo del tamanho de lote permitido.')
                return false
            }

            const res = await marketSell(lotQuantity)
            if (res && res.status === 'FILLED') {
                const _price = parseFloat(res.fills[0].price)

                for (var i = 0; i < orders.length; i++) {
                    var order = orders[i]
                    for (var j = 0; j < toSold.length; j++) {
                        if (order.id == toSold[j].id) {
                            toSold[j].profit = (parseFloat(toSold[j].amount) * _price)
                                - (parseFloat(toSold[j].amount) * parseFloat(toSold[j].buy_price))

                            toSold[j].sell_fee = parseFloat((await getFees(res.fills[0])))
                            toSold[j].profit -= (toSold[j].sell_fee + toSold[j].buy_fee)
                            toSold[j].status = 'sold'
                            orders[i] = toSold[j]
                            store.put('fees', parseFloat(store.get('fees')) + orders[i].sell_fee)
                            store.put('sl_losses', parseFloat(store.get('sl_losses')) + orders[i].profit)
                        }
                    }
                }

                store.put('start_price', _price)
                await _updateBalances()

                logColor(colors.red, '=============================')
                logColor(colors.red,
                    `Sold ${amountToSell.toFixed(6)} ${MARKET1} for ${parseFloat(amountToSell * _price).toFixed(2)} ${MARKET2}, Price: ${_price}\n`)
                logColor(colors.red, '=============================')

                await _calculateProfits()

                var i = orders.length
                while (i--)
                    if (orders[i].status === 'sold')
                        orders.splice(i, 1)

                _notifyTelegram(price, 'sell')
            } else {
                logColor(colors.red, '[ADVERTENCIA] La venta no pudo completarse en Binance.')
                store.put('start_price', price)
            }
        } else store.put('start_price', price)
    }

    return toSold.length > 0
}

async function broadcast() {
    while (true) {
        try {
            const mPrice = await getPrice(MARKET)
            if (mPrice) {
                const startPrice = store.get('start_price')
                const marketPrice = mPrice

                console.clear()
                if (DRY_RUN) logColor(colors.yellow, '>>> MODO DRY-RUN ACTIVO (sin ordenes reales) <<<')
                log(`Running Time: ${elapsedTime()}`)
                log('===========================================================')
                const totalProfits = getRealProfits(marketPrice)

                // === KILL-SWITCH DE DRAWDOWN 24h ===
                const elapsedMs = Date.now() - store.get('start_time')
                const within24h = elapsedMs <= 86400000
                if (within24h && !isNaN(totalProfits)) {
                    const initialBal = parseFloat(store.get(`initial_${MARKET2.toLowerCase()}_balance`))
                    const drawdownPercent = parseFloat((-100 * totalProfits / initialBal).toFixed(3))
                    if (drawdownPercent >= DRAWDOWN_KILL_PERCENT && !drawdownKilled) {
                        drawdownKilled = true
                        logColor(colors.red, `[KILL-SWITCH] Drawdown de ${drawdownPercent}% en 24h supera el limite de ${DRAWDOWN_KILL_PERCENT}%. Deteniendo operaciones.`)
                        logColor(colors.red, '[KILL-SWITCH] Se requiere intervencion manual para reanudar.')
                        _notifyTelegram(marketPrice, 'sell') // Notificar alerta critica
                    }
                }

                if (!isNaN(totalProfits)) {
                    const totalProfitsPercent = parseFloat(
                        100 * totalProfits / store.get(`initial_${MARKET2.toLowerCase()}_balance`)
                    ).toFixed(3)
                    log(`Withdrawal profits: ${parseFloat(store.get('withdrawal_profits')).toFixed(2)} ${MARKET2}`)
                    logColor(totalProfits < 0 ? colors.red : totalProfits == 0 ? colors.gray : colors.green,
                        `Real Profits [SL = ${process.env.STOP_LOSS_BOT}%, TP = ${process.env.TAKE_PROFIT_BOT}%]: ${totalProfitsPercent}% ==> ${totalProfits <= 0 ? '' : '+'}${parseFloat(totalProfits).toFixed(3)} ${MARKET2}`)

                    if (totalProfitsPercent >= parseFloat(process.env.TAKE_PROFIT_BOT)) {
                        logColor(colors.green, 'Cerrando bot en ganancias....')
                        if (process.env.SELL_ALL_ON_CLOSE) {
                            if (process.env.WITHDRAW_PROFITS
                                && totalProfits >= parseFloat(process.env.MIN_WITHDRAW_AMOUNT)) {
                                await withdraw(totalProfits, marketPrice)
                                if (process.env.START_AGAIN) {
                                    await sleep(5000)
                                    await _updateBalances()
                                } else {
                                    await _closeBot()
                                    return
                                }
                            } else {
                                await _sellAll()
                                await _closeBot()

                                return
                            }
                        } else {
                            return
                        }
                    } else if (totalProfitsPercent <= -1 * process.env.STOP_LOSS_BOT) {
                        logColor(colors.red, 'Cerrando bot en pérdidas....')
                        if (process.env.SELL_ALL_ON_CLOSE)
                            await _sellAll()
                        await _closeBot()
                        return
                    }
                }

                _logProfits(marketPrice)
                const entryPrice = store.get('entry_price')
                const entryFactor = (marketPrice - entryPrice)
                const entryPercent = parseFloat(100 * entryFactor / entryPrice).toFixed(2)
                log(`Entry price: ${store.get('entry_price')} ${MARKET2} (${entryPercent <= 0 ? '' : '+'}${entryPercent}%)`)
                log('===========================================================')

                log(`Prev price: ${startPrice} ${MARKET2}`)

                if (marketPrice < startPrice) {
                    var factor = (startPrice - marketPrice)
                    var percent = parseFloat(100 * factor / startPrice).toFixed(2)

                    logColor(colors.red,
                        `New price: ${marketPrice} ${MARKET2} ==> -${parseFloat(percent).toFixed(3)}%`)
                    store.put('percent', `-${parseFloat(percent).toFixed(3)}`)

                    if (percent >= process.env.BUY_PERCENT)
                        await _buy(marketPrice, BUY_ORDER_AMOUNT)
                } else {
                    const factor = (marketPrice - startPrice)
                    const percent = 100 * factor / marketPrice

                    logColor(colors.green,
                        `New price: ${marketPrice} ${MARKET2} ==> +${parseFloat(percent).toFixed(3)}%`)
                    store.put('percent', `+${parseFloat(percent).toFixed(3)}`)

                    const toSold = getToSold(marketPrice)
                    if (toSold.length === 0)
                        store.put('start_price', marketPrice)
                }

                await _sell(marketPrice)

                const orders = store.get('orders')
                if (orders.length > 0) {
                    const bOrder = orders[orders.length - 1]
                    console.log()
                    log('Last buy order')
                    console.log('==========================')
                    log(`Buy price: ${bOrder.buy_price} ${MARKET2}`)
                    log(`Sell price: ${bOrder.sell_price} ${MARKET2}`)

                    if (process.env.USE_STOP_LOSS_GRID) {
                        const slStrategy = process.env.STOP_LOSS_GRID_IS_FIFO ? 'FIFO' : 'LIFO'
                        log(`SL price: ${bOrder.sl_price} ${MARKET2}, Strategy: ${slStrategy}`)
                        log(`SL losses: ${parseFloat(store.get('sl_losses')).toFixed(3)}, Trigger price down: ${process.env.STOP_LOSS_GRID}%`)
                    }

                    log(`Order amount: ${BUY_ORDER_AMOUNT} ${MARKET2} ==> ${bOrder.amount} ${MARKET1}`)

                    const expectedProfits = parseFloat((bOrder.amount * bOrder.sell_price - bOrder.amount * bOrder.buy_price) - bOrder.buy_fee).toFixed(3)
                    if (expectedProfits >= 0)
                        logColor(colors.green, `Expected profit: +${expectedProfits} ${MARKET2}`)
                    else
                        logColor(colors.red, `Expected profit: ${expectedProfits} ${MARKET2}`)

                    if (TRAILING_TP_PERCENT > 0) {
                        if (bOrder.peak_price) {
                            const currentRetrace = ((bOrder.peak_price - marketPrice) / bOrder.peak_price * 100).toFixed(3)
                            logColor(colors.yellow, `Trailing TP: Peak ${bOrder.peak_price} ${MARKET2}, Retrace: ${currentRetrace}% / ${TRAILING_TP_PERCENT}%`)
                        } else {
                            log(`Trailing TP: Esperando cruce de sell_price (${bOrder.sell_price.toFixed(4)} ${MARKET2})`)
                        }
                    }

                    console.log('==========================')
                }
            }
        } catch (err) {
            logColor(colors.red, `[ERROR BROADCAST] Error en el ciclo del bot: ${err.message || err}`)
            try {
                await _updateBalances()
            } catch (syncErr) {
                logColor(colors.red, `[ERROR SYNC] No se pudo resincronizar saldos: ${syncErr.message || syncErr}`)
            }
        }
        await sleep(process.env.SLEEP_TIME)
    }
}


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
    let quantity = (amount / stepSize).toFixed(symbols[0].baseAssetPrecision)

    if (amount % stepSize !== 0) {
        quantity = (parseInt(quantity) * stepSize).toFixed(symbols[0].baseAssetPrecision)
    }

    return quantity
}

async function getMinBuy() {
    const { symbols } = await client.exchangeInfo({ symbol: MARKET })
    const { minNotional } = symbols[0].filters.find(filter => filter.filterType === 'NOTIONAL')

    return parseFloat(minNotional)
}

async function withdraw(profits, price) {
    await _sellAll()
    console.log('Procesando retiro...')
    await sleep(process.env.SLEEP_TIME * 2)

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
    await sleep(process.env.SLEEP_TIME * 2)
    _notifyTelegram(price, 'withdraw')
}

async function init() {
    const minBuy = await getMinBuy()
    if (minBuy > BUY_ORDER_AMOUNT) {
        console.log(`El lote mínimo de compra es: ${minBuy} ${MARKET2}`)
        return
    }

    if (process.argv[5] !== 'resume') {
        log('Iniciando bot...')
        if (process.env.SELL_ALL_ON_START)
            await clearStart()
        const startTime = Date.now()
        store.put('start_time', startTime)
        const price = await getPrice(MARKET)
        store.put('start_price', price)
        store.put('orders', [])
        store.put('profits', 0)
        store.put('sl_losses', 0)
        store.put('withdrawal_profits', 0)
        store.put('fees', 0)
        const balances = await getBalances()
        store.put('entry_price', price)
        store.put(`${MARKET1.toLowerCase()}_balance`, balances[MARKET1])
        store.put(`${MARKET2.toLowerCase()}_balance`, balances[MARKET2])
        store.put(`initial_${MARKET1.toLowerCase()}_balance`, store.get(`${MARKET1.toLowerCase()}_balance`))
        store.put(`initial_${MARKET2.toLowerCase()}_balance`, store.get(`${MARKET2.toLowerCase()}_balance`))
    }

    broadcast()
}

init()