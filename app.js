/**
 * app.js - Entry Point
 * Inicializa el bot e inicia el bucle principal (broadcast).
 * Toda la logica de negocio vive en controllers/ y services/.
 */
const fs = require('fs')
const path = require('path')
const {
    MARKET1, MARKET2, MARKET, BUY_ORDER_AMOUNT,
    BUY_PERCENT, SELL_PERCENT, STOP_LOSS_PERCENT, TAKE_PROFIT_PERCENT,
    DRY_RUN, DRAWDOWN_KILL_PERCENT, TRAILING_TP_PERCENT, POLL_INTERVAL_MS,
    NOTIFY_TELEGRAM_ENABLED, NOTIFY_TELEGRAM_ON,
    SELL_ALL_ON_CLOSE, SELL_ALL_ON_START, START_AGAIN,
    WITHDRAW_PROFITS_ENABLED, MIN_WITHDRAW_AMOUNT,
    GRID_STOP_LOSS_ENABLED, GRID_STOP_LOSS_PERCENT, GRID_STOP_LOSS_FIFO,
    BALANCE_ABSOLUTE_TOLERANCE_BASE, USE_TESTNET, MULTIPLICADOR_ATR,
    validateBootstrapConfig
} = require('./config/constants')
const client = require('./services/binance')
const { log, logColor, colors } = require('./utils/logger')
const { sleep } = require('./utils/network')
const { NotifyTelegram } = require('./services/TelegramNotify')
const {
    store, elapsedTime, _updateBalances, getRealProfits, getInitialEquity,
    getCurrentEquity, updatePeakEquity, getDrawdownFromPeak, getTradingEquityCurve, updatePeakEquityCurve, getTradingDrawdown, _logProfits, _closeBot, reconcileBalances, resolveInitialBaseline
} = require('./services/state')
const {
    getBalances, getPrice, getPriceTick, getMinBuy, clearStart, _sellAll, withdraw, getKlines
} = require('./services/exchange')
const { getPendingIntents, updateIntent, reconstructStoreFromSQLite, db } = require('./services/ledger')
const { acquirePidLock } = require('./services/pidLock')
const {
    _buy, _sell, getToSold, setDrawdownKilled, isDrawdownKilled
} = require('./controllers/tradingEngine')
const moment = require('moment')

// === NOTIFICACIONES ===

function canNotifyTelegram(from) {
    return Boolean(NOTIFY_TELEGRAM_ON && NOTIFY_TELEGRAM_ON.includes(from))
}

function _notifyTelegram(price, from) {
    moment.locale('es')
    if (NOTIFY_TELEGRAM_ENABLED && canNotifyTelegram(from)) {
        try {
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
        } catch (err) {
            logColor(colors.red, `[TELEGRAM] No se pudo enviar notificación: ${err.message || err}`)
        }
    }
}

async function emergencyCleanUp(symbol = MARKET) {
    if (!symbol) return

    try {
        await client.cancelOpenOrders({ symbol })
        logColor(colors.yellow, `[RISK] Órdenes abiertas canceladas con éxito para ${symbol}.`)
    } catch (err) {
        logColor(colors.yellow, `[RISK] emergencyCleanUp no pudo cancelar órdenes de ${symbol}: ${err.message || err}`)
    }
}

// Helper: actualizar balances pasando getBalances como dependencia
async function updateBalances() {
    await _updateBalances(getBalances)
}

// === INDICADOR ATR ===
let currentATR = 0
let lastATRUpdate = 0

function calculateATR(klines) {
    if (!klines || klines.length === 0) return 0
    let trs = []
    for (let i = 1; i < klines.length; i++) {
        const high = klines[i].high
        const low = klines[i].low
        const prevClose = klines[i-1].close
        const tr1 = high - low
        const tr2 = Math.abs(high - prevClose)
        const tr3 = Math.abs(low - prevClose)
        trs.push(Math.max(tr1, tr2, tr3))
    }
    if (trs.length === 0) return 0
    const sumTR = trs.reduce((acc, val) => acc + val, 0)
    return sumTR / trs.length
}

