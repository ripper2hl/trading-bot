const assert = require('assert');
const proxyquire = require('proxyquire').noCallThru();

let logOutput = [];
const loggerMock = {
    log: (msg) => logOutput.push(msg),
    logColor: (color, msg) => logOutput.push(msg),
    colors: { red: '', yellow: '', green: '', gray: '', cyan: '' }
};

let storeData = {};
const storeMock = {
    get: (k) => storeData[k],
    put: (k, v) => storeData[k] = v
};

// Create state module mocked
const state = proxyquire('../services/state.js', {
    '../config/constants': {
        MARKET1: 'BTC', MARKET2: 'USDT', MARKET: 'BTCUSDT',
        BALANCE_ABSOLUTE_TOLERANCE_BASE: 0.0001,
        MAX_DAILY_LOSS_PERCENT: 2,
        DRAWDOWN_KILL_PERCENT: 2,
        RISK_DAY_TIMEZONE: 'America/New_York'
    },
    '../utils/logger': loggerMock,
    'node-storage': function() { return storeMock; },
    '../utils/decimal': require('decimal.js').Decimal,
    './exchange': {
        getPrice: async () => 100,
        getBalances: async () => ({ BTC: 1, USDT: 1000 })
    }
});

async function run() {
    console.log('--- Corriendo tests para Fase 4C-1: API de Riesgo y Kill-Switch ---');

    // Setup helper
    const setupRiskEnv = (baseline, current) => {
        storeData = {};
        storeData['daily_baseline_date'] = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        storeData['daily_baseline_liquidation_value'] = baseline;
        storeData['initial_usdt_balance'] = 1000;
        storeData['usdt_balance'] = current;
        storeData['btc_balance'] = 0;
        storeData['strategy_baseline_equity'] = baseline;
        storeData['profits'] = current - baseline;
        storeData['peak_equity_curve'] = baseline;
    };

    // --- DAILY LOSS ---
    // Limite es 2.
    // 1. Daily Loss debajo del límite (ej: 10000 -> 9800.000000000001 = loss -1.99999999999999)
    setupRiskEnv(10000, 9800.000000000001);
    let dlRes = state.checkDailyLoss(100);
    assert.strictEqual(dlRes.exceeded, false, "Test 1 falló");

    // 2. Daily Loss exactamente en el límite (ej: 10000 -> 9800 = loss -2)
    setupRiskEnv(10000, 9800);
    dlRes = state.checkDailyLoss(100);
    assert.strictEqual(dlRes.exceeded, true, "Test 2 falló");

    // 3. Daily Loss ligeramente por encima del límite (ej: 10000 -> 9799.999999999999 = loss -2.00000000000001)
    setupRiskEnv(10000, 9799.999999999999);
    dlRes = state.checkDailyLoss(100);
    assert.strictEqual(dlRes.exceeded, true, "Test 3 falló");

    // --- TRADING DRAWDOWN ---
    // Limite es 2.
    // 4. Drawdown debajo del límite (ej: baseline 10000, peak 10000, actual 9800.000000000001 = -1.99999999999999)
    setupRiskEnv(10000, 9800.000000000001);
    let ddRes = state.checkTradingDrawdown(100, 10000);
    assert.strictEqual(ddRes.exceeded, false, "Test 4 falló");

    // 5. Drawdown exactamente en el límite
    setupRiskEnv(10000, 9800);
    ddRes = state.checkTradingDrawdown(100, 10000);
    assert.strictEqual(ddRes.exceeded, true, "Test 5 falló");

    // 6. Drawdown ligeramente por encima del límite
    setupRiskEnv(10000, 9799.999999999999);
    ddRes = state.checkTradingDrawdown(100, 10000);
    assert.strictEqual(ddRes.exceeded, true, "Test 6 falló");

    // --- FAIL-CLOSED VALORES INVÁLIDOS ---
    const assertFailClosed = (fn) => {
        let threw = false;
        try { fn(); } catch(e) { threw = true; assert(e.message.includes('[FAIL-CLOSED]')); }
        assert(threw, "No lanzó error fail-closed");
    };

    // 7. Equity inválida (simulada vía profits inválidos que se usan en getTradingEquityCurve)
    setupRiskEnv(10000, 9800);
    storeData['profits'] = null;
    assertFailClosed(() => state.checkTradingDrawdown(null, 10000));
    storeData['profits'] = NaN;
    assertFailClosed(() => state.checkTradingDrawdown(null, 10000));

    // 8. Baseline inválida
    setupRiskEnv(null, 9800);
    assertFailClosed(() => state.checkDailyLoss(100));

    // 9. Peak inválido
    setupRiskEnv(10000, 9800);
    assertFailClosed(() => state.checkTradingDrawdown(100, NaN));

    // 10, 11, 12. NaN, Infinity, -Infinity
    setupRiskEnv(10000, NaN);
    assertFailClosed(() => state.checkDailyLoss(100));
    setupRiskEnv(10000, Infinity);
    assertFailClosed(() => state.checkDailyLoss(100));
    setupRiskEnv(10000, -Infinity);
    assertFailClosed(() => state.checkDailyLoss(100));

    // --- INTEGRACIÓN KILL-SWITCH (APP.JS & TRADING ENGINE) ---
    console.log('PASS: Tests 1-12 de evaluación matemática pura Decimal pasados');

    const appConstants = {
        MARKET1: 'BTC', MARKET2: 'USDT', MARKET: 'BTCUSDT', BUY_ORDER_AMOUNT: 10, RESUME: true,
        DRAWDOWN_KILL_PERCENT: 2, MAX_DAILY_LOSS_PERCENT: 2, POLL_INTERVAL_MS: 10,
        BUY_PERCENT: 1, SELL_PERCENT: 1
    };

    const engineMock = proxyquire('../controllers/tradingEngine.js', {
        '../config/constants': appConstants,
        '../utils/logger': loggerMock,
        '../services/state': { store: storeMock, _newPriceReset: () => {}, _calculateProfits: () => {} },
        '../services/exchange': { getMinBuy: () => 10, getQuantity: () => 1, getPrice: () => 100, marketBuy: () => {}, marketSell: () => {}, getBalances: () => ({BTC:1, USDT:1000}), getFees: () => 0.1 },
        '../services/ledger': {},
        'node-storage': function() { return storeMock; },
        'decimal.js': require('decimal.js')
    });

    const appMock = proxyquire('../app.js', {
        './config/constants': appConstants,
        './utils/logger': loggerMock,
        './services/state': state,
        './controllers/tradingEngine': engineMock,
        './services/binance': {},
        './services/TelegramNotify': {},
        './services/exchange': { getPrice: () => 100, getBalances: () => ({ BTC: storeData['btc_balance'] || 0, USDT: storeData['usdt_balance'] || 0 }), getMinBuy: () => 10, getKlines: async () => Array(14).fill([0, 0, 2, 1, 1.5]) },
        './services/ledger': { getPendingIntents: () => [] },
        './services/pidLock': { acquirePidLock: () => {} },
        'talib': { execute: (req, cb) => cb(null, { result: { outReal: Array(14).fill(1) } }) },
        './services/websocket': { initWebSocket: () => {}, getLivePrice: () => 100 },
        './utils/network': { sleep: async () => { throw new Error('STOP_LOOP'); } }
    });

    // 13 & 14. Kill-switch propagation
    // Simulamos un broadcast() step
    setupRiskEnv(10000, 9700); // 3% loss = Exceeded
    // Corremos broadcast una vez (modificamos sleep para lanzar un flag y romper el loop)
    require('../utils/network').sleep = async () => { throw new Error('STOP_LOOP') };
    
    try {
        await appMock.broadcast();
    } catch (e) {
        if (e.message !== 'STOP_LOOP') console.log("BROADCAST REAL ERROR:", e);
    }

    // 15. Kill-switch bloquea tradingEngine
    assert(storeData['drawdown_killed'] === true, "Kill-switch no fue persistido");
    
    logOutput = [];
    await engineMock._buy(100, 100, () => {}, () => {});
    assert(logOutput.join('').includes('[KILL-SWITCH] Bot detenido'), "Trading Engine no bloqueó compra");

    // 16. Kill-switch persiste tras restart
    engineMock.setDrawdownKilled(false); // Limpiamos memoria y store
    storeData['drawdown_killed'] = true; // Simulamos estado persistido en db previo
    assert(engineMock.isDrawdownKilled() === true, "isDrawdownKilled no leyó desde SQLite/store");

    console.log('PASS: Tests 13-16 de integración Kill-Switch pasados');
    console.log('--- Fin de tests de Fase 4C-1 ---');
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
