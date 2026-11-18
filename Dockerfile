FROM node:20-bookworm-slim

# Instala FFmpeg, jq e curl para o stream.sh
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    jq \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instala dependências do Node.js
COPY package*.json ./
RUN npm install --omit=dev

# Copia código da aplicação
COPY . .

# Cria diretório de armazenamento se não existir
RUN mkdir -p storage temp

EXPOSE 3001

# Inicia o servidor web
CMD ["node", "server.js"]
