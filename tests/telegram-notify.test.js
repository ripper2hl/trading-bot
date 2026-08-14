process.env.TEST_MODE = 'true'

const assert = require('node:assert/strict')
const axios = require('axios').default

const originalEnv = { ...process.env }
const originalGet = axios.get

process.env.TELEGRAM_BOT_TOKEN = 'test-bot-id'
process.env.TELEGRAM_CHAT_ID = 'chat-123'

;(async () => {
  let captured = null
  axios.get = async (url, config) => {
    captured = { url, config }
    return { status: 200 }
  }

  try {
    const { NotifyTelegram } = require('../services/TelegramNotify')

    await NotifyTelegram({
      from: 'sell',
      start: '14/08/2026 12:00',
      runningTime: '00:02:00',
      market: 'ETHUSDT',
      market1: 'ETH',
      market2: 'USDT',
      price: '100',
      balance1: '1.5',
      balance2: '1500',
      realProfits: -12.5,
    })

    assert.ok(captured, 'TelegramNotify should call axios.get')
    assert.equal(captured.config.timeout, 2000)
    assert.ok(!String(captured.url).includes('parse_mode='), 'MarkdownV2 should not be used')
    assert.ok(String(captured.config.params.text).includes('🔻'), 'Negative profit must render the down emoji')
    assert.ok(!String(captured.url).includes('parse_mode=MarkdownV2'), 'parse_mode should be absent')
    console.log('PASS: Telegram notifications handle negative profits without MarkdownV2')
  } finally {
    axios.get = originalGet
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key]
    }
    for (const key of Object.keys(originalEnv)) {
      process.env[key] = originalEnv[key]
    }
  }
})().catch((err) => {
  console.error('FAIL: Telegram notifications handle negative profits without MarkdownV2')
  console.error(err.stack || err.message)
  process.exit(1)
})
