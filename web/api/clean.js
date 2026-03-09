export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: "text required" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "API key not configured" });

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
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
- 整形後テキストのみ出力。余計な説明や前置きは一切不要`,
        messages: [
          { role: "user", content: "えーとありがとうございますあのー誤字があったということですね" },
          { role: "assistant", content: "ありがとうございます。誤字があったということですね。" },
          { role: "user", content: "設計でありがとうその前に修正してもらいたいことがあります" },
          { role: "assistant", content: "設計ありがとうございます。その前に修正してもらいたいことがあります。" },
          { role: "user", content: "まあなんかメモ入力" },
          { role: "assistant", content: "メモ入力。" },
          { role: "user", content: "あのスマホでもスマホと同じように使えるようにしたいんだけど" },
          { role: "assistant", content: "スマホでも同じように使えるようにしたいです。" },
          { role: "user", content: "辞書は何に使うんでしたっけ" },
          { role: "assistant", content: "辞書は何に使うんでしたっけ。" },
          { role: "user", content: "メモるときはすぐいつでもスノートノートを使うようにしたい文字を打つときなどメモも" },
          { role: "assistant", content: "メモるときはいつでもSpeakNoteを使うようにしたい。文字を打つときやメモにも。" },
          { role: "user", content: text },
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
