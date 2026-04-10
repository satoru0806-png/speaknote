import { securityCheck, validateTextInput } from './_security.js';

// chat用の日次IP制限（無料ユーザー向け）
const IP_DAILY_LIMIT = 20;
const ipDailyStore = new Map();

function checkChatLimit(ip) {
  const today = new Date().toISOString().slice(0, 10);
  let entry = ipDailyStore.get(ip);
  if (!entry || entry.date !== today) {
    entry = { count: 0, date: today };
    ipDailyStore.set(ip, entry);
  }
  entry.count++;
  return { allowed: entry.count <= IP_DAILY_LIMIT, count: entry.count };
}

export default async function handler(req, res) {
  // セキュリティチェック（CORS, レート制限, メソッド検証）
  const security = securityCheck(req, res);
  if (security.handled) return;

  // IP日次制限
  const chatLimit = checkChatLimit(security.ip);
  if (!chatLimit.allowed) {
    return res.status(429).json({ error: '1日の会話回数を超えました。', reply: '本日の会話回数を超えました。明日また話しかけてください。' });
  }

  // 入力バリデーション
  const message = validateTextInput(req, res, 'message');
  if (message === null) return;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const { history } = req.body || {};

    // 履歴のバリデーション（最大10ターン、各メッセージ最大2000文字）
    const messages = [
      { role: 'system', content: `あなたはSpeakNoteの音声AIアシスタントです。
ユーザーはスマホの音声入力で話しかけています。

ルール:
- 簡潔で分かりやすい日本語で返答
- 長すぎない回答（3〜5文程度が理想）
- 質問には的確に答える
- 雑談にも自然に対応
- 音声で読み上げられることを意識し、リスト記号や特殊文字は避ける
- 親しみやすいが丁寧な口調` },
    ];
    if (Array.isArray(history)) {
      const recent = history.slice(-10);
      for (const h of recent) {
        if (h.role && h.content && typeof h.content === 'string') {
          messages.push({
            role: h.role === 'assistant' ? 'assistant' : 'user',
            content: h.content.slice(0, 2000),
          });
        }
      }
    }
    messages.push({ role: 'user', content: message });

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        max_tokens: 2048,
        messages,
      }),
    });

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content?.trim() || 'すみません、応答を生成できませんでした。';
    return res.status(200).json({ reply });
  } catch (e) {
    return res.status(500).json({ error: 'AI応答エラー', reply: 'すみません、通信エラーが発生しました。' });
  }
}
