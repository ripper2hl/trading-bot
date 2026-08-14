# Contrato de nombres — NO MODIFICAR sin autorización explícita

Este archivo es la fuente de verdad para nombres de variables de entorno del bot. Ninguna herramienta de IA debe renombrarlos, "mejorarlos" ni sugerir alternativas sin autorización explícita del usuario en esta misma conversación.

Regla: antes de tocar cualquier archivo que lea process.env o config/constants.js, LEÉ ESTE ARCHIVO PRIMERO. Si un nombre no está aquí y se necesita agregar uno nuevo, DETENÉTE y consultale al usuario antes de tocar el código.

## Inventario completo y verificado del bot

| Variable | Uso | ¿Está definida en .env real? | ¿Qué pasa si falta en .env? |
|---|---|---|---|
| BINANCE_API_KEY | API key de Binance | Sí | Se valida como obligatorio; no hay default seguro |
| BINANCE_API_SECRET | API secret de Binance | Sí | Se valida como obligatorio; no hay default seguro |
| TELEGRAM_BOT_TOKEN | Token del bot de Telegram | Sí | Se valida como obligatorio para notificaciones |
| TELEGRAM_CHAT_ID | Chat ID de destino en Telegram | Sí | Se valida como obligatorio para notificaciones |
| BUY_PERCENT | % de caída para comprar | No | Default 1 |
| SELL_PERCENT | % de suba objetivo para vender | No | Default 2 |
| STOP_LOSS_PERCENT | % de stop-loss por posición | No | Default 2 |
| TAKE_PROFIT_PERCENT | % de take-profit por posición | No | Default 5 |
| MAX_POSITION_PERCENT | % máximo de balance por orden individual | No | Default 5 |
| DRAWDOWN_KILL_PERCENT | % de drawdown que activa el kill-switch | No | Default 10 |
| FEE_RATE | Tasa de fee de Binance | No | Default 0.001 |
| POLL_INTERVAL_MS | Intervalo de polling del bot | No | Default 10000 |
| TRAILING_TP_PERCENT | Trailing take-profit | No | Default 0 |
| DRY_RUN | Activa modo simulación sin órdenes reales | Sí | Default false |
| GRID_STOP_LOSS_ENABLED | Habilita stop-loss tipo grid | No | Default false |
| GRID_STOP_LOSS_PERCENT | % de stop-loss del grid | No | Default 0.6 |
| GRID_STOP_LOSS_FIFO | Orden FIFO para grid stop-loss | No | Default false |
| NOTIFY_TELEGRAM_ENABLED | Habilita notificaciones de Telegram | Sí | Default false |
| NOTIFY_TELEGRAM_ON | Qué eventos notificar por Telegram | No | Default '' |
| SELL_ALL_ON_START | Vender todo al iniciar | No | Default false |
| SELL_ALL_ON_CLOSE | Vender todo al cerrar | No | Default false |
| START_AGAIN | Reiniciar flujo/estado | No | Default false |
| WITHDRAW_PROFITS_ENABLED | Habilita retiro automático de ganancias | No | Default false |
| MIN_WITHDRAW_AMOUNT | Mínimo para retirar ganancias | No | Default 0 |
| DEFAULT_WITHDRAW_NETWORK | Red por defecto para retiros | No | Default '' |
| WITHDRAW_ADDRESS_BUSD | Dirección de retiro BUSD | No | Default '' |
| WITHDRAW_ADDRESS_USDT | Dirección de retiro USDT | No | Default '' |
| USE_TESTNET | Usar Binance testnet | No | Default false |
| TEST_MODE | Modo test del bot | No | Default false, o true si NODE_ENV === 'test' |

## Variables de entorno detectadas por runtime / librerías (no forman parte del contrato del bot)

Estas aparecen en el grep general de `process.env` porque son usadas por Node o dotenv, pero no son configuraciones del bot ni deberían renombrarse como parte del negocio del trading:

- ARM_VERSION
- DEBUG
- DEBUG_FD
- DEBUG_MIME
- DOTENV_CONFIG_DEBUG
- DOTENV_CONFIG_DOTENV_KEY
- DOTENV_CONFIG_ENCODING
- DOTENV_CONFIG_OVERRIDE
- DOTENV_CONFIG_PATH
- DOTENV_KEY
- ELECTRON_RUN_AS_NODE
- GRACEFUL_FS_PLATFORM
- HOME
- HTTP_PROXY
- HTTPS_PROXY
- INVALID
- LIBC
- NODE_DEBUG
- NODE_ENV
- NODE_NDEBUG
- NO_DEPRECATION
- NO_PROXY
- NOTIFY_TELEGRAM_ON
- POLL_INTERVAL_MS
- PREBUILDS_ONLY
- READABLE_STREAM
- SELL_ALL_ON_CLOSE
- SELL_ALL_ON_START
- START_AGAIN
- TEST_GRACEFUL_FS_GLOBAL_PATCH
- TESTING_TAR_FAKE_PLATFORM
- TRACE_DEPRECATION
- USER

## Fuente de verdad

Última verificación: 2026-08-14.
- .env real revisado con: `grep -E '^[A-Z_]+=' .env | cut -d'=' -f1 | sort`
- inventory del código revisado con: `grep -rhoE 'process\.env\.[A-Z_]+' --include='*.js' . | sort -u`

Si hay que agregar más variables de configuración del bot, solo se hace con autorización explícita del usuario; no se inventan ni se "mejoran" nombres a cargo de herramientas de IA.
