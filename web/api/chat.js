export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { message, history } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: "message required" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "API key not configured" });

  try {
    // Build messages from history (last 10 turns max)
    const messages = [];
    if (Array.isArray(history)) {
      const recent = history.slice(-10);
      for (const h of recent) {
        messages.push({ role: h.role, content: h.content });
      }
    }
    messages.push({ role: "user", content: message });

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2048,
        system: `あなたはSpeakNoteの音声AIアシスタントです。
ユーザーはスマホの音声入力で話しかけています。

ルール:
- 簡潔で分かりやすい日本語で返答
- 長すぎない回答（3〜5文程度が理想）
- 質問には的確に答える
- 雑談にも自然に対応
- 音声で読み上げられることを意識し、リスト記号や特殊文字は避ける
- 親しみやすいが丁寧な口調`,
        messages,
      }),
    });

    const data = await response.json();
    const reply = data.content?.[0]?.text?.trim() || "すみません、応答を生成できませんでした。";
    return res.status(200).json({ reply });
  } catch (e) {
    return res.status(500).json({ error: "AI応答エラー", reply: "すみません、通信エラーが発生しました。" });
  }
}
