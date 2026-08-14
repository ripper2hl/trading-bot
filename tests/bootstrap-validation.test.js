process.env.TEST_MODE = 'true'

const assert = require('node:assert/strict')

const originalArgv = process.argv.slice()
const originalEnv = { ...process.env }

try {
  process.argv = ['node', 'app.js', 'ETH', 'BUSD', '40']
  process.env.API_KEY = 'abc123'
  process.env.API_SECRET = 'secret456'
  process.env.BUY_PERCENT = '1'
  process.env.STOP_LOSS_BOT = '2'
  process.env.TAKE_PROFIT_BOT = '5'

  const { validateBootstrapConfig, BUY_PERCENT, STOP_LOSS_BOT, TAKE_PROFIT_BOT, DRAWDOWN_KILL_PERCENT } = require('../config/constants')
  const result = validateBootstrapConfig()

  assert.equal(result.ok, true, 'La validación de arranque debería aceptar un config válido')
  assert.equal(result.errors.length, 0, 'No debería haber errores con un config válido')
  assert.equal(typeof BUY_PERCENT, 'number', 'BUY_PERCENT debe exportarse como número')
  assert.equal(typeof STOP_LOSS_BOT, 'number', 'STOP_LOSS_BOT debe exportarse como número')
  assert.equal(typeof TAKE_PROFIT_BOT, 'number', 'TAKE_PROFIT_BOT debe exportarse como número')
  assert.equal(typeof DRAWDOWN_KILL_PERCENT, 'number', 'DRAWDOWN_KILL_PERCENT debe exportarse como número')
  console.log('bootstrap validation ok')
} catch (err) {
  console.error('FAILED:', err.message)
  process.exit(1)
} finally {
  process.argv = originalArgv
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key]
  }
  for (const key of Object.keys(originalEnv)) {
    process.env[key] = originalEnv[key]
  }
}
