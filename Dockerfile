FROM node:22-slim

# Establecer directorio de trabajo
WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias de compilacion para better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Instalar dependencias
RUN npm ci --only=production

# Copiar el resto del codigo de la aplicacion
COPY . .

# Crear carpetas de volumen por defecto por si no se montan
RUN mkdir -p data logs

# Comando por defecto (puede ser sobreescrito al correr el contenedor)
CMD ["node", "app.js", "BTC", "USDT", "15"]
