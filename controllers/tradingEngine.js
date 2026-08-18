/**
 * controllers/tradingEngine.js
 * Logica de trading: compra (con net-profit predictivo), venta (con dust sweep limitado),
 * evaluacion de ordenes (con trailing take-profit y stop-loss de grid).
 */
const {
    MARKET1, MARKET2, MARKET, BUY_ORDER_AMOUNT,
    MAX_CAPITAL_USDT,
    MAX_BTC_INVENTORY,
    SELL_PERCENT, MAX_POSITION_PERCENT, MAX_OPEN_GRID_ORDERS, FEE_RATE, TRAILING_TP_PERCENT,
    GRID_STOP_LOSS_ENABLED, GRID_STOP_LOSS_PERCENT, GRID_STOP_LOSS_FIFO
} = require('../config/constants')
const { log, logColor, colors } = require('../utils/logger')
const { Decimal } = require('decimal.js')
const { store, _newPriceReset, _calculateProfits } = require('../services/state')
const { marketBuy, marketSell, getBalances, getPrice, getQuantity, getFees, getMinBuy } = require('../services/exchange')
const { updateIntent } = require('../services/ledger')

// Estado mutable del kill-switch (persistido en store para sobrevivir reinicios)
let drawdownKilled = Boolean(store.get('drawdown_killed'))

function setDrawdownKilled(value) {
    drawdownKilled = Boolean(value)
    store.put('drawdown_killed', drawdownKilled)
}

function isDrawdownKilled() {
    const persistedValue = store.get('drawdown_killed')
    const parsedValue = persistedValue === true || persistedValue === 'true' || persistedValue === 1 || persistedValue === '1'
    drawdownKilled = parsedValue
    return drawdownKilled
}

// === EVALUACION DE ORDENES ===

function getOrderId() {
    const fifoStrategy = GRID_STOP_LOSS_FIFO
    const orders = store.get('orders')
    const index = fifoStrategy ? 0 : orders.length - 1
    return orders[index].id
}

function getToSold(price, changeStatus) {
    const orders = Array.isArray(store.get('orders')) ? store.get('orders') : []
    const toSold = []

    for (var i = 0; i < orders.length; i++) {
        var order = orders[i]

        const dPrice = new Decimal(price)
        const dSlPrice = new Decimal(order.sl_price)

        // Condicion de Stop-Loss de Grid
        const isStopLossHit = GRID_STOP_LOSS_ENABLED
            && getOrderId() === order.id
            && store.get(`${MARKET2.toLowerCase()}_balance`) < BUY_ORDER_AMOUNT
            && dPrice.lessThanOrEqualTo(dSlPrice)

        if (isStopLossHit) {
            if (changeStatus) {
                order.sold_price = price
                if (order.status !== 'BELOW_NOTIONAL') order.status = 'selling'
            }
            toSold.push(order)
            continue
        }

        const dSellPrice = new Decimal(order.sell_price)

        // === TRAILING TAKE-PROFIT ===
        if (dPrice.greaterThanOrEqualTo(dSellPrice)) {
            if (TRAILING_TP_PERCENT > 0) {
                if (!order.peak_price || dPrice.greaterThan(new Decimal(order.peak_price))) {
                    order.peak_price = dPrice.toNumber()
                }

                const dPeakPrice = new Decimal(order.peak_price)
                const dRetrace = dPeakPrice.minus(dPrice).dividedBy(dPeakPrice).times(100)
                const dTrailingTpPercent = new Decimal(TRAILING_TP_PERCENT)

                if (dRetrace.greaterThanOrEqualTo(dTrailingTpPercent)) {
                    if (changeStatus) {
                        order.sold_price = price
                        if (order.status !== 'BELOW_NOTIONAL') order.status = 'selling'
                    }
                    toSold.push(order)
                }
            } else {
                // Modo clasico: venta estatica
                if (changeStatus) {
                    order.sold_price = price
                    if (order.status !== 'BELOW_NOTIONAL') order.status = 'selling'
                }
                toSold.push(order)
            }
        } else if (order.peak_price) {
            delete order.peak_price
        }
    }

    return toSold
}

// === COMPRA ===