async function updateDynamicGrid(currentPrice) {
    try {
        const klines = await getKlines(MARKET, '15m', 15)
        currentATR = calculateATR(klines)
        if (currentATR > 0 && currentPrice > 0) {
            let percent = (currentATR / currentPrice) * 100 * MULTIPLICADOR_ATR
            const MIN_GRID_PERCENT = 0.2
            const MAX_GRID_PERCENT = 5.0
            percent = Math.max(MIN_GRID_PERCENT, Math.min(MAX_GRID_PERCENT, percent))
            
            store.put('dynamic_buy_percent', percent)
            store.put('dynamic_sell_percent', percent)
            logColor(colors.cyan, `[ATR] Actualizado: ${currentATR.toFixed(2)} USD. Nuevo Grid Dinámico: ${percent.toFixed(3)}%`)
        }
    } catch (err) {
        logColor(colors.yellow, `[ATR WARN] No se pudo actualizar ATR: ${err.message || err}`)
    }
}

// === BUCLE PRINCIPAL ===

async function broadcast() {
    while (true) {
        try {
            const haltFilePath = path.join(__dirname, 'data', `${MARKET1}${MARKET2}.HALT`)
            const haltAltPath = path.join('data', `${MARKET1}${MARKET2}.HALT`)
            if (fs.existsSync(haltFilePath) || fs.existsSync(haltAltPath)) {
                logColor(colors.yellow, '[HALT MANUAL] Archivo de pausa detectado. El bot está en suspensión temporal...')
                await sleep(POLL_INTERVAL_MS)
                continue
            }

            try {
                await reconcileBalances(getBalances, 1)
            } catch (balanceErr) {
                logColor(colors.red, `[CRITICAL] Reconciliacion de saldos fallida: ${balanceErr.message || balanceErr}`)
                _notifyTelegram(null, 'risk')
                await emergencyCleanUp()
                process.exit(1)
            }

            const tick = await getPriceTick(MARKET)
            if (!tick || !tick.price) {
                logColor(colors.yellow, '[WARN] No se pudo obtener el precio del mercado. Omitiendo ciclo.')
                await sleep(POLL_INTERVAL_MS)
                continue
            }

            // Circuit Breaker de Alta Latencia (High Latency)
            if (tick.latency > 3000) {
                logColor(colors.yellow, `[HIGH LATENCY] Latencia de red excesiva con Binance (${tick.latency}ms > 3000ms). Omitiendo ciclo.`)
                await sleep(POLL_INTERVAL_MS)
                continue
            }

            const now = Date.now()
            if (now - lastATRUpdate > 15 * 60 * 1000) {
                await updateDynamicGrid(tick ? tick.price : 0)
                lastATRUpdate = now
            }

            const marketPrice = tick.price
            const startPrice = store.get('start_price')
            
            const dynBuy = parseFloat(store.get('dynamic_buy_percent')) || BUY_PERCENT
            const dynSell = parseFloat(store.get('dynamic_sell_percent')) || SELL_PERCENT

            console.clear()
            if (DRY_RUN) logColor(colors.yellow, '>>> MODO DRY-RUN ACTIVO (sin ordenes reales) <<<')
            log(`Running Time: ${elapsedTime()}`)
            logColor(colors.cyan, `ATR (15m): $${currentATR.toFixed(2)} | Grid Dinámico: Buy ${dynBuy.toFixed(2)}% / Sell ${dynSell.toFixed(2)}%`)
            const totalProfits = parseFloat(store.get('profits')) || 0
            const baselineEquity = parseFloat(store.get('strategy_baseline_equity')) || parseFloat(store.get(`initial_${MARKET2.toLowerCase()}_balance`)) || 0
            const totalProfitsPercent = baselineEquity > 0
                ? parseFloat((100 * totalProfits / baselineEquity).toFixed(3))
                : 0

            const currentEquity = getCurrentEquity(marketPrice)
            const equityCurve = getTradingEquityCurve(marketPrice)
            const peakEquityCurve = updatePeakEquityCurve(marketPrice)
            const tradingDDPercent = getTradingDrawdown(marketPrice, peakEquityCurve)
            const absTradingDrawdown = Math.abs(tradingDDPercent)

            if (absTradingDrawdown >= DRAWDOWN_KILL_PERCENT && !isDrawdownKilled()) {
                setDrawdownKilled(true)
                logColor(colors.red, `[KILL-SWITCH] Peak Equity Curve: ${peakEquityCurve.toFixed(2)} ${MARKET2}, Equity Curve Actual: ${equityCurve.toFixed(2)} ${MARKET2}`)
                logColor(colors.red, `[KILL-SWITCH] Trading Drawdown del ${absTradingDrawdown.toFixed(3)}% desde el máximo de la curva de equity supera el límite de ${DRAWDOWN_KILL_PERCENT}%. Deteniendo operaciones.`)
                logColor(colors.red, '[KILL-SWITCH] Se requiere intervención manual para reanudar.')
                _notifyTelegram(marketPrice, 'sell')
            }

                if (!isNaN(totalProfits)) {
                    log(`Withdrawal profits: ${parseFloat(store.get('withdrawal_profits')).toFixed(2)} ${MARKET2}`)
                    logColor(totalProfits < 0 ? colors.red : totalProfits == 0 ? colors.gray : colors.green,
                        `Real Profits [SL = ${STOP_LOSS_PERCENT}%, TP = ${TAKE_PROFIT_PERCENT}%]: ${totalProfitsPercent}% ==> ${totalProfits <= 0 ? '' : '+'}${parseFloat(totalProfits).toFixed(3)} ${MARKET2}`)

                    if (totalProfitsPercent >= TAKE_PROFIT_PERCENT) {
                        logColor(colors.green, 'Cerrando bot en ganancias....')
                        if (SELL_ALL_ON_CLOSE) {
                            if (WITHDRAW_PROFITS_ENABLED
                                && totalProfits >= MIN_WITHDRAW_AMOUNT) {
                                await withdraw(totalProfits, marketPrice)
                                _notifyTelegram(marketPrice, 'withdraw')
                                if (START_AGAIN) {
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
                    } else if (totalProfitsPercent <= -STOP_LOSS_PERCENT) {
                        logColor(colors.red, 'Cerrando bot en pérdidas....')
                        if (SELL_ALL_ON_CLOSE)
                            await _sellAll()
                        _closeBot()
                        return
                    }
                }

                _logProfits(marketPrice)
                const entryPrice = store.get('entry_price')
                const entryFactor = (marketPrice - entryPrice)
                const entryPercent = parseFloat(100 * entryFactor / entryPrice).toFixed(2)
                const activeOrders = store.get('orders') || []
                const hasBoughtOrders = activeOrders.some(o => o && o.status === 'bought')
                const priceLabel = hasBoughtOrders ? 'Entry price' : 'Reference price'
                log(`${priceLabel}: ${store.get('entry_price')} ${MARKET2} (${entryPercent <= 0 ? '' : '+'}${entryPercent}%)`)
                log('===========================================================')

                log(`Prev price: ${startPrice} ${MARKET2}`)

                if (marketPrice < startPrice) {
                    var factor = (startPrice - marketPrice)
                    var percent = parseFloat(100 * factor / startPrice).toFixed(2)

                    logColor(colors.red,
                        `New price: ${marketPrice} ${MARKET2} ==> -${parseFloat(percent).toFixed(3)}%`)
                    store.put('percent', `-${parseFloat(percent).toFixed(3)}`)

                    if (percent >= dynBuy)
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

                    if (GRID_STOP_LOSS_ENABLED) {
                        const slStrategy = GRID_STOP_LOSS_FIFO ? 'FIFO' : 'LIFO'
                        log(`SL price: ${bOrder.sl_price} ${MARKET2}, Strategy: ${slStrategy}`)
                        log(`SL losses: ${parseFloat(store.get('sl_losses')).toFixed(3)}, Trigger price down: ${GRID_STOP_LOSS_PERCENT}%`)
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
        } catch (err) {
            logColor(colors.red, `[ERROR BROADCAST] Error en el ciclo del bot: ${err.message || err}`)
            try {
                await updateBalances()
            } catch (syncErr) {
                logColor(colors.red, `[ERROR SYNC] No se pudo resincronizar saldos: ${syncErr.message || syncErr}`)
            }
        }
        await sleep(POLL_INTERVAL_MS)
    }
}

// === RECUPERACION DE PENDINGS ===

async function recoverPendingIntent(intent, { store, getBalances }) {
    const balances = await getBalances()

    if (MARKET1) store.put(`${MARKET1.toLowerCase()}_balance`, balances[MARKET1])
    if (MARKET2) store.put(`${MARKET2.toLowerCase()}_balance`, balances[MARKET2])

    if (intent && intent.clientOrderId) {
        updateIntent(intent.clientOrderId, 'CONFIRMED', intent.price, intent.fee)
    }

    if (intent && intent.side === 'BUY') {
        const price = parseFloat(intent.price || 0)
        if (price > 0) {
            store.put('start_price', price)
            store.put('entry_price', price)
        }
        if (MARKET1 && store.get(`initial_${MARKET1.toLowerCase()}_balance`) === undefined) {
            store.put(`initial_${MARKET1.toLowerCase()}_balance`, balances[MARKET1])
        }
        if (MARKET2 && store.get(`initial_${MARKET2.toLowerCase()}_balance`) === undefined) {
            store.put(`initial_${MARKET2.toLowerCase()}_balance`, balances[MARKET2])
        }
    }

    return balances
}

// === INICIALIZACION ===

async function init() {
    const validation = validateBootstrapConfig()
    if (!validation.ok) {
        console.error('[BOOTSTRAP] El arranque ha sido bloqueado por configuración inválida:')
        validation.errors.forEach(error => console.error(`  - ${error}`))
        process.exit(1)
    }

    acquirePidLock(MARKET)

    if (isDrawdownKilled()) {
        logColor(colors.red, '[BOOTSTRAP] Kill-switch restaurado desde el store: operaciones bloqueadas por drawdown previo.')
    }

    const pendingIntents = getPendingIntents()
    if (pendingIntents.length > 0) {
        console.error('[BOOTSTRAP] Detectados intents PENDING en el ledger: posible crash detectado.')
        for (const intent of pendingIntents) {
            try {
                const order = await client.getOrder({ symbol: MARKET, origClientOrderId: intent.clientOrderId })
                if (order && (order.status === 'FILLED' || order.status === 'PARTIALLY_FILLED')) {
                    console.warn(`[BOOTSTRAP] Intent ${intent.clientOrderId} confirmado en Binance. Reconciliando estado local.`)
                    const fillPrice = parseFloat(order.fills?.[0]?.price || order.price || 0)
                    const fillFee = parseFloat(order.fills?.[0]?.commission || 0)
                    updateIntent(intent.clientOrderId, 'CONFIRMED', fillPrice, fillFee)
                    intent.price = fillPrice
                    await recoverPendingIntent(intent, { store, getBalances })
                    logColor(colors.yellow, `[BOOTSTRAP] Crash recuperado. Orden ${intent.clientOrderId} ejecutada offline.`)
                } else {
                    updateIntent(intent.clientOrderId, 'FAILED')
                }
            } catch (err) {
                const isOrderMissing = err && (
                    err.code === -2013 ||
                    (typeof err.message === 'string' && (
                        err.message.includes('-2013') ||
                        err.message.toLowerCase().includes('does not exist')
                    ))
                )

                if (isOrderMissing) {
                    const balances = await getBalances()
                    const localBase = parseFloat(store.get(`${MARKET1.toLowerCase()}_balance`)) || 0
                    const realBase = parseFloat(balances[MARKET1]) || 0

                    if (intent.side === 'BUY' && (realBase - localBase) > BALANCE_ABSOLUTE_TOLERANCE_BASE) {
                        console.error(`[QUARANTINE] Intent ${intent.clientOrderId} retornó NOT_FOUND pero el saldo en Binance (${realBase} ${MARKET1}) supera al local (${localBase}). Cuarentena activada para evitar sobre-compras.`)
                        await emergencyCleanUp()
                        process.exit(1)
                    }

                    console.warn(`[BOOTSTRAP] Intent ${intent.clientOrderId} no existe en Binance y balances coinciden. Marcando como FAILED.`)
                    updateIntent(intent.clientOrderId, 'FAILED')
                    continue
                }

                console.error('[BOOTSTRAP] No se pudo reconciliar el intent pendiente:', err.message || err)
                console.error('[BOOTSTRAP] Estado en cuarentena: intervención manual requerida.')
                await emergencyCleanUp()
                process.exit(1)
            }
        }
    }

    const minBuy = await getMinBuy()
    if (minBuy > BUY_ORDER_AMOUNT) {
        console.log(`El lote mínimo de compra es: ${minBuy} ${MARKET2}`)
        return
    }

    if (process.argv[5] !== 'resume') {
        log('Iniciando bot...')
        if (SELL_ALL_ON_START)
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
        if (store.get(`initial_${MARKET1.toLowerCase()}_balance`) === undefined) {
            store.put(`initial_${MARKET1.toLowerCase()}_balance`, store.get(`${MARKET1.toLowerCase()}_balance`))
        }
        if (store.get(`initial_${MARKET2.toLowerCase()}_balance`) === undefined) {
            store.put(`initial_${MARKET2.toLowerCase()}_balance`, store.get(`${MARKET2.toLowerCase()}_balance`))
        }

        resolveInitialBaseline(MARKET2)
    } else {
        if (SELL_ALL_ON_START) {
            logColor(colors.yellow, '[BOOTSTRAP WARN] SELL_ALL_ON_START está activado en config pero se ignorará por estar en modo RESUME.')
        }

        // Reconstruccion de vista cache (store JSON) si fue borrada o esta vacia
        const currentOrders = store.get('orders')
        if (!Array.isArray(currentOrders) || currentOrders.length === 0) {
            const currentPrice = await getPrice(MARKET)
            const balances = await getBalances()
            logColor(colors.yellow, '[BOOTSTRAP] Reconstruyendo vista de estado local a partir del Ledger SQLite...')
            reconstructStoreFromSQLite({ symbol: MARKET, store, currentPrice, balances })
        }

        resolveInitialBaseline(MARKET2)
    }

    // Fetch inicial de ATR antes del log de auditoria
    const currentPrice = await getPrice(MARKET)
    await updateDynamicGrid(currentPrice)

    const envStr = USE_TESTNET ? 'TESTNET' : 'MAINNET'
    const dryRunStr = DRY_RUN ? 'true' : 'false'
    const withdrawStr = WITHDRAW_PROFITS_ENABLED ? 'true' : 'false'
    const baselineStr = `${(parseFloat(store.get('strategy_baseline_equity')) || 0).toFixed(2)} ${MARKET2}`
    const openOrdersCount = Array.isArray(store.get('orders')) ? store.get('orders').length : 0
    const dynBuyStr = `${(parseFloat(store.get('dynamic_buy_percent')) || BUY_PERCENT).toFixed(2)}%`
    const dynSellStr = `${(parseFloat(store.get('dynamic_sell_percent')) || SELL_PERCENT).toFixed(2)}%`
    const atrStr = `$${currentATR.toFixed(2)}`

    console.log(`
+--------------------------------------------------------+
|                  STARTUP AUDIT LOG                     |
+--------------------------------------------------------+
| Environment:             ${envStr.padEnd(29)} |
| DRY_RUN:                 ${dryRunStr.padEnd(29)} |
| WITHDRAW_PROFITS_ENABLE: ${withdrawStr.padEnd(29)} |
| Initial Baseline Equity: ${baselineStr.padEnd(29)} |
| Open Orders Activas:     ${String(openOrdersCount).padEnd(29)} |
| ATR 15m (Volatility):    ${atrStr.padEnd(29)} |
| Dynamic Grid Buy:        ${dynBuyStr.padEnd(29)} |
| Dynamic Grid Sell:       ${dynSellStr.padEnd(29)} |
| PID Lock Status:         OK                            |
+--------------------------------------------------------+
`)

    broadcast()
}

// === GLOBAL ERROR HANDLERS ===

/**
 * notifyFatalError: Intenta notificar por Telegram de forma segura.
 * Usa valores por defecto si store/MARKET no están disponibles (crasheo temprano).
 * Nunca lanza excepción — todo error es capturado internamente.
 */
async function notifyFatalError(error) {
    try {
        let runningTime = 'N/A'
        let market = 'N/A'
        let market1 = 'N/A'
        let market2 = 'N/A'
        let balance1 = 'N/A'
        let balance2 = 'N/A'
        let startTime = 'N/A'

        try {
            runningTime = elapsedTime()
        } catch (e) {
            // store.get('start_time') puede no existir en crasheo temprano
        }

        try {
            market = MARKET || 'UNKNOWN'
            market1 = MARKET1 || 'UNKNOWN'
            market2 = MARKET2 || 'UNKNOWN'
        } catch (e) {
            // MARKET variables pueden no estar disponibles
        }

        try {
            balance1 = store.get(`${MARKET1.toLowerCase()}_balance`) || 'N/A'
            balance2 = store.get(`${MARKET2.toLowerCase()}_balance`) || 'N/A'
        } catch (e) {
            // store no disponible
        }

        try {
            startTime = moment(store.get('start_time')).format('DD/MM/YYYY HH:mm')
        } catch (e) {
            startTime = 'N/A'
        }

        // Llamar a NotifyTelegram con timeout
        await Promise.race([
            NotifyTelegram({
                runningTime,
                market,
                market1,
                market2,
                price: null,
                balance1,
                balance2,
                gridProfits: 'N/A',
                realProfits: 'N/A',
                start: startTime,
                from: 'risk'
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Telegram timeout')), 2000))
        ])
    } catch (notifyErr) {
        // No hacer nada — si esto falla, al menos ya se loguró el error original
        // y continuaremos con cleanup y exit
    }
}

/**
 * cleanupOnFatal: Intenta cancelar órdenes abiertas de forma segura.
 * Captura todos los errores internamente — nunca lanza excepción.
 */
async function cleanupOnFatal() {
    try {
        await Promise.race([
            emergencyCleanUp(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Cleanup timeout')), 3000))
        ])
    } catch (cleanupErr) {
        // Error ya logurado por emergencyCleanUp o por timeout — continuar
    }
}

process.on('uncaughtException', async (error) => {
    logColor(colors.red, `[UNCAUGHT EXCEPTION] ${error.message || error}`)
    if (error.stack) logColor(colors.red, error.stack)

    await notifyFatalError(error)
    await cleanupOnFatal()

    logColor(colors.red, `[FATAL] Terminando proceso por excepción no capturada.`)
    process.exit(1)
})

process.on('unhandledRejection', async (reason, promise) => {
    logColor(colors.red, `[UNHANDLED REJECTION] ${reason?.message || String(reason)}`)
    if (reason?.stack) logColor(colors.red, reason.stack)

    await notifyFatalError(reason)
    await cleanupOnFatal()

    logColor(colors.red, `[FATAL] Terminando proceso por rechazo de promesa no capturado.`)
    process.exit(1)
})

process.on('SIGTERM', async () => {
    logColor(colors.yellow, `[SIGTERM] Recibida señal de terminación. Cancelando órdenes abiertas...`)

    await cleanupOnFatal()

    // Cierra la base de datos
    logColor(colors.yellow, `[SIGTERM] Cerrando conexión de base de datos...`)
    try {
        db.close()
        logColor(colors.gray, `[SIGTERM] Base de datos cerrada exitosamente.`)
    } catch (err) {
        logColor(colors.red, `[SIGTERM] Error al cerrar base de datos: ${err.message || err}`)
    }

    logColor(colors.yellow, `[SIGTERM] Terminando proceso.`)
    process.exit(0)
})

if (require.main === module) {
    init()
}

module.exports = {
    recoverPendingIntent,
    init,
}