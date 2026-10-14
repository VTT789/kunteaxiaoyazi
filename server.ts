import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import zlib from 'zlib';
import crypto from 'crypto';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const ROOT_DIR = process.cwd();
const DEFAULT_SHEET_ID = '1DDDP-Xjtb5kzTM_3HZxcoxtX4fGUtZJ2ARn1qaj5uMo';

// Cache compressed index.html and pinyin-pro.js in memory for instant delivery
let cachedIndexMtime = 0;
let cachedIndexGzip: Buffer | null = null;
let cachedIndexRaw: Buffer | null = null;

function getIndexBuffers(indexPath: string) {
  const stat = fs.statSync(indexPath);
  if (stat.mtimeMs !== cachedIndexMtime || !cachedIndexGzip || !cachedIndexRaw) {
    cachedIndexRaw = fs.readFileSync(indexPath);
    cachedIndexGzip = zlib.gzipSync(cachedIndexRaw, { level: 6 });
    cachedIndexMtime = stat.mtimeMs;
  }
  return { raw: cachedIndexRaw, gzip: cachedIndexGzip };
}

let cachedPinyinRaw: Buffer | null = null;
let cachedPinyinGzip: Buffer | null = null;
function getPinyinBuffers() {
  if (!cachedPinyinRaw || !cachedPinyinGzip) {
    const pPath = path.join(ROOT_DIR, 'static/pinyin-pro.js');
    cachedPinyinRaw = fs.readFileSync(pPath);
    cachedPinyinGzip = zlib.gzipSync(cachedPinyinRaw, { level: 6 });
  }
  return { raw: cachedPinyinRaw, gzip: cachedPinyinGzip };
}

const FALLBACK_VOICES = [
  'zh-CN-XiaoxiaoNeural',
  'zh-CN-XiaoyiNeural',
  'zh-CN-liaoning-XiaobeiNeural',
  'zh-CN-shaanxi-XiaoniNeural',
  'zh-CN-YunjianNeural',
  'zh-CN-YunxiNeural',
  'zh-CN-YunxiaNeural',
  'zh-CN-YunyangNeural',
  'zh-HK-HiuGaaiNeural',
  'zh-HK-HiuMaanNeural',
  'zh-HK-WanLungNeural',
  'zh-TW-HsiaoChenNeural',
  'zh-TW-HsiaoYuNeural',
  'zh-TW-YunJheNeural',
  'km-KH-SreymomNeural',
  'km-KH-PisethNeural',
];

// Serve gzipped pinyin-pro.js with long-lived immutable caching
app.get('/static/pinyin-pro.js', (req: Request, res: Response) => {
  try {
    const { raw, gzip } = getPinyinBuffers();
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.setHeader('Vary', 'Accept-Encoding');
    const acceptEncoding = String(req.headers['accept-encoding'] || '');
    if (acceptEncoding.includes('gzip')) {
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', String(gzip.length));
      return res.send(gzip);
    }
    res.setHeader('Content-Length', String(raw.length));
    return res.send(raw);
  } catch {
    return res.status(404).end();
  }
});

// Serve config.js with no-cache so sheet ID updates take effect immediately
app.get('/static/config.js', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(ROOT_DIR, 'static/config.js'));
});

// Serve static assets with strong caching for large fonts and images
app.get(
  '/static/Fonts/Chinese/Founder%20Bold%20Round%20Simplified.woff2',
  (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.sendFile(
      path.join(
        ROOT_DIR,
        'static/Fonts/Chinese/Founder Bold Round Simplified, Hanyi Amber Simplified.woff2'
      )
    );
  }
);
app.use(
  '/static/Fonts',
  express.static(path.join(ROOT_DIR, 'static/Fonts'), {
    maxAge: '7d',
    immutable: true,
  })
);
app.use(
  '/static',
  express.static(path.join(ROOT_DIR, 'static'), {
    maxAge: '7d',
    immutable: true,
  })
);
if (fs.existsSync(path.join(ROOT_DIR, 'public'))) {
  app.use(express.static(path.join(ROOT_DIR, 'public')));
}

