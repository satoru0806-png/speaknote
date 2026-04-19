import { securityCheck } from './_security.js';

// Pro APIキー検証（transcribe.jsと同じロジック）
const proCache = new Map();

async function checkProApiKey(req) {
  const apiKey = req.headers['x-api-key'] || '';
  if (!apiKey) return false;

  const ownerKey = process.env.OWNER_PRO_KEY;
  if (ownerKey && apiKey === ownerKey) return true;

  const testerKeys = (process.env.TESTER_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
  if (testerKeys.includes(apiKey)) return true;

  const cached = proCache.get(apiKey);
  if (cached && Date.now() < cached.expires) return cached.valid;

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return false;

  try {
    const response = await fetch(`https://api.stripe.com/v1/subscriptions?customer=${apiKey}&status=active&limit=1`, {
      headers: { 'Authorization': `Bearer ${secretKey}` },
    });
    const subs = await response.json();
    const valid = (subs.data?.length || 0) > 0;
    proCache.set(apiKey, { valid, expires: Date.now() + 3600000 });
    return valid;
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  const security = securityCheck(req, res);
  if (security.handled) return;

  const isPro = await checkProApiKey(req);
  if (!isPro) {
    return res.status(403).json({ error: '読み上げはProプラン専用です。' });
  }

  const { text, voice, speed } = req.body || {};
  if (!text || typeof text !== 'string' || text.length === 0) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (text.length > 4000) {
    return res.status(400).json({ error: 'text too long (max 4000 chars)' });
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    return res.status(500).json({ error: 'OpenAI API key not configured' });
  }

  try {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: 'tts-1',
        voice: voice || 'nova',
        input: text,
        response_format: 'mp3',
        speed: Math.max(0.5, Math.min(2.0, Number(speed) || 1.1)),
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('OpenAI TTS error:', response.status, err);
      return res.status(502).json({ error: 'TTS生成に失敗しました' });
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Plan', 'pro');
    return res.status(200).send(buffer);
  } catch (e) {
    console.error('TTS error:', e);
    return res.status(500).json({ error: 'TTS生成に失敗しました' });
  }
}
