/**
 * controllers/tradingEngine.js
 * Logica de trading: compra (con net-profit predictivo), venta (con dust sweep limitado),
 * evaluacion de ordenes (con trailing take-profit y stop-loss de grid).
 */
const {
    MARKET1, MARKET2, MARKET, BUY_ORDER_AMOUNT,
    SELL_PERCENT, MAX_POSITION_PERCENT, MAX_OPEN_GRID_ORDERS, FEE_RATE, TRAILING_TP_PERCENT,
    GRID_STOP_LOSS_ENABLED, GRID_STOP_LOSS_PERCENT, GRID_STOP_LOSS_FIFO
} = require('../config/constants')
const { log, logColor, colors } = require('../utils/logger')
const { store, _newPriceReset, _calculateProfits } = require('../services/state')
const { marketBuy, marketSell, getBalances, getPrice, getQuantity, getFees } = require('../services/exchange')
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

        // Condicion de Stop-Loss de Grid
        const isStopLossHit = GRID_STOP_LOSS_ENABLED
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
                if (!order.peak_price || price > order.peak_price) {
                    order.peak_price = price
                }

                const retrace = ((order.peak_price - price) / order.peak_price) * 100

                if (retrace >= TRAILING_TP_PERCENT) {
                    if (changeStatus) {
                        order.sold_price = price
                        order.status = 'selling'
                    }
                    toSold.push(order)
                }
            } else {
                // Modo clasico: venta estatica
                if (changeStatus) {
                    order.sold_price = price
                    order.status = 'selling'
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

    const currentBalance = parseFloat(store.get(`${MARKET2.toLowerCase()}_balance`))
    const totalExposure = boughtOrders.reduce((sum, order) => {
        const orderAmount = parseFloat(order.amount) || 0
        const orderPrice = parseFloat(order.buy_price) || 0
        return sum + (orderAmount * orderPrice)
    }, 0)
    const maxAllowed = currentBalance * (MAX_POSITION_PERCENT / 100)
    const projectedExposure = totalExposure + parseFloat(BUY_ORDER_AMOUNT)

    if (projectedExposure > maxAllowed) {
        logColor(colors.yellow, `[POSICION] Exposicion proyectada ${projectedExposure.toFixed(2)} ${MARKET2} excede el ${MAX_POSITION_PERCENT}% del balance (${maxAllowed.toFixed(2)} ${MARKET2}). Orden bloqueada.`)
        return
    }

    if (currentBalance >= BUY_ORDER_AMOUNT) {
        const activeOrders = store.get('orders') || []

        const targetNetPercent = SELL_PERCENT / 100
        const netMultiplier = (1 + targetNetPercent) / ((1 - FEE_RATE) * (1 - FEE_RATE))
        const targetSellPrice = price * netMultiplier
        var slFactor = GRID_STOP_LOSS_PERCENT * price / 100

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
            Buying ${MARKET1} (Target Net Profit: ${SELL_PERCENT}%)
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

            activeOrders.push(order)
            store.put('start_price', order.buy_price)
            await updateBalancesFn()

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
    const toSold = getToSold(price, true)

    if (toSold.length > 0) {
        var totalAmount = parseFloat(toSold.map(order => order.amount).reduce((prev, next) => parseFloat(prev) + parseFloat(next)))

        // Barrido de polvo LIMITADO: solo barrer si el exceso es < 1%
        let availableBalance = 0
        try {
            const balances = await getBalances()
            availableBalance = balances[MARKET1] || 0
        } catch (e) {
            availableBalance = parseFloat(store.get(`${MARKET1.toLowerCase()}_balance`)) || 0
        }

        let amountToSell = totalAmount
        const dustExcess = availableBalance - totalAmount
        const dustThreshold = totalAmount * 0.01
        if (dustExcess > 0 && dustExcess <= dustThreshold) {
            amountToSell = availableBalance
            logColor(colors.gray, `[DUST] Barriendo polvo: +${dustExcess.toFixed(8)} ${MARKET1}`)
        } else if (availableBalance < totalAmount && availableBalance > 0) {
            amountToSell = availableBalance
        }

        if (amountToSell > 0) {
            log(`
                Selling ${MARKET1}
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
                let remainingToSell = amountToSell

                for (var i = 0; i < orders.length; i++) {
                    var order = orders[i]
                    for (var j = 0; j < toSold.length; j++) {
                        if (order.id == toSold[j].id) {
                            const orderAmount = parseFloat(order.amount) || 0
                            if (remainingToSell <= 0) break

                            const sellableAmount = Math.min(orderAmount, remainingToSell)
                            if (sellableAmount >= orderAmount) {
                                toSold[j].profit = (orderAmount * _price) - (orderAmount * parseFloat(toSold[j].buy_price))
                                toSold[j].sell_fee = parseFloat((await getFees(res.fills[0])))
                                toSold[j].profit -= (toSold[j].sell_fee + toSold[j].buy_fee)
                                toSold[j].status = 'sold'
                                orders[i] = toSold[j]
                                store.put('fees', parseFloat(store.get('fees')) + orders[i].sell_fee)
                                store.put('sl_losses', parseFloat(store.get('sl_losses')) + orders[i].profit)
                                remainingToSell -= orderAmount
                            } else {
                                logColor(colors.gray, `[PARTIAL] Venta parcial detectada para ${order.id}: ${sellableAmount.toFixed(6)} ${MARKET1} cubiertos; el resto queda pendiente.`)
                                remainingToSell = 0
                            }
                        }
                    }
                }

                store.put('start_price', _price)
                await updateBalancesFn()

                logColor(colors.red, '=============================')
                logColor(colors.red,
                    `Sold ${amountToSell.toFixed(6)} ${MARKET1} for ${parseFloat(amountToSell * _price).toFixed(2)} ${MARKET2}, Price: ${_price}\n`)
                logColor(colors.red, '=============================')

                _calculateProfits()

                var i = orders.length
                while (i--) {
                    if (orders[i].status === 'sold') {
                        if (orders[i].id) {
                            updateIntent(orders[i].id, 'CLOSED')
                        }
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
