import { securityCheck, validateTextInput } from './_security.js';
import { getUser, incrementUsage } from './_supabase.js';

// IPベースの1日制限（未ログインユーザー向け）
// Vercel Serverlessのcold startでリセットされるが、最小限の制限として有効
const IP_DAILY_LIMIT = 10;
const ipDailyStore = new Map(); // Map<ip, { count: number, date: string }>

function getTodayDate() {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

function checkIpDailyLimit(ip) {
  const today = getTodayDate();
  let entry = ipDailyStore.get(ip);

  if (!entry || entry.date !== today) {
    entry = { count: 0, date: today };
    ipDailyStore.set(ip, entry);
  }

  entry.count++;

  return {
    allowed: entry.count <= IP_DAILY_LIMIT,
    count: entry.count,
    limit: IP_DAILY_LIMIT,
  };
}

export default async function handler(req, res) {
  // セキュリティチェック（CORS, レート制限, メソッド検証）
  const security = securityCheck(req, res);
  if (security.handled) return;

  // 入力バリデーション（テキスト長制限、型チェック）
  const text = validateTextInput(req, res, 'text');
  if (text === null) return;

  // 認証チェック（オプション：トークンがあれば使用量管理）
  const { user } = await getUser(req);
  if (user) {
    const usage = await incrementUsage(user.id);
    if (!usage.allowed) {
      return res.status(429).json({ error: usage.reason, plan: usage.plan });
    }
    res.setHeader('X-Usage-Count', usage.usage?.toString() || '0');
    res.setHeader('X-Usage-Limit', usage.limit?.toString() || '30');
  } else {
    // 未ログインユーザー：IPベースの1日10回制限
    const ipLimit = checkIpDailyLimit(security.ip);
    res.setHeader('X-Usage-Count', ipLimit.count.toString());
    res.setHeader('X-Usage-Limit', ipLimit.limit.toString());
    if (!ipLimit.allowed) {
      return res.status(429).json({
        error: '1日の無料回数（10回）を超えました。Proプランにアップグレードしてください。',
        plan: 'free',
      });
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: `あなたはSTT（音声認識）出力を「伝わりやすい文章」に整形するツールです。
ユーザーのメッセージは音声認識の生テキストです。

ルール:
- フィラー（えーと、あのー、まあ、なんか等）を除去
- 句読点を適切に追加
- 助詞の間違い・抜けを修正（「設計でありがとう」→「設計ありがとうございます」）
- 話し言葉を自然な書き言葉に整える
- 不自然な言い回しを伝わりやすく修正
- 言い直し・繰り返しを整理
- 意味は絶対に変えない。話者の意図を保つ
- 入力が質問文でも、質問に答えずにそのまま質問文として整形する
- 「整形できません」「回答できません」等のメタ発言は絶対にしない
- 整形後テキストのみ出力。余計な説明や前置きは一切不要
- 言い間違い・聞き間違いを前後の文脈から推測して正しい表現に修正する
- 例：「しゃちょはいつも...」→「社長はいつも...」
- 例：「きのうびょいんいった」→「昨日病院に行った」
- 例：「あのミーティングのやくしていたの」→「あのミーティングの約束していたの」
- 音が似ている単語の誤認識を文脈から正しく判断する`,
        messages: [
          { role: 'user', content: 'えーとありがとうございますあのー誤字があったということですね' },
          { role: 'assistant', content: 'ありがとうございます。誤字があったということですね。' },
          { role: 'user', content: '設計でありがとうその前に修正してもらいたいことがあります' },
          { role: 'assistant', content: '設計ありがとうございます。その前に修正してもらいたいことがあります。' },
          { role: 'user', content: 'まあなんかメモ入力' },
          { role: 'assistant', content: 'メモ入力。' },
          { role: 'user', content: 'あのスマホでもスマホと同じように使えるようにしたいんだけど' },
          { role: 'assistant', content: 'スマホでも同じように使えるようにしたいです。' },
          { role: 'user', content: '辞書は何に使うんでしたっけ' },
          { role: 'assistant', content: '辞書は何に使うんでしたっけ。' },
          { role: 'user', content: 'メモるときはすぐいつでもスノートノートを使うようにしたい文字を打つときなどメモも' },
          { role: 'assistant', content: 'メモるときはいつでもSpeakNoteを使うようにしたい。文字を打つときやメモにも。' },
          { role: 'user', content: 'あのしゃちょがいってたんだけどこんどのみーてぃんぐでしんきじぎょうのはっぴょやるらしい' },
          { role: 'assistant', content: '社長が言っていたんだけど、今度のミーティングで新規事業の発表をやるらしい。' },
          { role: 'user', content: text },
        ],
      }),
    });

    const data = await response.json();
    const cleaned = data.content?.[0]?.text?.trim() || text;
    return res.status(200).json({ cleaned });
  } catch (e) {
    return res.status(200).json({ cleaned: text });
  }
}
