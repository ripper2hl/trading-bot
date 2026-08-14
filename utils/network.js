/**
 * utils/network.js
 * Utilidades de resiliencia de red: exponential backoff para rate-limits y errores de conectividad.
 */
const { logColor, colors } = require('./logger')

const sleep = (timeMs) => new Promise(resolve => setTimeout(resolve, timeMs))

/**
 * Reintenta una funcion async con pausas exponenciales ante errores de red o rate-limit (429/418).
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

module.exports = {
    withBackoff,
    sleep,
}
