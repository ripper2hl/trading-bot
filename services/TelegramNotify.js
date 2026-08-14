/**
 * services/TelegramNotify.js
 * Envía notificaciones de estado al chat de Telegram configurado.
 * Las credenciales se importan desde config/constants.js (fuente unica).
 */
const axios = require('axios').default
const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = require('../config/constants')

const NotifyTelegram = async (data) => {
    const content = [
        '```',
        `${data.from === 'buy' ? '🟢' : data.from === 'sell' ? '🔴' : '🔵'} ${data.start}`,
        '```',
        `Duración: ${data.runningTime}`,
        `Mercado: ${data.market}`,
        `Precio ${data.market1}: ${data.price}`,
        `Saldo ${data.market1}: ${data.balance1}`,
        `Saldo ${data.market2}: ${parseFloat(data.balance2).toFixed(2)}`,
        `Profits: ${parseFloat(data.realProfits).toFixed(2)} ${data.market2} ${data.realProfits < 0 ? '🔻' : '↗'}`,
    ].join('\n')

    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`
        await axios.get(url, {
            params: {
                chat_id: TELEGRAM_CHAT_ID,
                text: content,
            },
            timeout: 2000,
        })
    } catch (err) {
        console.error('[ERROR TELEGRAM] No se pudo enviar notificacion:', err.message || err)
    }
}

module.exports = {
    NotifyTelegram
}