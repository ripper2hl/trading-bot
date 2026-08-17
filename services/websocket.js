const WebSocket = require('ws');
const { logColor, colors } = require('../utils/logger');
const { NotifyTelegram } = require('./TelegramNotify');
const { store, elapsedTime, getRealProfits } = require('./state');
const { MARKET, MARKET1, MARKET2 } = require('../config/constants');
const moment = require('moment');

let latestLivePrice = null;
let latestTimestamp = 0;
let ws;
let isReconnecting = false;
let reconnectAttempts = 0;
let hasNotifiedDisconnect = false;
const MAX_BACKOFF = 60000; // 1 minuto de tope
const STALE_TIMEOUT = 10000; // 10 segundos
const NOTIFY_AT_ATTEMPT = 10;

async function notifyWsRisk(isRecovery = false) {
    try {
        await NotifyTelegram({
            runningTime: elapsedTime(),
            market: MARKET,
            market1: MARKET1,
            market2: MARKET2,
            price: isRecovery ? 'WS_RECOVERED' : 'WS_DISCONNECTED',
            balance1: store.get(`${MARKET1.toLowerCase()}_balance`) || 0,
            balance2: store.get(`${MARKET2.toLowerCase()}_balance`) || 0,
            realProfits: getRealProfits(latestLivePrice || 0),
            start: moment(store.get('start_time')).format('DD/MM/YYYY HH:mm'),
            from: isRecovery ? 'buy' : 'risk' // Usa verde para recuperacion, azul para riesgo
        });
    } catch (e) {}
}
function initWebSocket(symbol, useTestnet = false) {
    const symbolLower = symbol.toLowerCase();
    const baseUrl = useTestnet
        ? 'wss://stream.testnet.binance.vision:9443/ws'
        : 'wss://stream.binance.com:9443/ws';
    
    const wsUrl = `${baseUrl}/${symbolLower}@aggTrade`;

    console.log(`[WS] Iniciando conexión a ${wsUrl}...`);
    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
        logColor(colors.green, `[WS] ¡Conexión establecida con éxito para ${symbol}!`);
        if (hasNotifiedDisconnect) {
            notifyWsRisk(true); // Enviar mensaje de recuperacion
        }
        reconnectAttempts = 0;
        isReconnecting = false;
        hasNotifiedDisconnect = false;
    });

    ws.on('message', (data) => {
        try {
            const parsedData = JSON.parse(data);
            if (parsedData.e === 'aggTrade' && parsedData.p) {
                latestLivePrice = parseFloat(parsedData.p);
                latestTimestamp = Date.now();
            }
        } catch (error) {
            logColor(colors.red, `[WS] Error al parsear JSON: ${error.message}`);
        }
    });

    ws.on('ping', () => {
        ws.pong();
    });

    ws.on('close', (code, reason) => {
        logColor(colors.yellow, `[WS] Conexión cerrada. Código: ${code}, Razón: ${reason}`);
        latestLivePrice = null;
        reconnect(symbol, useTestnet);
    });

    ws.on('error', (error) => {
        logColor(colors.red, `[WS] Error en la conexión: ${error.message}`);
        ws.close();
    });
}

function reconnect(symbol, useTestnet) {
    if (isReconnecting) return;
    isReconnecting = true;

    reconnectAttempts++;

    if (reconnectAttempts === NOTIFY_AT_ATTEMPT && !hasNotifiedDisconnect) {
        logColor(colors.red, `[WS] Límite de reconexiones críticas (${NOTIFY_AT_ATTEMPT}) alcanzado. El bot seguirá intentando cada 60s indefinidamente. Enviando notificación Telegram...`);
        hasNotifiedDisconnect = true;
        notifyWsRisk(false);
    }

    // Backoff exponencial: 2s, 4s, 8s, 16s... hasta 60s
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_BACKOFF); 

    logColor(colors.yellow, `[WS] Reconectando en ${delay / 1000} segundos... (Intento ${reconnectAttempts})`);
    setTimeout(() => {
        isReconnecting = false;
        initWebSocket(symbol, useTestnet);
    }, delay);
}

function getLivePrice() {
    if (latestLivePrice === null) return null;
    if (Date.now() - latestTimestamp > STALE_TIMEOUT) {
        logColor(colors.red, `[WS] Precio estancado. Último tick hace más de ${STALE_TIMEOUT / 1000}s. Declarando precio inválido para evitar operaciones a ciegas.`);
        return null; // Force null to stall the broadcast loop
    }
    return latestLivePrice;
}

function closeWebSocket() {
    if (ws) {
        logColor(colors.yellow, '[WS] Cerrando conexión WebSocket por apagado del bot.');
        ws.close(1000, 'Shutting down');
        ws = null;
    }
}

module.exports = {
    initWebSocket,
    getLivePrice,
    closeWebSocket
};