function formatRate(rate: unknown): string {
  if (rate === undefined || rate === null || rate === '') {
    return '+0%';
  }
  const clean = String(rate).replace(/%/g, '').trim();
  if (!clean || clean === '0' || clean === '+0' || clean === '-0') {
    return '+0%';
  }
  const num = parseFloat(clean);
  if (isNaN(num) || num === 0) {
    return '+0%';
  }
  return num > 0 ? `+${num}%` : `${num}%`;
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const EDGE_TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_WSS_PRIMARY =
  'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1';
const EDGE_VOICES_PRIMARY = `https://api.msedgeservices.com/tts/cognitiveservices/voices/list?Ocp-Apim-Subscription-Key=${EDGE_TRUSTED_CLIENT_TOKEN}`;

function generateSecMsGec(): string {
  let ticks = Math.floor(Date.now() / 1000) + 11644473600;
  ticks -= ticks % 300;
  const winTicks = BigInt(ticks) * 10000000n;
  const strToHash = `${winTicks.toString()}${EDGE_TRUSTED_CLIENT_TOKEN}`;
  return crypto
    .createHash('sha256')
    .update(strToHash, 'ascii')
    .digest('hex')
    .toUpperCase();
}

function getEdgeSynthUrl(): string {
  const reqId = crypto.randomUUID().replace(/-/g, '');
  const secMsGEC = generateSecMsGec();
  return `${EDGE_WSS_PRIMARY}?Ocp-Apim-Subscription-Key=${EDGE_TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGEC}&Sec-MS-GEC-Version=1-143.0.3650.96&ConnectionId=${reqId}`;
}

// Configure MsEdgeTTS to use Microsoft's active api.msedgeservices.com endpoint
(MsEdgeTTS as unknown as Record<string, unknown>).WSS_URL = EDGE_WSS_PRIMARY;
(MsEdgeTTS as unknown as Record<string, unknown>).VOICES_URL =
  EDGE_VOICES_PRIMARY;
(MsEdgeTTS as unknown as Record<string, unknown>).getSynthUrl =
  async function () {
    return getEdgeSynthUrl();
  };

const ttsAudioCache = new Map<string, Buffer>();
const MAX_TTS_CACHE_ENTRIES = 300;

async function synthesizeEdgeTtsSingle(
  text: string,
  voice: string,
  rate: string
): Promise<Buffer> {
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(
      voice,
      OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
      {}
    );
    const { audioStream } = tts.toStream(escapeXml(text), {
      rate: formatRate(rate),
    });

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        audioStream.destroy(new Error('Edge TTS stream timed out'));
        reject(new Error('Edge TTS stream timed out'));
      }, 12000);

      audioStream.on('data', (chunk: Buffer | Uint8Array) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      audioStream.once('end', () => {
        clearTimeout(timeout);
        resolve();
      });
      audioStream.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
      audioStream.once('error', (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    const fullBuffer = Buffer.concat(chunks);
    if (fullBuffer.length < 200) {
      throw new Error('Generated audio buffer too small');
    }
    return fullBuffer;
  } finally {
    try {
      tts.close();
    } catch {
      // ignore close errors
    }
  }
}

async function synthesizeEdgeTtsBuffer(
  text: string,
  voice: string,
  rate: string
): Promise<Buffer> {
  const formattedRate = formatRate(rate);
  const cacheKey = `${voice}|${formattedRate}|${text}`;
  const cached = ttsAudioCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // First attempt, retry once on error before falling back
  let buffer: Buffer;
  try {
    buffer = await synthesizeEdgeTtsSingle(text, voice, formattedRate);
  } catch {
    buffer = await synthesizeEdgeTtsSingle(text, voice, formattedRate);
  }

  if (ttsAudioCache.size >= MAX_TTS_CACHE_ENTRIES) {
    const oldestKey = ttsAudioCache.keys().next().value;
    if (oldestKey) {
      ttsAudioCache.delete(oldestKey);
    }
  }
  ttsAudioCache.set(cacheKey, buffer);
  return buffer;
}

async function synthesizeFallbackTtsBuffer(
  text: string,
  voice: string
): Promise<Buffer> {
  const lowerVoice = voice.toLowerCase();
  const tl = lowerVoice.startsWith('km')
    ? 'km'
    : lowerVoice.startsWith('zh-hk')
    ? 'zh-HK'
    : lowerVoice.startsWith('zh-tw')
    ? 'zh-TW'
    : 'zh-CN';
  const url = `https://translate.googleapis.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(
    tl
  )}&q=${encodeURIComponent(text)}`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  });
  if (!resp.ok) {
    throw new Error(`Fallback TTS HTTP ${resp.status}`);
  }
  const arrayBuf = await resp.arrayBuffer();
  return Buffer.from(arrayBuf);
}

