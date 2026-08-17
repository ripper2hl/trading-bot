const Decimal = require('decimal.js')

// Configuración global para operaciones financieras.
// Precisión: 20 dígitos significativos. Es más que suficiente para manejar 
// balances grandes y precios de criptomonedas (ej. BTC con 8 decimales) sin perder precisión.
// Redondeo: ROUND_HALF_EVEN (Banker's rounding). Es el estándar financiero porque
// distribuye equitativamente el redondeo de los .5, previniendo sesgos acumulativos 
// a lo largo de miles de operaciones del bot.
Decimal.set({ 
    precision: 20, 
    rounding: Decimal.ROUND_HALF_EVEN 
})

module.exports = Decimal
