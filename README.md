# Trading Bot

Bot de trading automatizado con estrategia de grid para operar en Binance.

## Características

- **Grid Trading**: Compra en caídas y vende en rebotes con porcentajes configurables.
- **Trailing Take-Profit**: Opción de seguir el precio al alza antes de vender.
- **Gestión de riesgo**: Stop-loss global, take-profit global, kill-switch por drawdown, y stop-loss individual por orden de grid.
- **Modo DRY-RUN**: Simula todas las operaciones sin ejecutar órdenes reales.
- **Testnet**: Soporte para el testnet de Binance.
- **Notificaciones**: Alertas a Telegram en compras, ventas y eventos de riesgo.
- **Retiros automáticos**: Retiro de ganancias al alcanzar el take-profit.
- **Crash recovery**: Reconciliación de órdenes pendientes al reiniciar (ledger SQLite).
- **Logs estructurados**: Archivos JSON diarios en `logs/`.

## Requisitos

- Node.js 14+
- Cuenta de Binance con API habilitada
- (Opcional) Bot de Telegram para notificaciones

## Instalación

```sh
git clone https://github.com/tu-usuario/trading-bot.git
cd trading-bot
npm install
```

## Configuración

Copia el archivo de ejemplo y edita tus valores:

```sh
cp .env.example .env
```

### Variables de entorno

Todas las variables se configuran en `.env`. El archivo `.env.example` contiene la lista completa con comentarios descriptivos.

#### Credenciales

| Variable | Requerida | Descripción |
|----------|-----------|-------------|
| `BINANCE_API_KEY` | ✅ | API Key de Binance |
| `BINANCE_API_SECRET` | ✅ | API Secret de Binance |
| `TELEGRAM_BOT_TOKEN` | ❌ | Token del bot de Telegram |
| `TELEGRAM_CHAT_ID` | ❌ | Chat ID de Telegram |

#### Modo de ejecución

| Variable | Default | Descripción |
|----------|---------|-------------|
| `DRY_RUN` | `true` | Simular órdenes sin ejecutarlas |
| `USE_TESTNET` | `false` | Usar testnet de Binance |

#### Parámetros de trading

| Variable | Default | Descripción |
|----------|---------|-------------|
| `BUY_PERCENT` | `1` | % de caída de precio para comprar |
| `SELL_PERCENT` | `2` | % de ganancia neta objetivo por orden |
| `FEE_RATE` | `0.001` | Tasa de comisión (0.1%) |

#### Gestión de riesgo

| Variable | Default | Descripción |
|----------|---------|-------------|
| `STOP_LOSS_PERCENT` | `2` | % de pérdida global para detener el bot |
| `TAKE_PROFIT_PERCENT` | `5` | % de ganancia global para cerrar |
| `MAX_POSITION_PERCENT` | `5` | % máximo del balance en órdenes abiertas |
| `DRAWDOWN_KILL_PERCENT` | `10` | % de drawdown para activar kill-switch |

#### Trailing Take-Profit

| Variable | Default | Descripción |
|----------|---------|-------------|
| `TRAILING_TP_PERCENT` | `0` | % de retroceso desde pico para vender (`0` = deshabilitado) |

#### Stop-Loss de Grid

| Variable | Default | Descripción |
|----------|---------|-------------|
| `GRID_STOP_LOSS_ENABLED` | `false` | Habilitar SL individual por orden |
| `GRID_STOP_LOSS_PERCENT` | `0.6` | % de caída desde precio de compra para SL |
| `GRID_STOP_LOSS_FIFO` | `false` | `true` = FIFO, `false` = LIFO |

#### Notificaciones

| Variable | Default | Descripción |
|----------|---------|-------------|
| `NOTIFY_TELEGRAM_ENABLED` | `false` | Habilitar notificaciones de Telegram |
| `NOTIFY_TELEGRAM_ON` | `""` | Eventos a notificar: `buy,sell,risk,withdraw` |

#### Ciclo de vida

| Variable | Default | Descripción |
|----------|---------|-------------|
| `SELL_ALL_ON_START` | `false` | Vender todo el saldo base al iniciar |
| `SELL_ALL_ON_CLOSE` | `false` | Vender todo al cerrar (por TP/SL) |
| `START_AGAIN` | `false` | Reiniciar después de un retiro exitoso |

#### Retiros

| Variable | Default | Descripción |
|----------|---------|-------------|
| `WITHDRAW_PROFITS_ENABLED` | `false` | Habilitar retiros automáticos |
| `MIN_WITHDRAW_AMOUNT` | `0` | Ganancia mínima para ejecutar retiro |
| `DEFAULT_WITHDRAW_NETWORK` | `""` | Red de retiro (ej: `BSC`, `ETH`, `TRX`) |
| `WITHDRAW_ADDRESS_BUSD` | `""` | Dirección de retiro para BUSD |
| `WITHDRAW_ADDRESS_USDT` | `""` | Dirección de retiro para USDT |

#### Rendimiento

| Variable | Default | Descripción |
|----------|---------|-------------|
| `POLL_INTERVAL_MS` | `10000` | Intervalo entre ciclos del bot (ms, mínimo 1000) |

## Uso

```sh
npm start <moneda_base> <moneda_cotizacion> <cantidad>
```

| Argumento | Ejemplo | Descripción |
|-----------|---------|-------------|
| `moneda_base` | `ETH` | Moneda a operar |
| `moneda_cotizacion` | `USDT` | Moneda estable de cotización |
| `cantidad` | `40` | Dólares por orden de compra |

### Ejemplo

```sh
# Operar ETH/USDT con $40 por compra
npm start ETH USDT 40

# Reanudar después de un reinicio
npm start ETH USDT 40 resume
```

## Estructura del proyecto

```
trading-bot/
├── app.js                   # Entry point y bucle principal
├── config/
│   └── constants.js         # Centralización de variables de entorno
├── controllers/
│   └── tradingEngine.js     # Lógica de compra/venta, trailing TP
├── services/
│   ├── binance.js           # Cliente de Binance API
│   ├── exchange.js          # Órdenes, consultas, retiros
│   ├── ledger.js            # Ledger SQLite de intents
│   ├── state.js             # Estado local (node-storage)
│   └── TelegramNotify.js    # Notificaciones de Telegram
├── utils/
│   ├── logger.js            # Logging con color + archivos diarios
│   └── network.js           # Sleep + backoff exponencial
├── tests/                   # Tests unitarios
├── data/                    # Estado runtime (JSON + SQLite)
└── logs/                    # Logs diarios (YYYY-MM-DD.log)
```

## Tests

```sh
npm test
```

## Licencia

ISC