// Home route (with in-memory gzip compression for instant HTML load)
app.get('/', (req: Request, res: Response) => {
  const indexPath = path.join(ROOT_DIR, 'index.html');
  try {
    const { raw, gzip } = getIndexBuffers(indexPath);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Vary', 'Accept-Encoding');
    const acceptEncoding = String(req.headers['accept-encoding'] || '');
    if (acceptEncoding.includes('gzip')) {
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', String(gzip.length));
      return res.send(gzip);
    }
    res.setHeader('Content-Length', String(raw.length));
    return res.send(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).send(`index.html error: ${msg}`);
  }
});

// Shared vocabulary fetch logic for /get_vocab and /api/sheet-data
async function handleGetVocab(req: Request, res: Response) {
  const customId = typeof req.query.id === 'string' ? req.query.id.trim() : '';
  const sheetId =
    customId ||
    process.env.GOOGLE_SHEETID ||
    process.env.SHEET_ID ||
    DEFAULT_SHEET_ID;
  const apiKey = process.env.GOOGLE_API_KEY;

  if (!sheetId) {
    return res.status(500).json({ error: 'GOOGLE_SHEETID not set' });
  }

  if (apiKey) {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1?key=${apiKey}`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        throw new Error(`Google Sheets API HTTP ${resp.status}`);
      }
      const data = (await resp.json()) as { values?: string[][] };
      const values = data.values || [];
      if (values.length === 0) {
        return res.status(404).json({ error: 'No data found in sheet' });
      }
      const headers = values[0];
      const result = values.slice(1).map((row) => {
        const padded = [...row];
        while (padded.length < headers.length) {
          padded.push('');
        }
        const rowDict: Record<string, string> = {};
        for (let i = 0; i < headers.length; i++) {
          rowDict[headers[i]] = padded[i];
        }
        return rowDict;
      });
      return res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: `Google API error: ${msg}` });
    }
  }

  const url = `https://opensheet.elk.sh/${sheetId}/Sheet1`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`opensheet HTTP ${resp.status}`);
    }
    const data = await resp.json();
    return res.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: `Sheet fetch failed: ${msg}` });
  }
}

app.get('/get_vocab', handleGetVocab);
app.get('/api/sheet-data', handleGetVocab);

// Speak route (GET and POST)
async function handleSpeak(req: Request, res: Response) {
  try {
    const source = req.method === 'POST' ? req.body : req.query;
    const text = String(source?.text ?? '').trim();
    const voice =
      String(source?.voice ?? '').trim() || 'zh-TW-HsiaoChenNeural';
    const defaultRate = voice.toLowerCase().startsWith('zh') ? '-15%' : '+0%';
    const rate = String(source?.rate ?? defaultRate).trim();

    if (!text) {
      return res.status(400).json({ error: 'No text provided' });
    }

    let audioBuffer: Buffer;
    try {
      audioBuffer = await synthesizeEdgeTtsBuffer(text, voice, rate);
    } catch (edgeErr) {
      console.warn(
        'Edge TTS failed, falling back to Google TTS:',
        edgeErr instanceof Error ? edgeErr.message : edgeErr
      );
      audioBuffer = await synthesizeFallbackTtsBuffer(text, voice);
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', String(audioBuffer.length));
    res.setHeader('Cache-Control', 'no-store');
    return res.send(audioBuffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('TTS error:', msg);
    return res.status(500).json({ error: msg });
  }
}

app.get('/speak', handleSpeak);
app.post('/speak', handleSpeak);

// Health check route
app.get('/test', (_req: Request, res: Response) => {
  res.json({ status: 'healthy' });
});

// Voices route
app.get('/voices', async (_req: Request, res: Response) => {
  try {
    const tts = new MsEdgeTTS();
    const voices = await tts.getVoices();
    const shortNames = Array.isArray(voices)
      ? voices
          .map((v) => v.ShortName)
          .filter((name): name is string => Boolean(name))
      : [];

    const combined = Array.from(new Set([...shortNames, ...FALLBACK_VOICES]));
    return res.json({
      count: combined.length,
      voices: combined,
    });
  } catch {
    return res.json({
      count: FALLBACK_VOICES.length,
      voices: FALLBACK_VOICES,
    });
  }
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Vocab Master server running on http://0.0.0.0:${PORT}`);
});
