import { NextRequest, NextResponse } from "next/server";
import { getPrompt, type VoiceContext, type VoiceResult } from "@/lib/voice-ai";

export async function POST(req: NextRequest) {
  const { rawText, context } = (await req.json()) as {
    rawText: string;
    context: VoiceContext;
  };

  if (!rawText || !rawText.trim()) {
    return NextResponse.json({ cleaned: "", tasks: [] });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ cleaned: rawText, tasks: [] });
  }

  const systemPrompt = getPrompt(context || "free_text");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: rawText }],
    }),
  });

  if (!res.ok) {
    return NextResponse.json({ cleaned: rawText, tasks: [] });
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || rawText;

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed: VoiceResult = JSON.parse(jsonMatch[0]);
      return NextResponse.json(parsed);
    }
  } catch {
    // JSON parse failed, return cleaned text
  }

  return NextResponse.json({ cleaned: text, tasks: [] });
}
