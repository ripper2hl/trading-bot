require('dotenv').config({ path: './data_testnet_2/.env' });
const client = require('./services/binance');

async function run() {
    try {
        const trades = await client.myTrades({ symbol: 'BTCUSDT', limit: 10 });
        console.log("LAST 10 TRADES:");
        console.log(JSON.stringify(trades, null, 2));
    } catch(e) {
        console.error(e);
    }
}

run();
