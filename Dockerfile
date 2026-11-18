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

# Script de inicialização: roda a API Node e o Stream simultaneamente
CMD ["sh", "-c", "node server.js & ./stream.sh"]