async function _buy(price, amount, updateBalancesFn, notifyFn) {
    if (drawdownKilled) {
        logColor(colors.red, '[KILL-SWITCH] Bot detenido por drawdown. No se ejecutan compras.')
        return
    }

    const orders = store.get('orders') || []
    const boughtOrders = orders.filter(order => order && order.status === 'bought')
    if (boughtOrders.length >= MAX_OPEN_GRID_ORDERS) {
        logColor(colors.yellow, `[GRID] Máximo de órdenes compradas activo alcanzado (${MAX_OPEN_GRID_ORDERS}). Compra bloqueada.`)
        return
    }

    const dCurrentBalance = new Decimal(store.get(`${MARKET2.toLowerCase()}_balance`) || 0)
    const totalExposure = boughtOrders.reduce((sum, order) => {
        const orderAmount = new Decimal(order.amount || 0)
        const orderPrice = new Decimal(order.buy_price || 0)
        return sum.plus(orderAmount.times(orderPrice))
    }, new Decimal(0))
    const currentInventory = boughtOrders.reduce((sum, order) => {
        const orderAmount = new Decimal(order.amount || 0)
        return sum.plus(orderAmount)
    }, new Decimal(0))

    const dMaxPositionPercent = new Decimal(MAX_POSITION_PERCENT)
    const maxAllowed = dCurrentBalance.times(dMaxPositionPercent).dividedBy(100)

    const dBuyOrderAmount = new Decimal(BUY_ORDER_AMOUNT)
    const dPrice = new Decimal(price)

    const projectedExposure = totalExposure.plus(dBuyOrderAmount)
    const projectedInventory = currentInventory.plus(dBuyOrderAmount.dividedBy(dPrice))

    if (MAX_CAPITAL_USDT > 0 && projectedExposure.greaterThan(MAX_CAPITAL_USDT)) {
        logColor(colors.yellow, `[RISK] Capital proyectado ${projectedExposure.toNumber().toFixed(2)} ${MARKET2} excedería MAX_CAPITAL_USDT (${MAX_CAPITAL_USDT}). Compra bloqueada.`)
        return
    }

    if (MAX_BTC_INVENTORY > 0 && projectedInventory.greaterThan(MAX_BTC_INVENTORY)) {
        logColor(colors.yellow, `[RISK] Inventario proyectado ${projectedInventory.toNumber().toFixed(6)} ${MARKET1} excedería MAX_BTC_INVENTORY (${MAX_BTC_INVENTORY}). Compra bloqueada.`)
        return
    }

    if (projectedExposure.greaterThan(maxAllowed)) {
        logColor(colors.yellow, `[POSICION] Exposicion proyectada ${projectedExposure.toNumber().toFixed(2)} ${MARKET2} excede el ${MAX_POSITION_PERCENT}% del balance (${maxAllowed.toNumber().toFixed(2)} ${MARKET2}). Orden bloqueada.`)
        return
    }

    if (dCurrentBalance.greaterThanOrEqualTo(dBuyOrderAmount)) {
        const activeOrders = store.get('orders') || []

        const dynamicSellPercent = store.get('dynamic_sell_percent') || SELL_PERCENT
        const dDynamicSellPercent = new Decimal(dynamicSellPercent)
        const dTargetNetPercent = dDynamicSellPercent.dividedBy(100)

        const dOne = new Decimal(1)
        const dFeeRate = new Decimal(FEE_RATE)
        const dFeeFactor = dOne.minus(dFeeRate)
        const dNetMultiplier = dOne.plus(dTargetNetPercent).dividedBy(dFeeFactor.times(dFeeFactor))

        const dPrice = new Decimal(price)
        const dTargetSellPrice = dPrice.times(dNetMultiplier)

        const dGridStopLossPercent = new Decimal(GRID_STOP_LOSS_PERCENT)
        const dSlFactor = dGridStopLossPercent.times(dPrice).dividedBy(100)
        const dSlPrice = dPrice.minus(dSlFactor)

        const order = {
            buy_price: price,
            sell_price: dTargetSellPrice.toNumber(),
            sl_price: dSlPrice.toNumber(),
            sold_price: 0,
            status: 'pending',
            profit: 0,
            buy_fee: 0,
            sell_fee: 0,
        }

        const dBuyOrderAmountLog = new Decimal(BUY_ORDER_AMOUNT)
        const dAmountOutLog = dBuyOrderAmountLog.dividedBy(dPrice)

        log(`
            Buying ${MARKET1} (Target Net Profit: ${dynamicSellPercent.toFixed(2)}%)
            ==================
            amountIn: ${parseFloat(BUY_ORDER_AMOUNT).toFixed(2)} ${MARKET2}
            amountOut: ${dAmountOutLog.toNumber().toFixed(6)} ${MARKET1}
            Target Sell Price: ${dTargetSellPrice.toNumber().toFixed(4)} ${MARKET2}
        `)

        const res = await marketBuy(amount, true)
        if (res && res.status === 'FILLED') {
            order.status = 'bought'
            order.id = res.orderId

            // TODO: DECIMAL_BRIDGE (exchange fills API & local state store)
            const dFee = await getFees(res.fills[0])
            order.buy_fee = dFee.toNumber()
            order.amount = new Decimal(res.executedQty).minus(new Decimal(res.fills[0].commission)).toNumber()

            const prevFees = new Decimal(store.get('fees') || 0)
            store.put('fees', prevFees.plus(dFee).toNumber())

            const dBuyPrice = new Decimal(res.fills[0].price)
            order.buy_price = dBuyPrice.toNumber()

            const dynamicSellPercent = store.get('dynamic_sell_percent') || SELL_PERCENT
            const dDynamicSellPercent = new Decimal(dynamicSellPercent)
            const dTargetNetPercent = dDynamicSellPercent.dividedBy(100)

            const dOne = new Decimal(1)
            const dFeeRate = new Decimal(FEE_RATE)
            const dFeeFactor = dOne.minus(dFeeRate)
            const dNetMultiplier = dOne.plus(dTargetNetPercent).dividedBy(dFeeFactor.times(dFeeFactor))

            const dSellPrice = dBuyPrice.times(dNetMultiplier)
            order.sell_price = dSellPrice.toNumber()

            if (dSellPrice.lessThanOrEqualTo(dBuyPrice)) {
                logColor(colors.red, `[CRITICAL] Error de cálculo: Sell price (${order.sell_price}) <= Buy price (${order.buy_price}). Orden no persistida en el Grid.`)
                return
            }

            // Actualizamos primero el balance real para acotar la ventana de desincronizacion
            await updateBalancesFn()

            activeOrders.push(order)
            store.put('start_price', order.buy_price)

            store.put('total_buys', (parseInt(store.get('total_buys')) || 0) + 1)

            logColor(colors.green, '=============================')
            logColor(colors.green, `Bought ${order.amount} ${MARKET1} for ${parseFloat(BUY_ORDER_AMOUNT).toFixed(2)} ${MARKET2}, Price: ${order.buy_price}\n`)
            logColor(colors.green, '=============================')

            _calculateProfits()

            notifyFn(price, 'buy')
        } else {
            logColor(colors.red, '[ADVERTENCIA] La orden de compra no se completo o fallo en Binance.')
            _newPriceReset(2, BUY_ORDER_AMOUNT, price)
        }
    } else _newPriceReset(2, BUY_ORDER_AMOUNT, price)
}

