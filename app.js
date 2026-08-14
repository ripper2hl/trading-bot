/**
 * app.js - Entry Point
 * Inicializa el bot e inicia el bucle principal (broadcast).
 * Toda la logica de negocio vive en controllers/ y services/.
 */
const {
    MARKET1, MARKET2, MARKET, BUY_ORDER_AMOUNT,
    DRY_RUN, DRAWDOWN_KILL_PERCENT, TRAILING_TP_PERCENT, SLEEP_TIME,
    validateBootstrapConfig
} = require('./config/constants')
const { log, logColor, colors } = require('./utils/logger')
const { sleep } = require('./utils/network')
const { NotifyTelegram } = require('./services/TelegramNotify')
const {
    store, elapsedTime, _updateBalances, getRealProfits, _logProfits, _closeBot
} = require('./services/state')
const {
    getBalances, getPrice, getMinBuy, clearStart, _sellAll, withdraw
} = require('./services/exchange')
const {
    _buy, _sell, getToSold, setDrawdownKilled, isDrawdownKilled
} = require('./controllers/tradingEngine')
const moment = require('moment')

// === NOTIFICACIONES ===

function canNotifyTelegram(from) {
    return process.env.NOTIFY_TELEGRAM_ON.includes(from)
}

function _notifyTelegram(price, from) {
    moment.locale('es')
    if (process.env.NOTIFY_TELEGRAM && canNotifyTelegram(from))
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

// Helper: actualizar balances pasando getBalances como dependencia
async function updateBalances() {
    await _updateBalances(getBalances)
}

// === BUCLE PRINCIPAL ===

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
                    if (drawdownPercent >= DRAWDOWN_KILL_PERCENT && !isDrawdownKilled()) {
                        setDrawdownKilled(true)
                        logColor(colors.red, `[KILL-SWITCH] Drawdown de ${drawdownPercent}% en 24h supera el limite de ${DRAWDOWN_KILL_PERCENT}%. Deteniendo operaciones.`)
                        logColor(colors.red, '[KILL-SWITCH] Se requiere intervencion manual para reanudar.')
                        _notifyTelegram(marketPrice, 'sell')
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
                                _notifyTelegram(marketPrice, 'withdraw')
                                if (process.env.START_AGAIN) {
                                    await sleep(5000)
                                    await updateBalances()
                                } else {
                                    _closeBot()
                                    return
                                }
                            } else {
                                await _sellAll()
                                _closeBot()
                                return
                            }
                        } else {
                            return
                        }
                    } else if (totalProfitsPercent <= -1 * process.env.STOP_LOSS_BOT) {
                        logColor(colors.red, 'Cerrando bot en pérdidas....')
                        if (process.env.SELL_ALL_ON_CLOSE)
                            await _sellAll()
                        _closeBot()
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
                        await _buy(marketPrice, BUY_ORDER_AMOUNT, updateBalances, _notifyTelegram)
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

                await _sell(marketPrice, updateBalances, _notifyTelegram)

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
                await updateBalances()
            } catch (syncErr) {
                logColor(colors.red, `[ERROR SYNC] No se pudo resincronizar saldos: ${syncErr.message || syncErr}`)
            }
        }
        await sleep(SLEEP_TIME)
    }
}

// === INICIALIZACION ===

async function init() {
    const validation = validateBootstrapConfig()
    if (!validation.ok) {
        console.error('[BOOTSTRAP] El arranque ha sido bloqueado por configuración inválida:')
        validation.errors.forEach(error => console.error(`  - ${error}`))
        process.exit(1)
    }

    const minBuy = await getMinBuy()
    if (minBuy > BUY_ORDER_AMOUNT) {
        console.log(`El lote mínimo de compra es: ${minBuy} ${MARKET2}`)
        return
    }

    if (process.argv[5] !== 'resume') {
        log('Iniciando bot...')
        if (process.env.SELL_ALL_ON_START)
            await clearStart(_closeBot)
        const startTime = Date.now()
        store.put('start_time', startTime)
        const price = await getPrice(MARKET)
        if (price === null || Number.isNaN(price)) {
            console.error('[BOOTSTRAP] No se pudo obtener el precio inicial del mercado. Revisa la conexión a Binance y el símbolo.')
            process.exit(1)
        }
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