require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const cors = require('cors');
const { spawn } = require('child_process');
const Replicate = require('replicate');

let streamProcess = null;
let streamStatus = { running: false, pid: null, startedAt: null, lastLog: '' };

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/storage', express.static(path.join(__dirname, 'storage')));

const upload = multer({ dest: path.join(__dirname, 'temp') });

function getDriveClient() {
    const keyFile = path.resolve(__dirname, process.env.GOOGLE_APPLICATION_CREDENTIALS || 'credentials.json');
    if (!fs.existsSync(keyFile)) return null;
    const auth = new google.auth.GoogleAuth({
        keyFile,
        scopes: ['https://www.googleapis.com/auth/drive.file']
    });
    return google.drive({ version: 'v3', auth });
}

// 1. Listar faixas locais
app.get('/api/tracks', (req, res) => {
    const dir = path.join(__dirname, 'storage');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.mp3'));
    const tracks = files.map(file => {
        const stats = fs.statSync(path.join(dir, file));
        return {
            name: file,
            size: (stats.size / (1024 * 1024)).toFixed(2) + ' MB',
            created: stats.mtime,
            url: `/storage/${file}`
        };
    });
    res.json(tracks);
});

// Endpoint para buscar playlist do Suno
app.get('/api/suno/playlist/:id', async (req, res) => {
    try {
        const playlistId = req.params.id;
        const token = process.env.SUNO_API_KEY;

        const headers = {
            'Origin': 'https://suno.com',
            'Referer': 'https://suno.com/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        };
        if (token && token.startsWith('eyJ')) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        const sunoRes = await axios.get(`https://studio-api.prod.suno.com/api/playlist/${playlistId}`, { headers });
        const data = sunoRes.data;

        const tracks = (data.playlist_clips || []).map(item => {
            const clip = item.clip || {};
            return {
                id: clip.id,
                title: clip.title || 'Sem título',
                display_name: clip.display_name || clip.handle || 'Suno Artist',
                image_url: clip.image_url || clip.image_large_url,
                duration: clip.metadata?.duration ? Math.round(clip.metadata.duration) : null,
                tags: clip.metadata?.tags || clip.display_tags || '',
                audio_url: clip.video_url || `https://cdn1.suno.ai/${clip.id}.mp4`
            };
        });

        res.json({
            id: data.id,
            name: data.name,
            description: data.description,
            image_url: data.image_url,
            song_count: data.song_count || tracks.length,
            tracks
        });
    } catch (err) {
        res.status(500).json({ error: err.response?.data || err.message });
    }
});

// 2. Upload manual de arquivo de áudio
app.post('/api/upload', upload.single('audio'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    const target = path.join(__dirname, 'storage', req.file.originalname);
    fs.renameSync(req.file.path, target);
    res.json({ message: 'Arquivo salvo com sucesso!', name: req.file.originalname });
});

// Função para gerar música via Replicate (MusicGen)
async function gerarPeloReplicate(promptTexto, outputPath) {
    const replicate = new Replicate({
        auth: process.env.REPLICATE_API_TOKEN
    });

    const modelVersion = process.env.REPLICATE_MODEL || "meta/musicgen:671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837eedcfb";
    
    const output = await replicate.run(modelVersion, {
        input: {
            prompt: promptTexto,
            model_version: "stereo-large",
            output_format: "mp3",
            duration: 30
        }
    });

    const audioUrl = typeof output === 'string' ? output : (output?.url ? (typeof output.url === 'function' ? output.url() : output.url) : String(output));
    const response = await axios.get(audioUrl, { responseType: 'arraybuffer' });
    fs.writeFileSync(outputPath, Buffer.from(response.data));
}

// Função para gerar música via Suno (Direto pelo Token de Sessão JWT do suno.com ou Gateway)
async function gerarPeloSuno(promptTexto, outputPath) {
    const token = process.env.SUNO_API_KEY;
    const isDirectSuno = token.startsWith('eyJ'); // Token JWT extraído do suno.com

    if (isDirectSuno) {
        // Chamada direta para a API oficial de produção do Suno.com
        const createRes = await axios.post(
            'https://studio-api.prod.suno.com/api/generate/v2/',
            {
                gpt_description_prompt: promptTexto,
                mv: 'chirp-v3-5',
                prompt: '',
                make_instrumental: true
            },
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Origin': 'https://suno.com',
                    'Referer': 'https://suno.com/',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            }
        );

        const clips = createRes.data?.clips || [];
        if (!clips.length) throw new Error('Não foi possível iniciar a geração no Suno.');
        const clipId = clips[0].id;

        // Aguarda geração do áudio e extrai a URL final (CDN ou audiopipe)
        let audioUrl = null;
        for (let i = 0; i < 45; i++) {
            await new Promise(r => setTimeout(r, 4000));
            const feedRes = await axios.get(`https://studio-api.prod.suno.com/api/feed/v2?ids=${clipId}`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Origin': 'https://suno.com',
                    'Referer': 'https://suno.com/',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            const current = feedRes.data?.clips?.[0] || feedRes.data?.[0];
            const mediaList = current?.media_urls || [];
            const mp3Media = mediaList.find(m => m.content_type === 'mp3') || mediaList[0];

            if (current?.status === 'complete' && current?.audio_url && !current.audio_url.includes('forbidden')) {
                audioUrl = current.audio_url;
                break;
            } else if (mp3Media?.url) {
                audioUrl = mp3Media.url;
                break;
            }

            if (current?.status === 'error') {
                throw new Error('Erro retornado pelo Suno.');
            }
        }

        if (!audioUrl) throw new Error('Tempo limite excedido na geração do Suno.');

        const downloadRes = await axios.get(audioUrl, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            responseType: 'arraybuffer'
        });
        fs.writeFileSync(outputPath, Buffer.from(downloadRes.data));
    } else {
        // Chamada via gateway parceiro (sunoapi / musicapi)
        const sunoBaseUrl = process.env.SUNO_API_URL || 'https://api.sunoapi.com';
        const createRes = await axios.post(
            `${sunoBaseUrl}/api/v1/sonic/create`,
            { prompt: promptTexto, model_version: 'chirp-v3-5', instrumental: true },
            { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );

        const taskId = createRes.data?.task_id || createRes.data?.data?.task_id || createRes.data?.id;
        if (!taskId) throw new Error('Falha ao iniciar geração no Suno.');

        let audioUrl = null;
        for (let i = 0; i < 40; i++) {
            await new Promise(r => setTimeout(r, 4000));
            const checkRes = await axios.get(`${sunoBaseUrl}/api/v1/sonic/task/${taskId}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const status = checkRes.data?.status || checkRes.data?.data?.status;

            if (status === 'complete' || status === 'playable' || status === 'SUCCESS') {
                audioUrl = checkRes.data?.audio_url || checkRes.data?.data?.audio_url || checkRes.data?.data?.[0]?.audio_url;
                break;
            }
            if (status === 'failed' || status === 'error') throw new Error('Falha na geração do Suno.');
        }

        if (!audioUrl) throw new Error('Tempo limite excedido na geração do Suno.');
        const downloadRes = await axios.get(audioUrl, { responseType: 'arraybuffer' });
        fs.writeFileSync(outputPath, Buffer.from(downloadRes.data));
    }
}

// 3. Gerar música via IA e salvar no storage
app.post('/api/generate', async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt é obrigatório.' });

    try {
        const idUnico = Date.now();
        const nomeArquivo = `track_${idUnico}.mp3`;
        const storagePath = path.join(__dirname, 'storage', nomeArquivo);

        if (process.env.SUNO_API_KEY && process.env.SUNO_API_KEY !== 'sua_chave_suno_aqui') {
            await gerarPeloSuno(prompt, storagePath);
        } else if (process.env.REPLICATE_API_TOKEN && process.env.REPLICATE_API_TOKEN !== 'seu_token_replicate_aqui') {
            await gerarPeloReplicate(prompt, storagePath);
        } else {
            fs.writeFileSync(storagePath, Buffer.from('MOCK_AUDIO_DATA_' + prompt));
        }

        res.json({ message: 'Faixa gerada com sucesso!', name: nomeArquivo, prompt });
    } catch (err) {
        const errorMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
        res.status(500).json({ error: errorMsg });
    }
});

// 4. Sincronizar com Google Drive
app.post('/api/sync-drive/:filename', async (req, res) => {
    const filename = req.params.filename;
    const localPath = path.join(__dirname, 'storage', filename);
    if (!fs.existsSync(localPath)) return res.status(404).json({ error: 'Arquivo não encontrado.' });

    try {
        const drive = getDriveClient();
        if (!drive) return res.status(500).json({ error: 'credentials.json não encontrado.' });

        const fileMetadata = {
            name: filename,
            parents: process.env.GOOGLE_DRIVE_FOLDER_ID ? [process.env.GOOGLE_DRIVE_FOLDER_ID] : []
        };
        const media = {
            mimeType: 'audio/mpeg',
            body: fs.createReadStream(localPath)
        };
        const driveRes = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id'
        });
        res.json({ message: 'Enviado para o Google Drive com sucesso!', fileId: driveRes.data.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. Excluir faixa local
app.delete('/api/tracks/:filename', (req, res) => {
    const filePath = path.join(__dirname, 'storage', req.params.filename);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return res.json({ message: 'Faixa excluída.' });
    }
    res.status(404).json({ error: 'Arquivo não encontrado.' });
});

// 6. Controle da Transmissão ao Vivo para YouTube
app.get('/api/stream/status', (req, res) => {
    res.json(streamStatus);
});

app.post('/api/stream/start', (req, res) => {
    if (streamProcess && streamStatus.running) {
        return res.json({ message: 'Transmissão já está em andamento.', status: streamStatus });
    }

    const scriptPath = path.join(__dirname, 'stream.sh');
    streamProcess = spawn('bash', [scriptPath], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    streamStatus = {
        running: true,
        pid: streamProcess.pid,
        startedAt: new Date(),
        lastLog: 'Iniciando live...'
    };

    streamProcess.stdout.on('data', data => {
        streamStatus.lastLog = data.toString().trim().split('\n').pop();
    });

    streamProcess.stderr.on('data', data => {
        streamStatus.lastLog = data.toString().trim().split('\n').pop();
    });

    streamProcess.on('close', code => {
        streamStatus = {
            running: false,
            pid: null,
            startedAt: null,
            lastLog: `Processo encerrado com código ${code}`
        };
        streamProcess = null;
    });

    res.json({ message: 'Live iniciada com sucesso!', status: streamStatus });
});

app.post('/api/stream/stop', (req, res) => {
    if (streamProcess) {
        streamProcess.kill('SIGTERM');
        streamProcess = null;
        streamStatus.running = false;
        return res.json({ message: 'Transmissão interrompida.' });
    }
    res.json({ message: 'Nenhuma transmissão ativa.' });
});

// Inicia servidor
app.listen(PORT, () => {
    console.log(`[Plataforma de Música] Rodando em http://localhost:${PORT}`);
});
