export type VoiceContext =
  | "memo"
  | "task"
  | "meeting"
  | "free_text";

export type VoiceResult = {
  cleaned: string;
  tasks?: string[];
};

const BASE_PROMPT = `あなたは音声入力テキストの整形AIです。以下のルールで話し言葉を読みやすい文章に整形してください。

【必須処理】
1. フィラー除去:「えーと」「あのー」「うーん」「まあ」「なんか」「えっと」「あー」を削除
2. 言い間違い修正: 途中で言い直した場合、最終的な意図のみ残す
3. 句読点追加: 適切な位置に「、」「。」を追加
4. 改行整形: 意味の区切りで改行
5. 誤字修正: 明らかな音声認識の誤変換を修正

【禁止事項】
- 意味を変えない
- 情報を追加しない
- 過度に丁寧にしない（話者のトーンを維持）`;

const CONTEXT_PROMPTS: Record<VoiceContext, string> = {
  memo: `${BASE_PROMPT}

追加指示: メモとして読みやすく整形してください。
JSON形式で返してください: {"cleaned":"整形後テキスト"}`,

  task: `${BASE_PROMPT}

追加指示: 入力からタスクを抽出し、最大5つの箇条書きにしてください。動詞で終わる形式に統一。
JSON形式で返してください: {"cleaned":"整形後テキスト","tasks":["タスク1","タスク2"]}`,

  meeting: `${BASE_PROMPT}

追加指示: 議事録として整形してください。発言の要点を整理し、決定事項やアクションアイテムがあれば抽出してください。
JSON形式で返してください: {"cleaned":"整形後テキスト","tasks":["アクションアイテム1"]}`,

  free_text: `${BASE_PROMPT}

JSON形式で返してください: {"cleaned":"整形後テキスト"}`,
};

export function getPrompt(context: VoiceContext): string {
  return CONTEXT_PROMPTS[context];
}
