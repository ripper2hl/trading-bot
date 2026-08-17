const assert = require('assert')
const { calculateATR } = require('../app.js')
const Decimal = require('../utils/decimal')

try {
    // TEST 1
    assert.strictEqual(calculateATR([]).toNumber(), 0)
    assert.strictEqual(calculateATR(null).toNumber(), 0)
    assert.strictEqual(calculateATR(undefined).toNumber(), 0)
    console.log('PASS: TEST 1 - calculateATR maneja arreglos vacíos o nulos')

    // TEST 2
    const validCandle1 = { high: "63145.15000000", low: "63140.05000000", close: "63140.06000000" }
    const validCandle2 = { high: "63190.00000000", low: "63140.05000000", close: "63182.01000000" }
    const validCandle3 = { high: "63220.00000000", low: "63182.00000000", close: "63219.99000000" }
    // Necesitamos al menos 6 velas para tener 5 TRs
    const klines = [validCandle1, validCandle2, validCandle3, validCandle1, validCandle2, validCandle3]

    const atr = calculateATR(klines)
    assert.ok(atr.isFinite(), 'ATR no debe ser NaN o Infinity')
    assert.ok(atr instanceof Decimal, 'ATR debe ser un objeto Decimal')
    assert.ok(atr.greaterThan(0), 'ATR debe ser positivo')
    console.log('PASS: TEST 2 - calculateATR procesa correctamente strings reales de Binance (min 5 TRs)')

    // TEST 3 - Escenario masivo de data corrupta (15 velas, 12 corruptas, 3 validas)
    const corruptKlines = Array(15).fill({ high: undefined, low: undefined, close: undefined })
    corruptKlines[0] = validCandle1
    corruptKlines[1] = validCandle2
    corruptKlines[2] = validCandle3

    const corruptAtr = calculateATR(corruptKlines)
    assert.strictEqual(corruptAtr.toNumber(), 0, 'ATR debe ser 0 si no se alcanza el minimo de 5 TRs validos')
    console.log('PASS: TEST 3 - calculateATR retorna 0 si la mayoria de la data esta corrupta (menos de 5 TRs)')

} catch (e) {
    console.error('FAIL ATR Test:', e)
    process.exit(1)
}