// === VENTA (con Dust Sweep limitado) ===

async function _sell(price, updateBalancesFn, notifyFn) {
    const orders = store.get('orders')

    // --- DESFIBRILADOR DE ÓRDENES (Recuperación de BELOW_NOTIONAL) ---
    let recoveredZombies = false
    const minNotional = await getMinBuy()

    for (let i = 0; i < orders.length; i++) {
        if (orders[i].status === 'BELOW_NOTIONAL') {
            const dOrderAmount = new Decimal(orders[i].amount || 0)
            const notionalValue = dOrderAmount.times(new Decimal(price))
            if (notionalValue.greaterThanOrEqualTo(new Decimal(minNotional))) {
                orders[i].status = 'bought'
                recoveredZombies = true
            }
        }
    }

    if (recoveredZombies) {
        store.put('orders', orders)
    }
    // ------------------------------------------------------------------

    const toSold = getToSold(price, true)

    if (toSold.length > 0) {
        const totalAmount = toSold.reduce((sum, order) => sum.plus(new Decimal(order.amount || 0)), new Decimal(0))

        // Barrido de polvo LIMITADO: solo barrer si el exceso es < 1%
        let dAvailableBalance = new Decimal(0)
        try {
            const balances = await getBalances()
            dAvailableBalance = new Decimal(balances[MARKET1] || 0)
        } catch (e) {
            dAvailableBalance = new Decimal(store.get(`${MARKET1.toLowerCase()}_balance`) || 0)
        }

        let amountToSell = totalAmount
        const dustExcess = dAvailableBalance.minus(totalAmount)
        const dustThreshold = totalAmount.times(0.01)

        if (dustExcess.greaterThan(0) && dustExcess.lessThanOrEqualTo(dustThreshold)) {
            amountToSell = dAvailableBalance
            logColor(colors.gray, `[DUST] Barriendo polvo: +${dustExcess.toNumber().toFixed(8)} ${MARKET1}`)
        } else if (dAvailableBalance.lessThan(totalAmount) && dAvailableBalance.greaterThan(0)) {
            amountToSell = dAvailableBalance
        }

        if (amountToSell.greaterThan(0)) {
            log(`
                Selling ${MARKET1}
                =================
                amountIn: ${amountToSell.toNumber().toFixed(6)} ${MARKET1}
                amountOut: ${amountToSell.times(new Decimal(price)).toNumber().toFixed(2)} ${MARKET2}
            `)

            const lotQuantity = await getQuantity(amountToSell)
            const dLotQuantity = new Decimal(lotQuantity || 0)
            if (dLotQuantity.lessThanOrEqualTo(0)) {
                logColor(colors.red, '[ADVERTENCIA] Cantidad a vender por debajo del tamanho de lote permitido.')
                return false
            }

            const dPrice = new Decimal(price)
            const notionalValue = dLotQuantity.times(dPrice)

            if (notionalValue.lessThan(new Decimal(minNotional))) {
                const hasNewOrders = toSold.some(o => o.status !== 'BELOW_NOTIONAL')
                if (hasNewOrders) {
                    logColor(colors.yellow, `[NOTIONAL] Orden por debajo del mínimo de Binance (${minNotional} USDT). Valor a vender: $${notionalValue.toNumber().toFixed(4)} USDT. Esperando que el balance crezca...`)
                    toSold.forEach(o => { o.status = 'BELOW_NOTIONAL' })
                    store.put('orders', orders)
                }
                return false
            } else {
                toSold.forEach(o => { o.status = 'selling' })
                store.put('orders', orders)
            }

            const res = await marketSell(lotQuantity)
            if (res && res.status === 'FILLED') {
                const _price = new Decimal(res.fills[0].price)
                let remainingToSell = amountToSell

                for (var i = 0; i < orders.length; i++) {
                    var order = orders[i]
                    for (var j = 0; j < toSold.length; j++) {
                        if (order.id == toSold[j].id) {
                            const orderAmount = new Decimal(order.amount || 0)
                            if (remainingToSell.lessThanOrEqualTo(0)) break

                            const sellableAmount = Decimal.min(orderAmount, remainingToSell)
                            if (sellableAmount.greaterThanOrEqualTo(orderAmount)) {
                                const grossProfit = orderAmount.times(_price).minus(orderAmount.times(new Decimal(toSold[j].buy_price)))

                                const dSellFee = await getFees(res.fills[0])
                                toSold[j].sell_fee = dSellFee.toNumber() // TODO: DECIMAL_BRIDGE (saving to local store)

                                const dBuyFee = new Decimal(toSold[j].buy_fee || 0)
                                const netProfit = grossProfit.minus(dSellFee.plus(dBuyFee))

                                toSold[j].profit = netProfit.toNumber()
                                toSold[j].status = 'sold'
                                orders[i] = toSold[j]

                                const prevFees = new Decimal(store.get('fees') || 0)
                                store.put('fees', prevFees.plus(dSellFee).toNumber())

                                const prevLosses = new Decimal(store.get('sl_losses') || 0)
                                store.put('sl_losses', prevLosses.plus(netProfit).toNumber())

                                remainingToSell = remainingToSell.minus(orderAmount)
                            } else {
                                logColor(colors.gray, `[PARTIAL] Venta parcial detectada para ${order.id}: ${sellableAmount.toNumber().toFixed(6)} ${MARKET1} cubiertos; el resto queda pendiente.`)
                                remainingToSell = new Decimal(0)
                            }
                        }
                    }
                }

                const finalNumPrice = _price.toNumber()
                store.put('start_price', finalNumPrice)
                await updateBalancesFn()

                store.put('total_sells', (parseInt(store.get('total_sells')) || 0) + 1)

                logColor(colors.red, '=============================')
                logColor(colors.red,
                    `Sold ${amountToSell.toNumber().toFixed(6)} ${MARKET1} for ${amountToSell.times(_price).toNumber().toFixed(2)} ${MARKET2}, Price: ${finalNumPrice}\n`)
                logColor(colors.red, '=============================')

                _calculateProfits()

                var i = orders.length
                while (i--) {
                    if (orders[i].status === 'sold') {
                        if (orders[i].id) {
                            updateIntent(orders[i].id, 'CLOSED')
                        }
                        store.put('completed_cycles', (parseInt(store.get('completed_cycles')) || 0) + 1)
                        orders.splice(i, 1)
                    }
                }

                store.put('orders', orders)

                notifyFn(price, 'sell')
            } else {
                logColor(colors.red, '[ADVERTENCIA] La venta no pudo completarse en Binance.')
                store.put('start_price', price)
            }
        } else store.put('start_price', price)
    }

    return toSold.length > 0
}

module.exports = {
    _buy,
    _sell,
    getToSold,
    setDrawdownKilled,
    isDrawdownKilled,
}
