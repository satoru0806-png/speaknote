"use client";
import { useState, useEffect } from "react";

const isElectron = typeof window !== "undefined" && !!(window as unknown as { electronAPI?: unknown }).electronAPI;
const electronAPI = isElectron
  ? (window as unknown as {
      electronAPI: {
        onRecordingState: (cb: (recording: boolean) => void) => void;
      };
    }).electronAPI
  : null;

export default function Home() {
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (electronAPI) {
      electronAPI.onRecordingState((_event: unknown, state: boolean) => {
        setRecording(state);
      });
    }
  }, []);

  // Electron: tiny floating indicator
  if (isElectron) {
    return (
      <div className="w-12 h-12 flex items-center justify-center" style={{ background: "transparent" }}>
        <div className={`w-8 h-8 rounded-full transition-all ${
          recording ? "bg-red-500 animate-pulse shadow-lg shadow-red-500/50" : "bg-gray-600 opacity-40"
        }`}>
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mt-2">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          </svg>
        </div>
      </div>
    );
  }

  // Browser: simple info page
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center space-y-4 p-8">
        <h1 className="text-2xl font-bold text-gray-800">SpeakNote</h1>
        <p className="text-gray-500">Alt 長押しで音声入力</p>
        <p className="text-sm text-gray-400">Electronアプリとして起動してください</p>
      </div>
    </div>
  );
}
