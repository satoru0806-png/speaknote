import { securityCheck } from './_security.js';

// Pro APIキーの検証（clean.jsと同じロジック）
const proCache = new Map();

async function checkProApiKey(req) {
  const apiKey = req.headers['x-api-key'] || '';
  if (!apiKey) return false;

  const ownerKey = process.env.OWNER_PRO_KEY;
  if (ownerKey && apiKey === ownerKey) return true;

  // テスターキー（環境変数 TESTER_KEYS にカンマ区切りで登録）
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

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '25mb',
    },
  },
};

export default async function handler(req, res) {
  // CORS・レート制限
  const security = securityCheck(req, res);
  if (security.handled) return;

  // Proユーザーのみ利用可能
  const isPro = await checkProApiKey(req);
  if (!isPro) {
    return res.status(403).json({ error: 'Whisper APIはProプラン専用です。' });
  }

  // 音声データ取得（base64）
  const { audio, format } = req.body || {};
  if (!audio || typeof audio !== 'string') {
    return res.status(400).json({ error: 'audio (base64) is required' });
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    return res.status(500).json({ error: 'OpenAI API key not configured' });
  }

  try {
    // base64 → Buffer → File (Blob)
    const audioBuffer = Buffer.from(audio, 'base64');
    const mimeType = format === 'mp4' ? 'audio/mp4' : 'audio/webm';
    const ext = format === 'mp4' ? 'm4a' : 'webm';

    // Node.js 18+ FormData API
    const formData = new FormData();
    const audioBlob = new Blob([audioBuffer], { type: mimeType });
    formData.append('file', audioBlob, `audio.${ext}`);
    formData.append('model', 'gpt-4o-transcribe');
    formData.append('language', 'ja');
    formData.append('prompt', '日本語の自然な会話・メモ・連絡文です。人名や固有名詞、助詞を正確に書き起こしてください。句読点、改行を適切に使用します。');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Whisper API error:', response.status, err);
      return res.status(502).json({ error: '文字起こしに失敗しました' });
    }

    const data = await response.json();
    let text = data.text || '';

    // ノイズテキストをフィルタリング
    const noisePatterns = ['SpeakNote', '音声メモ', 'ご視聴', 'チャンネル登録', '字幕', 'subtitle', 'Thank you for watching', '句読点を正確に', '日本語の音声'];
    if (noisePatterns.some(p => text.includes(p)) || text.length < 3) {
      text = '';
    }

    // よくある誤認識を自動修正
    if (text) {
      text = text
        .replace(/ではる/g, 'である')
        .replace(/ではり/g, 'であり')
        .replace(/がはる/g, 'がある')
        .replace(/がはり/g, 'があり')
        .replace(/にはる/g, 'にある')
        .replace(/もはる/g, 'もある')
        .replace(/てはる/g, 'てある')
        .replace(/はりがとう/g, 'ありがとう')
        .replace(/おはいよう/g, 'おはよう')
        .replace(/すいません/g, 'すみません')
        .replace(/ってゆう/g, 'っていう')
        .replace(/とゆう/g, 'という')
        .replace(/てゆう/g, 'ていう')
        .replace(/こんにちわ/g, 'こんにちは')
        .replace(/こんばんわ/g, 'こんばんは')
        .replace(/づつ/g, 'ずつ')
        .replace(/ゆった/g, '言った')
        .replace(/ゆって/g, '言って')
        .replace(/ゆえば/g, '言えば')
        .replace(/おねがいしまーす/g, 'お願いします')
        .replace(/おねがいします/g, 'お願いします')
        .replace(/よろしくおねがいします/g, 'よろしくお願いします')
        .replace(/だいじょうぶ/g, '大丈夫')
        .replace(/ほんとう/g, '本当')
        .replace(/ほんと/g, '本当')
        // 「は」「が」の誤認識修正（文頭・単独音が「は」と誤認識される問題）
        .replace(/^は$/g, 'あ')
        .replace(/^はー$/g, 'あー')
        .replace(/^はっ$/g, 'あっ')
        // 「はったら」→「あったら」「やったら」等
        .replace(/やってはったら/g, 'やったら')
        .replace(/はったらいい/g, 'あったらいい')
        .replace(/方法はったら/g, '方法があったら')
        // 「糸で」→「意図で」（同音異義の修正）
        .replace(/その糸で/g, 'その意図で')
        .replace(/糸的に/g, '意図的に')
        // 「見せ回し」→「申し上げ」
        .replace(/見せ回し/g, '申し上げ')
        // 「改めて」→「改善して」（文脈で判断）
        .replace(/方法を改めて/g, '方法を改善して')
        // 末尾の不自然な助詞補完
        .replace(/てゆ$/g, 'て。')
        .replace(/てわ$/g, 'ては');
    }

    res.setHeader('X-Plan', 'pro');
    return res.status(200).json({ text });
  } catch (e) {
    console.error('Transcribe error:', e);
    return res.status(500).json({ error: '文字起こしに失敗しました' });
  }
}
