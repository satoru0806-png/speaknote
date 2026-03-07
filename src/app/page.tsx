"use client";
import { useState, useRef, useCallback, useEffect } from "react";
import type { VoiceContext } from "@/lib/voice-ai";

type NoteEntry = {
  id: number;
  raw: string;
  cleaned: string;
  tasks?: string[];
  context: VoiceContext;
  timestamp: Date;
};

const CONTEXTS: { value: VoiceContext; label: string; desc: string }[] = [
  { value: "memo", label: "メモ", desc: "読みやすく整形" },
  { value: "task", label: "タスク抽出", desc: "やることを箇条書きに" },
  { value: "meeting", label: "議事録", desc: "要点とアクション整理" },
  { value: "free_text", label: "フリー", desc: "基本整形のみ" },
];

export default function Home() {
  const [context, setContext] = useState<VoiceContext>("memo");
  const [listening, setListening] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [notes, setNotes] = useState<NoteEntry[]>([]);
  const [copied, setCopied] = useState<number | null>(null);
  const recRef = useRef<SpeechRecognition | null>(null);
  const idRef = useRef(0);

  const processWithAI = useCallback(async (rawText: string) => {
    setProcessing(true);
    try {
      const res = await fetch("/api/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawText, context }),
      });
      if (res.ok) {
        const data = await res.json();
        const entry: NoteEntry = {
          id: ++idRef.current,
          raw: rawText,
          cleaned: data.cleaned || rawText,
          tasks: data.tasks,
          context,
          timestamp: new Date(),
        };
        setNotes((prev) => [entry, ...prev]);
        setProcessing(false);
        return;
      }
    } catch {
      // fall through
    }
    const entry: NoteEntry = {
      id: ++idRef.current,
      raw: rawText,
      cleaned: rawText,
      context,
      timestamp: new Date(),
    };
    setNotes((prev) => [entry, ...prev]);
    setProcessing(false);
  }, [context]);

  const toggleListening = useCallback(() => {
    if (listening) {
      recRef.current?.stop();
      setListening(false);
      return;
    }

    if (typeof window === "undefined") return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      alert("このブラウザは音声認識に対応していません。Chrome をお使いください。");
      return;
    }

    const rec = new SR();
    rec.lang = "ja-JP";
    rec.continuous = false;
    rec.interimResults = false;

    rec.onresult = (e: SpeechRecognitionEvent) => {
      const raw = e.results[0][0].transcript;
      setListening(false);
      processWithAI(raw);
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);

    recRef.current = rec;
    rec.start();
    setListening(true);
  }, [listening, processWithAI]);

  const copyToClipboard = (text: string, id: number) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 1500);
  };

  const deleteNote = (id: number) => {
    setNotes((prev) => prev.filter((n) => n.id !== id));
  };

  // Alt key: hold to record, release to stop
  const altDownRef = useRef(false);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Alt" && !altDownRef.current && !processing) {
        e.preventDefault();
        altDownRef.current = true;
        // Start recording
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) return;
        const rec = new SR();
        rec.lang = "ja-JP";
        rec.continuous = true;
        rec.interimResults = false;
        rec.onresult = (ev: SpeechRecognitionEvent) => {
          const raw = ev.results[ev.results.length - 1][0].transcript;
          setListening(false);
          processWithAI(raw);
        };
        rec.onerror = () => setListening(false);
        rec.onend = () => setListening(false);
        recRef.current = rec;
        rec.start();
        setListening(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Alt" && altDownRef.current) {
        e.preventDefault();
        altDownRef.current = false;
        recRef.current?.stop();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [processing, processWithAI]);

  const hasSpeech = typeof window !== "undefined" &&
    (window.SpeechRecognition || window.webkitSpeechRecognition);

  return (
    <div className="max-w-lg mx-auto px-4 py-6 min-h-screen flex flex-col">
      {/* Header */}
      <header className="text-center mb-6">
        <h1 className="text-2xl font-bold text-indigo-600">SpeakNote</h1>
        <p className="text-sm text-gray-500 mt-1">話すだけで、きれいなメモになる</p>
      </header>

      {/* Context Selector */}
      <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
        {CONTEXTS.map((c) => (
          <button
            key={c.value}
            onClick={() => setContext(c.value)}
            className={`px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
              context === c.value
                ? "bg-indigo-600 text-white shadow-md"
                : "bg-white text-gray-600 border border-gray-200 hover:bg-gray-50"
            }`}
          >
            <div>{c.label}</div>
            <div className={`text-[10px] mt-0.5 ${context === c.value ? "text-indigo-200" : "text-gray-400"}`}>
              {c.desc}
            </div>
          </button>
        ))}
      </div>

      {/* Record Button */}
      <div className="flex justify-center mb-6">
        {processing ? (
          <div className="w-20 h-20 rounded-full bg-purple-100 flex items-center justify-center animate-pulse">
            <span className="text-sm text-purple-600 font-medium">AI整形中</span>
          </div>
        ) : (
          <button
            onClick={toggleListening}
            disabled={!hasSpeech}
            className={`w-20 h-20 rounded-full flex items-center justify-center transition-all shadow-lg ${
              listening
                ? "bg-red-500 text-white animate-pulse scale-110"
                : "bg-indigo-600 text-white hover:bg-indigo-700 hover:scale-105"
            } disabled:bg-gray-300 disabled:cursor-not-allowed`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" x2="12" y1="19" y2="22"/>
            </svg>
          </button>
        )}
      </div>
      <p className="text-center text-xs text-gray-400 mb-6">
        {listening ? "聞いています..." : processing ? "AIが整形しています..." : "タップ or Altキー長押しで話す"}
      </p>

      {/* Notes List */}
      <div className="flex-1 space-y-3">
        {notes.length === 0 && (
          <div className="text-center text-gray-400 text-sm py-12">
            <p>まだメモがありません</p>
            <p className="mt-1">マイクボタンを押して話してみてください</p>
          </div>
        )}
        {notes.map((note) => (
          <div key={note.id} className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm whitespace-pre-wrap">{note.cleaned}</p>
                {note.tasks && note.tasks.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {note.tasks.map((task, i) => (
                      <li key={i} className="text-xs text-indigo-700 flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 flex-shrink-0" />
                        {task}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex items-center gap-2 mt-2">
                  <span className="text-[10px] text-gray-400">
                    {note.timestamp.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 rounded text-gray-500">
                    {CONTEXTS.find((c) => c.value === note.context)?.label}
                  </span>
                </div>
              </div>
              <div className="flex flex-col gap-1 flex-shrink-0">
                <button
                  onClick={() => copyToClipboard(note.cleaned, note.id)}
                  className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
                  title="コピー"
                >
                  {copied === note.id ? (
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-green-500">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
                      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
                    </svg>
                  )}
                </button>
                <button
                  onClick={() => deleteNote(note.id)}
                  className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                  title="削除"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18"/>
                    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
