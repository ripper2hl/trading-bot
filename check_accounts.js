require('dotenv').config({ path: './.env' });
const Binance = require('binance-api-node').default;

async function run() {
    try {
        const client1 = Binance({
            apiKey: 'Femqq82AJuinPMB0BJop4TiAOIqd8jrHki1nTUrf7JW2ieZ8ueO6R4tG6XzkYS3p',
            apiSecret: 'Q7Tom4O6j7k4wJh2lqBo55AoVHGJ5ymukf3MiGKCh6QOoJDptFFqwJLybcyH3cBk',
            httpBase: 'https://testnet.binance.vision',
            getTime: () => Date.now(),
        });
        
        const client2 = Binance({
            apiKey: 'kZL3NHmlgHlAEkFmT4uL65A4iZtAL40qDZ2yEIthvQcfY1p80zrHPsKcMWmZtr9x',
            apiSecret: 'mfkjCknGgGXttbe4lWyX3DxsN0TOkEOngAxDNBPNfWpFrkxNrx1u4oKjIFFTWf0t',
            httpBase: 'https://testnet.binance.vision',
            getTime: () => Date.now(),
        });

        console.log("Realizando la Prueba del Trade ID (Huella Criptográfica)...");
        
        const trades1 = await client1.myTrades({ symbol: 'BTCUSDT', limit: 5 });
        const trades2 = await client2.myTrades({ symbol: 'BTCUSDT', limit: 5 });

        const ids1 = trades1.map(t => t.id).join(',');
        const ids2 = trades2.map(t => t.id).join(',');

        console.log("Client 1 Last 5 Trade IDs:", ids1);
        console.log("Client 2 Last 5 Trade IDs:", ids2);
        
        if (ids1 === ids2 && ids1 !== "") {
            console.log("BINGO: Las huellas de los trades coinciden al 100%. Ambas API keys apuntan a la MISMA cuenta.");
        } else {
            console.log("Las cuentas son distintas, los historiales de trades no coinciden.");
        }
    } catch(e) {
        console.error("Error al ejecutar la prueba:", e.message);
    }
}

run();
