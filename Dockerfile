FROM node:20-alpine

# Establecer directorio de trabajo
WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias de compilacion para better-sqlite3
RUN apk add --no-cache python3 make g++

# Instalar solo dependencias de produccion
RUN npm ci --only=production

# Limpiar las dependencias de compilacion para reducir peso
RUN apk del python3 make g++

# Copiar el resto del codigo de la aplicacion
COPY . .

# Crear carpetas de volumen por defecto por si no se montan
RUN mkdir -p data logs

# Comando por defecto (puede ser sobreescrito al correr el contenedor)
CMD ["node", "app.js", "BTC", "USDT", "5"]
