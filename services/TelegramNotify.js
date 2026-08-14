const axios = require('axios').default
const urlencode = require('urlencode')

const NotifyTelegram = async (data) => {
    const b = "`"
    const content = urlencode(`

    ${b + b + b}
    ${data.from === 'buy' ? '🟢' : data.from === 'sell' ? '🔴' : '🔵'} ${data.start}
    ${b + b + b}
__Duración:__ ${data.runningTime}\\
__Mercado:__ ${data.market}\\
__Precio ${data.market1}:__ ${data.price}\\
__Saldo ${data.market1}:__ ${data.balance1}\\
__Saldo ${data.market2}:__ ${parseFloat(data.balance2).toFixed(2)}\\
__Profits:__ ${parseFloat(data.realProfits).toFixed(2)} ${data.market2} ${data.market2 < 0 ? '🔻' : '↗'}\\
    `).replace(/\./g, '\\.')

    try {
        await axios.get(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_ID}/sendMessage?chat_id=${process.env.TELEGRAM_CHAT_ID}&parse_mode=MarkdownV2&text=${content}`)
    } catch (err) {
        console.error('[ERROR TELEGRAM] No se pudo enviar notificacion:', err.message || err)
    }
}

module.exports = {
    NotifyTelegram
}