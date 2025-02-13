# Trading Bot

Este es un bot de trading automatizado para operar en la plataforma Binance.

## Requerimientos previos

Antes de comenzar, asegúrate de tener los siguientes requisitos:

- Node.js (versión 14 o superior)
- Una cuenta en Binance
- Claves API de Binance (API Key y Secret Key)

## Instalación

1. Clona este repositorio:
   ```sh
   git clone https://github.com/tu-usuario/trading-bot.git
   cd trading-bot

2. Instala las dependencias:

    ```sh
    npm install
    ```

3. Crea un archivo .env en la raíz del proyecto y agrega tus claves API de Binance:

    ```sh
    API_KEY=tu_api_key
    API_SECRET=tu_api_secret
    ```

## Instrucciones de uso
Para iniciar el bot, utiliza el siguiente comando:

```sh
npm start <moneda_base> <moneda_cotizacion> <cantidad>
```

Donde:

`<moneda_base>`: La moneda en la que queremos operar (por ejemplo, ETH).

`<moneda_cotizacion>`: La moneda basada en dólares (estable) en la que queremos operar (por ejemplo, BUSD).

`<cantidad>`: La cantidad de dólares que invertiremos en cada operación de compra.


## Ejemplo
Para operar con ETH y BUSD, invirtiendo 40 dólares en cada operación de compra, usa el siguiente comando:

```sh
npm start ETH BUSD 40
```