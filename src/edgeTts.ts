import crypto from 'crypto';
import WebSocket from 'ws';
import {
  generateSecMsGecV2,
  generateMuid,
  SEC_MS_GEC_VERSION,
  TRUSTED_CLIENT_TOKEN,
} from './edgeToken.ts';

interface TokenInfo {
  token: string;
  version: string;
  muid: string;
  trustedToken: string;
}

let cachedTokenInfo: TokenInfo | null = null;
let tokenExpiresAt = 0;
const TOKEN_TTL_MS = 240 * 1000; // 4 minutes

export function fetchEdgeToken(): Promise<TokenInfo> {
  const now = Date.now();
  if (cachedTokenInfo && now < tokenExpiresAt) {
    return Promise.resolve(cachedTokenInfo);
  }

  try {
    const token = generateSecMsGecV2();
    const muid = generateMuid();
    const info: TokenInfo = {
      token,
      version: SEC_MS_GEC_VERSION,
      muid,
      trustedToken: TRUSTED_CLIENT_TOKEN,
    };
    cachedTokenInfo = info;
    tokenExpiresAt = Date.now() + TOKEN_TTL_MS;
    return Promise.resolve(info);
  } catch (err) {
    return Promise.reject(new Error(`Edge TTS token generation failed: ${err}`));
  }
}

export function clearTokenCache(): void {
  cachedTokenInfo = null;
  tokenExpiresAt = 0;
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getVoiceLocale(voice: string): string {
  const lower = voice.toLowerCase();
  if (lower.startsWith('km')) return 'km-KH';
  if (lower.startsWith('zh-hk')) return 'zh-HK';
  if (lower.startsWith('zh-tw')) return 'zh-TW';
  if (lower.startsWith('zh')) return 'zh-CN';
  const match = voice.match(/^[a-z]{2,}-[A-Za-z]{2}/);
  return match ? match[0] : 'zh-CN';
}

function buildSsml(text: string, voice: string, rate: string): string {
  const lang = getVoiceLocale(voice);
  const escaped = escapeXml(text);
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}"><voice name="${voice}"><prosody rate="${rate}">${escaped}</prosody></voice></speak>`;
}

export async function synthesizeEdgeTtsDirect(
  text: string,
  voice: string,
  rate: string = '+0%'
): Promise<Buffer> {
  const tokenInfo = await fetchEdgeToken();
  const connId = crypto.randomUUID().replace(/-/g, '');
  const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${tokenInfo.trustedToken}&Sec-MS-GEC=${tokenInfo.token}&Sec-MS-GEC-Version=${tokenInfo.version}&ConnectionId=${connId}`;

  return new Promise<Buffer>((resolve, reject) => {
    let ws: WebSocket | null = new WebSocket(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Cookie: `muid=${tokenInfo.muid};`,
      },
      handshakeTimeout: 8000,
    });

    const chunks: Buffer[] = [];
    let isDone = false;

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (ws) {
        try {
          ws.removeAllListeners();
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
          }
        } catch {
          // ignore
        }
        ws = null;
      }
    };

    const timeoutTimer = setTimeout(() => {
      if (!isDone) {
        cleanup();
        reject(new Error('Edge TTS request timed out'));
      }
    }, 12000);

    ws.on('open', () => {
      if (!ws) return;
      const speechConfig =
        'Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n' +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: {
                  sentenceBoundaryEnabled: 'false',
                  wordBoundaryEnabled: 'false',
                },
                outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
              },
            },
          },
        });
      ws.send(speechConfig);

      const reqId = crypto.randomUUID().replace(/-/g, '');
      const dateStr = new Date().toUTCString();
      const ssml = buildSsml(text, voice, rate);
      const ssmlMessage = `X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${dateStr}Z\r\nPath:ssml\r\n\r\n${ssml}`;
      ws.send(ssmlMessage);
    });

    ws.on('message', (data: WebSocket.Data, isBinary: boolean) => {
      if (isBinary && Buffer.isBuffer(data)) {
        if (data.length > 2) {
          const headerLen = data.readUInt16BE(0);
          const audioData = data.subarray(headerLen + 2);
          if (audioData.length > 0) {
            chunks.push(audioData);
          }
        }
      } else {
        const textMsg = data.toString();
        if (textMsg.includes('Path:turn.end')) {
          isDone = true;
          const fullBuffer = Buffer.concat(chunks);
          cleanup();
          if (fullBuffer.length < 200) {
            reject(new Error('Generated audio buffer too small'));
          } else {
            resolve(fullBuffer);
          }
        }
      }
    });

    ws.on('unexpected-response', (_req: import('http').ClientRequest, res: import('http').IncomingMessage) => {
      cleanup();
      clearTokenCache();
      reject(new Error(`Edge TTS handshake rejected with HTTP ${res.statusCode}`));
    });

    ws.on('error', (err: Error) => {
      cleanup();
      reject(err);
    });

    ws.on('close', () => {
      if (!isDone) {
        cleanup();
        const fullBuffer = Buffer.concat(chunks);
        if (fullBuffer.length >= 200) {
          resolve(fullBuffer);
        } else {
          reject(new Error('WebSocket closed before audio finished'));
        }
      }
    });
  });
}

export async function synthesizeEdgeTtsWithRetry(
  text: string,
  voice: string,
  rate: string = '+0%'
): Promise<Buffer> {
  try {
    return await synthesizeEdgeTtsDirect(text, voice, rate);
  } catch (err) {
    console.warn('Edge TTS attempt 1 failed, retrying with fresh token...', err instanceof Error ? err.message : err);
    clearTokenCache();
    await new Promise((r) => setTimeout(r, 200));
    return await synthesizeEdgeTtsDirect(text, voice, rate);
  }
}
