#!/bin/bash
# Configurações
PLAYLIST_ID="990fd5fe-70d2-449b-8a4d-3cb0a7d3e805"
API_URL="http://localhost:3001/api/suno/playlist/${PLAYLIST_ID}"
IMAGE_BACKGROUND="fundo_live.png"
RTMP_DESTINATION="rtmp://a.rtmp.youtube.com/live2/${STREAM_KEY_YOUTUBE}"

# Gera imagem padrão caso não exista
if [ ! -f "$IMAGE_BACKGROUND" ]; then
    ffmpeg -f lavfi -i color=c=0x0f172a:s=1280x720:d=1 -vframes 1 "$IMAGE_BACKGROUND" -y
fi

echo "[Live Stream] Buscando URLs do CDN da Suno..."

while true; do
    # 1. Obtém URLs dos arquivos .mp4 da playlist via API
    curl -s "$API_URL" | jq -r '.tracks[].audio_url' | shuf > /tmp/suno_stream_list.txt

    # 2. Constrói a lista em formato concat para o FFmpeg
    sed -i "s|^|file '|" /tmp/suno_stream_list.txt
    sed -i "s|$|'|" /tmp/suno_stream_list.txt

    TOTAL=$(wc -l < /tmp/suno_stream_list.txt)
    echo "[Live Stream] ${TOTAL} faixas no loop da transmissão."

    # 3. Transmissão 24/7 direto do CDN para o YouTube sem salvar nada em disco
    ffmpeg -loop 1 -framerate 25 -i "$IMAGE_BACKGROUND" \
        -re -f concat -safe 0 -protocol_whitelist file,http,https,tcp,tls -i /tmp/suno_stream_list.txt \
        -c:v libx264 -preset veryfast -b:v 2500k -maxrate 2500k -bufsize 5000k \
        -pix_fmt yuv420p -r 25 -g 100 -keyint_min 100 -sc_threshold 0 \
        -c:a aac -b:a 192k -ar 44100 \
        -f flv "$RTMP_DESTINATION"

    echo "[Live Stream] Reiniciando playlist em 5 segundos..."
    sleep 5
done
