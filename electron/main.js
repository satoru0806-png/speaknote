const { app, BrowserWindow, Tray, Menu, clipboard, globalShortcut } = require("electron");
const path = require("path");
const http = require("http");
const https = require("https");
const { exec, execFile } = require("child_process");
const fs = require("fs");
const WebSocket = require("ws");
const backup = require("./backup");

let tray;
let speechWs = null; // Active WebSocket connection to Edge
let savedHwnd = null; // Foreground window handle saved when Alt is pressed (Windows)
let savedMacApp = null; // Frontmost app name saved when Option is pressed (Mac)
let aiEnabled = true; // AI cleanup toggle
let autoLearnEnabled = false; // Auto-learn toggle
let userDict = []; // User dictionary [{from, to}]
let lastPastedText = ""; // Last pasted text for Keep saving
let chatMode = false; // false=整形, true=会話
let isProcessing = false; // Whisper処理中フラグ
let chatHistory = []; // [{role, content}, ...]
const MAX_CHAT_TURNS = 20;

// --- Vercel API base URL ---
const VERCEL_API = "https://web-five-alpha-24.vercel.app";
const OWNER_PRO_KEY = "speaknote-owner-pro-2026";

// --- HTTPS keep-alive agent (TLS再利用でリクエスト遅延削減) ---
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 4, keepAliveMsecs: 60000 });

// --- Vercel Serverlessウォームアップ（録音開始と同時にコールドスタート回避） ---
let lastWarmup = 0;
function warmVercel() {
  const now = Date.now();
  if (now - lastWarmup < 15000) return; // 15秒以内は再送しない
  lastWarmup = now;
  const hostname = new URL(VERCEL_API).hostname;
  ["/api/clean", "/api/transcribe"].forEach((p) => {
    try {
      const body = "{}";
      const req = https.request({
        hostname, path: p, method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": OWNER_PRO_KEY, "X-Warmup": "1", "Content-Length": Buffer.byteLength(body) },
        agent: keepAliveAgent, timeout: 3000,
      }, (res) => { res.on("data", () => {}); res.on("end", () => {}); });
      req.on("error", () => {});
      req.on("timeout", () => req.destroy());
      req.write(body); req.end();
    } catch {}
  });
}

// --- Whisper API 呼び出し（抽出版・単発/チャンク両対応） ---
function callTranscribeAPI(audioBase64, format) {
  const body = JSON.stringify({ audio: audioBase64, format: format || 'webm' });
  return new Promise((resolve, reject) => {
    const apiReq = https.request({
      hostname: new URL(VERCEL_API).hostname,
      path: "/api/transcribe",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": OWNER_PRO_KEY,
        "Content-Length": Buffer.byteLength(body),
      },
      agent: keepAliveAgent,
      timeout: 60000,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          resolve(data);
        } catch { resolve({}); }
      });
    });
    apiReq.on("error", (e) => reject(e));
    apiReq.on("timeout", () => { apiReq.destroy(); reject(new Error("timeout")); });
    apiReq.write(body);
    apiReq.end();
  });
}

// --- Load optional keys ---
const envPath = path.join(__dirname, "..", ".env.local");
let ELEVENLABS_API_KEY = "";
try {
  const envContent = fs.readFileSync(envPath, "utf-8");
  const match2 = envContent.match(/ELEVENLABS_API_KEY=(.+)/);
  if (match2) ELEVENLABS_API_KEY = match2[1].trim();
} catch {}

// --- ElevenLabs TTS ---
const ELEVENLABS_VOICE_ID = "fhExSPIFZARkUUQI9RV8"; // Custom cloned voice
const os = require("os");

function elevenLabsTTS(text) {
  return new Promise((resolve, reject) => {
    if (!ELEVENLABS_API_KEY || !text.trim()) { reject(new Error("No API key")); return; }
    const body = JSON.stringify({
      text: text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    });
    const req = https.request({
      hostname: "api.elevenlabs.io",
      path: `/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 20000,
    }, (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => reject(new Error("ElevenLabs: " + Buffer.concat(chunks).toString())));
        return;
      }
      const mp3Path = path.join(os.tmpdir(), "speaknote_tts.mp3");
      const out = fs.createWriteStream(mp3Path);
      res.pipe(out);
      out.on("finish", () => resolve(mp3Path));
      out.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("TTS timeout")); });
    req.write(body); req.end();
  });
}

// --- AI text cleanup (SSEストリーミング版 - TTFB短縮) ---
function cleanWithAI(rawText) {
  return new Promise((resolve) => {
    if (!rawText.trim()) { resolve(rawText); return; }
    // 15文字以下は整形スキップ（高速化）
    if (rawText.trim().length <= 15) { resolve(rawText); return; }
    const body = JSON.stringify({ text: rawText });
    const req = https.request({
      hostname: new URL(VERCEL_API).hostname,
      path: "/api/clean",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "X-Api-Key": OWNER_PRO_KEY,
        "Content-Length": Buffer.byteLength(body),
      },
      agent: keepAliveAgent,
      timeout: 15000,
    }, (res) => {
      // ストリーミングでない場合はJSONとしてパース（フォールバック）
      const isSse = (res.headers["content-type"] || "").includes("text/event-stream");
      if (!isSse) {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            resolve(data.cleaned || rawText);
          } catch { resolve(rawText); }
        });
        return;
      }
      let acc = "";
      let buf = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk) => {
        buf += chunk;
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const obj = JSON.parse(payload);
            const delta = obj.choices?.[0]?.delta?.content || "";
            if (delta) acc += delta;
          } catch {}
        }
      });
      res.on("end", () => resolve((acc.trim() || rawText)));
    });
    req.on("error", () => resolve(rawText));
    req.on("timeout", () => { req.destroy(); resolve(rawText); });
    req.write(body); req.end();
  });
}

// --- AI chat (via Vercel API) ---
function chatWithAI(userText) {
  return new Promise((resolve, reject) => {
    if (!userText.trim()) { reject(new Error("空テキスト")); return; }
    chatHistory.push({ role: "user", content: userText });
    // Trim history
    while (chatHistory.length > MAX_CHAT_TURNS * 2) chatHistory.shift();
    while (chatHistory.length > 0 && chatHistory[0].role === "assistant") chatHistory.shift();

    const body = JSON.stringify({
      message: userText,
      history: chatHistory.slice(0, -1), // exclude current message (already in API)
    });
    const req = https.request({
      hostname: new URL(VERCEL_API).hostname,
      path: "/api/chat",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          const reply = (data.reply || data.content?.[0]?.text || "").trim();
          if (reply) { chatHistory.push({ role: "assistant", content: reply }); resolve(reply); }
          else { reject(new Error("空の応答")); }
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("タイムアウト")); });
    req.write(body); req.end();
  });
}

// --- Paste text (restore focus to saved window first) ---
const keyhelper = path.join(__dirname, "keyhelper.exe");
let SetForegroundWindow = null; // loaded later with koffi

let pendingLearnCheck = null; // { text, hwnd } - previous paste to check on next Alt press

function checkPreviousPaste() {
  if (!pendingLearnCheck) return;
  const { text: prevText, hwnd: prevHwnd } = pendingLearnCheck;
  pendingLearnCheck = null;

  // Focus the previous window, Ctrl+A + Ctrl+C to get all text, then compare
  if (prevHwnd && SetForegroundWindow) {
    SetForegroundWindow(prevHwnd);
    setTimeout(() => {
      // Ctrl+A to select all in the field
      execFile(keyhelper, ["selectall"], (err) => {
        if (err) { console.log("[SpeakNote] 学習チェック失敗:", err.message); return; }
        setTimeout(() => {
          // Ctrl+C to copy
          execFile(keyhelper, ["copy"], (err2) => {
            if (err2) return;
            setTimeout(() => {
              const currentText = clipboard.readText().trim();
              // Press End to deselect
              execFile(keyhelper, ["deselect"], () => {});
              console.log("[SpeakNote] 学習チェック: 元=", prevText, "現在=", currentText);
              if (currentText && currentText !== prevText && currentText.length > 0) {
                // Check the text contains something similar (not completely different content)
                const prevClean = prevText.replace(/[。、！？\s]/g, '');
                const currClean = currentText.replace(/[。、！？\s]/g, '');
                const overlap = [...prevClean].filter(c => currClean.includes(c)).length;
                const similarity = overlap / Math.max(prevClean.length, 1);
                if (similarity > 0.3) {
                  if (speechWs && speechWs.readyState === WebSocket.OPEN) {
                    speechWs.send(JSON.stringify({ type: "learn_compare", original: prevText, corrected: currentText }));
                  }
                }
              }
              // Restore focus back to current window
              if (savedHwnd && SetForegroundWindow) {
                setTimeout(() => SetForegroundWindow(savedHwnd), 100);
              }
            }, 200);
          });
        }, 100);
      });
    }, 100);
  }
}

function autoFixText(t) {
  return t
    .replace(/ではる/g, 'である').replace(/ではり/g, 'であり')
    .replace(/がはる/g, 'がある').replace(/がはり/g, 'があり')
    .replace(/にはる/g, 'にある').replace(/もはる/g, 'もある')
    .replace(/てはる/g, 'てある').replace(/はりがとう/g, 'ありがとう')
    .replace(/おはいよう/g, 'おはよう').replace(/すいません/g, 'すみません')
    .replace(/こんにちわ/g, 'こんにちは').replace(/こんばんわ/g, 'こんばんは');
}

function pasteText(text) {
  text = autoFixText(text);
  clipboard.writeText(text);
  lastPastedText = text;
  console.log("[SpeakNote] クリップボード:", text);

  if (process.platform === "darwin") {
    // Mac: 直前アプリをアクティブ化 → Cmd+V で貼り付け
    const doMacPaste = () => {
      const activateScript = savedMacApp
        ? `tell application "${savedMacApp.replace(/"/g,'\\"')}" to activate`
        : '';
      const pasteScript = 'tell application "System Events" to keystroke "v" using command down';
      // アクティブ化 → 150ms待って貼り付け
      if (activateScript) {
        execFile("osascript", ["-e", activateScript], { timeout: 2000 }, () => {
          setTimeout(() => {
            execFile("osascript", ["-e", pasteScript], { timeout: 2000 }, (err) => {
              if (err) console.log("[SpeakNote] Mac貼り付け失敗:", err.message);
              else console.log("[SpeakNote] Mac貼り付け完了 →", savedMacApp);
            });
          }, 150);
        });
      } else {
        execFile("osascript", ["-e", pasteScript], { timeout: 2000 }, (err) => {
          if (err) console.log("[SpeakNote] Mac貼り付け失敗:", err.message);
          else console.log("[SpeakNote] Mac貼り付け完了");
        });
      }
    };
    setTimeout(doMacPaste, 100);
    return;
  }

  // Windows: フォーカス復元してからkeyhelperで貼り付け
  if (savedHwnd && SetForegroundWindow) {
    SetForegroundWindow(savedHwnd);
  }
  setTimeout(() => {
    const hwndStr = savedHwnd ? String(savedHwnd) : "0";
    console.log("[SpeakNote] focuspaste hwnd:", hwndStr);
    execFile(keyhelper, ["focuspaste", hwndStr], { timeout: 3000 }, (err) => {
      if (err) {
        console.log("[SpeakNote] focuspaste失敗、通常paste:", err.message);
        execFile(keyhelper, ["paste"], { timeout: 3000 }, () => {});
      } else {
        console.log("[SpeakNote] 貼り付け完了");
      }
      if (autoLearnEnabled) {
        pendingLearnCheck = { text: text, hwnd: savedHwnd };
      }
    });
  }, 100);
}

// --- System beep (PowerShell singleton for speed) ---
let beepProcess = null;
function playBeep(freq, duration) {
  // PowerShellビープ無効化（speech.htmlのWebAudioのみ使用し、二重鳴りを防止）
}
function playStartBeep() { }
function playStopBeep() { }

// --- Send command to Edge via WebSocket ---
function sendCommand(cmd) {
  if (speechWs && speechWs.readyState === WebSocket.OPEN) {
    speechWs.send(JSON.stringify({ type: "command", command: cmd }));
    console.log("[SpeakNote] → Edge:", cmd);
  } else {
    console.log("[SpeakNote] Edge未接続 (ws state:", speechWs?.readyState, ")");
  }
}

// --- HTTP + WebSocket server ---
const PORT = 3457;
const speechHtmlPath = path.join(__dirname, "speech.html");

const httpServer = http.createServer((req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.url === "/" || req.url === "/speech.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(speechHtmlPath, "utf-8"));
  } else if (req.url === "/tts.mp3") {
    const mp3Path = path.join(os.tmpdir(), "speaknote_tts.mp3");
    if (fs.existsSync(mp3Path)) {
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": fs.statSync(mp3Path).size });
      fs.createReadStream(mp3Path).pipe(res);
    } else {
      res.writeHead(404); res.end();
    }
  } else {
    res.writeHead(404); res.end();
  }
});

const wss = new WebSocket.Server({ server: httpServer });

wss.on("connection", (ws) => {
  console.log("[SpeakNote] Edge WebSocket接続!");
  speechWs = ws;
  // Sync chatMode state to newly connected Edge
  if (chatMode) {
    ws.send(JSON.stringify({ type: "command", command: "chat_mode_on" }));
  }

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "whisper_request" && msg.audio) {
        // レガシー: 単発 Whisper（後方互換）
        isProcessing = true;
        console.log("[SpeakNote] Whisper API呼び出し:", Math.round(msg.audio.length/1024) + "KB");
        try {
          const result = await callTranscribeAPI(msg.audio, msg.format);
          let text = result.text || "";
          console.log("[SpeakNote] Whisper結果:", text.substring(0, 50));
          isProcessing = false;
          ws.send(JSON.stringify({ type: "whisper_result", text }));
        } catch (e) {
          console.error("[SpeakNote] Whisper APIエラー:", e.message);
          isProcessing = false;
          ws.send(JSON.stringify({ type: "whisper_result", text: "", error: "Whisper失敗: " + e.message }));
        }
      } else if (msg.type === "save_unprocessed_audio" && msg.audio) {
        // 全チャンク失敗時の音声救出: unprocessedフォルダへ保存
        try {
          const audioBuffer = Buffer.from(msg.audio, "base64");
          const stamp = backup.nowStamp();
          const savedPath = backup.saveUnprocessedAudio({
            stamp,
            audioBuffer,
            format: msg.format || "webm",
          });
          if (savedPath) {
            console.log(`[SpeakNote] 音声救出成功: ${savedPath}`);
            ws.send(JSON.stringify({
              type: "unprocessed_saved",
              path: savedPath,
              message: `音声を保存しました: ${path.basename(savedPath)}`,
            }));
          }
        } catch (e) {
          console.error("[SpeakNote] 音声救出失敗:", e.message);
        }
      } else if (msg.type === "whisper_chunk_request" && msg.audio && typeof msg.index === 'number') {
        // 新方式: チャンク単位で並列 Whisper 処理（await しない = 並列実行）
        // isProcessing はチャンク単位では設定しない（AI整形+ペースト中のみ true にする）
        const index = msg.index;
        const audio = msg.audio;
        const format = msg.format;
        const byteSize = Math.round(audio.length / 1024);
        console.log(`[SpeakNote] Chunk #${index} 送信 (${byteSize}KB)`);
        // 意図的に await しない → 複数チャンクが並列実行される
        (async () => {
          try {
            const result = await callTranscribeAPI(audio, format);
            const text = result.text || "";
            console.log(`[SpeakNote] Chunk #${index} 完了: ${text.substring(0, 40)}`);
            ws.send(JSON.stringify({ type: "whisper_chunk_result", index, text }));
          } catch (e) {
            console.error(`[SpeakNote] Chunk #${index} 失敗:`, e.message);
            ws.send(JSON.stringify({ type: "whisper_chunk_result", index, text: "", error: e.message }));
          }
        })();
      } else if (msg.type === "recording_failed") {
        // speech.html からのリセット通知（全チャンク失敗 or 空録音）
        isProcessing = false;
        console.log("[SpeakNote] 録音失敗/空録音でisProcessing=falseにリセット");
      } else if (msg.type === "result" && msg.text) {
        console.log("[SpeakNote] 認識結果(raw):", msg.text);
        const rawText = msg.text;
        const meta = msg.meta || null;
        let finalText = rawText;
        let aiCleanFailed = false;
        if (aiEnabled) {
          try {
            finalText = await cleanWithAI(rawText);
            console.log("[SpeakNote] 整形結果:", finalText);
          } catch (e) {
            console.error("[SpeakNote] AI整形失敗:", e.message);
            finalText = rawText;
            aiCleanFailed = true;
          }
        } else {
          console.log("[SpeakNote] そのまま出力:", finalText);
        }
        // Apply user dictionary
        for (const entry of userDict) {
          finalText = finalText.split(entry.from).join(entry.to);
        }

        // バックアップ保存（長時間録音または meta 付きの場合）
        if (meta) {
          try {
            const stamp = backup.nowStamp();
            const recordedAt = new Date().toISOString();
            backup.saveBackup({
              stamp,
              rawText,
              cleanedText: aiCleanFailed ? null : finalText,
              meta: { ...meta, recordedAt },
            });
          } catch (e) {
            console.error("[SpeakNote] バックアップ保存失敗:", e.message);
          }
        }

        isProcessing = false;
        pasteText(finalText);
        // Send both raw and final text back for diff detection
        ws.send(JSON.stringify({ type: "pasted", raw: rawText, text: finalText, aiCleanFailed }));
        ws.send(JSON.stringify({ type: "command", command: "done" }));
      } else if (msg.type === "chat_input" && msg.text) {
        console.log("[SpeakNote] 会話入力:", msg.text);
        try {
          const reply = await chatWithAI(msg.text);
          console.log("[SpeakNote] 会話応答:", reply);
          // Generate & play ElevenLabs TTS
          let useElevenLabs = false;
          if (ELEVENLABS_API_KEY) {
            try {
              const mp3Path = await elevenLabsTTS(reply);
              console.log("[SpeakNote] ElevenLabs TTS生成完了");
              // Play directly via PowerShell (bypasses Edge autoplay policy)
              const psCmd = `powershell -c "Add-Type -AssemblyName PresentationCore; $p = New-Object System.Windows.Media.MediaPlayer; $p.Open([uri]'${mp3Path.replace(/\\/g, '/')}'); Start-Sleep -Seconds 1; $p.Play(); while($p.Position -lt $p.NaturalDuration.TimeSpan){ Start-Sleep -Milliseconds 200 }; $p.Close()"`;
              exec(psCmd, { windowsHide: true, timeout: 30000 }, (err) => {
                if (err) console.error("[SpeakNote] TTS再生エラー:", err.message);
                else console.log("[SpeakNote] TTS再生完了");
                ws.send(JSON.stringify({ type: "command", command: "tts_done" }));
              });
              useElevenLabs = true;
            } catch (e) {
              console.error("[SpeakNote] ElevenLabs TTS失敗:", e.message, "→ブラウザTTSにフォールバック");
            }
          }
          ws.send(JSON.stringify({ type: "chat_reply", text: reply, useElevenLabs }));
        } catch (err) {
          console.error("[SpeakNote] 会話APIエラー:", err.message);
          ws.send(JSON.stringify({ type: "chat_error", error: err.message }));
        }
      } else if (msg.type === "chat_clear") {
        chatHistory = [];
        console.log("[SpeakNote] 会話履歴クリア");
        ws.send(JSON.stringify({ type: "chat_cleared" }));
      } else if (msg.type === "keep_save" && msg.text) {
        // Copy text to clipboard and open Google Keep via default browser (not msedge directly to avoid killing SpeakNote's Edge)
        const keepUrl = `https://keep.google.com/#NOTE`;
        clipboard.writeText(msg.text);
        exec(`start "" "${keepUrl}"`, (err) => {
          if (err) console.error("[SpeakNote] Keep open error:", err.message);
        });
        console.log("[SpeakNote] Keep保存: テキストをクリップボードにコピー済み");
        ws.send(JSON.stringify({ type: "command", command: "keep_done" }));
      } else if (msg.type === "setting") {
        if (msg.key === "aiEnabled") {
          aiEnabled = msg.value;
          console.log("[SpeakNote] AI整形:", aiEnabled ? "ON" : "OFF");
        } else if (msg.key === "chatMode") {
          chatMode = msg.value;
          console.log("[SpeakNote] モード:", chatMode ? "会話" : "整形");
          // Confirm back to Edge
          ws.send(JSON.stringify({ type: "command", command: chatMode ? "chat_mode_on" : "chat_mode_off" }));
        } else if (msg.key === "autoLearnEnabled") {
          autoLearnEnabled = msg.value;
          console.log("[SpeakNote] 自動学習:", autoLearnEnabled ? "ON" : "OFF");
        }
      } else if (msg.type === "dict_update") {
        userDict = msg.dict || [];
        console.log("[SpeakNote] 辞書更新:", userDict.length, "件");
      } else if (msg.type === "resize") {
        // Edge app mode doesn't support resizing, so we just log it
        console.log("[SpeakNote] パネル:", msg.expanded ? "展開" : "縮小");
      } else if (msg.type === "debug") {
        console.log("[SpeakNote][Edge]", msg.msg);
      }
    } catch (e) {
      console.error("[SpeakNote] WS message error:", e);
    }
  });

  ws.on("close", () => {
    console.log("[SpeakNote] Edge WebSocket切断");
    if (speechWs === ws) {
      speechWs = null;
      // Auto-relaunch Edge after 2 seconds if disconnected
      setTimeout(() => {
        if (!speechWs) {
          console.log("[SpeakNote] Edge自動再起動...");
          launchEdge();
        }
      }, 2000);
    }
  });
});

function startServer(port) {
  httpServer.listen(port, () => {
    console.log(`[SpeakNote] Server on port ${port} (HTTP + WebSocket)`);
  });
}
httpServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(`[SpeakNote] Port ${PORT} in use, trying ${PORT + 1}...`);
    startServer(PORT + 1);
  }
});
startServer(PORT);

// --- Launch Edge ---
function launchEdge() {
  const port = httpServer.address()?.port || PORT;
  const url = `http://localhost:${port}/`;
  exec(`start msedge --app="${url}" --window-size=320,360 --window-position=940,300`, (err) => {
    if (err) {
      exec(`start chrome --app="${url}" --window-size=320,360 --window-position=940,300`);
    } else {
      console.log("[SpeakNote] Edge起動");
    }
  });
}

// --- Tray ---
function createTray() {
  tray = new Tray(path.join(__dirname, "icon.ico"));
  tray.setToolTip("SpeakNote - 右Alt=録音 / F8=会話 / F9=トグル / F10=Keep / F11=AI切替");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Edge表示", click: launchEdge },
    { type: "separator" },
    { label: "終了", click: () => app.quit() },
  ]));
}

// --- App startup ---
app.whenReady().then(() => {
  createTray();

  // Wait for server then launch Edge
  const waitAndLaunch = () => {
    if (httpServer.listening) launchEdge();
    else setTimeout(waitAndLaunch, 200);
  };
  waitAndLaunch();

  console.log("[SpeakNote] AI整形: Vercel API経由 (" + VERCEL_API + ")");

  // アプリ起動直後にVercelを先行ウォームアップ（初回録音のコールドスタート回避）
  warmVercel();
  // 2分ごとに周期ウォームアップ（待機中もサーバを温める）
  setInterval(() => { try { warmVercel(); } catch {} }, 120000);

  // バックアップディレクトリ確保 + 古いファイルを自動削除（30日超）
  try {
    backup.ensureDirs();
    backup.cleanupOldBackups();
    const unprocessed = backup.listUnprocessed();
    if (unprocessed.length > 0) {
      console.log(`[SpeakNote] 未処理の音声ファイル ${unprocessed.length}件: ${backup.UNPROCESSED_DIR}`);
    }
  } catch (e) {
    console.error("[SpeakNote] バックアップ初期化失敗:", e.message);
  }

  // F9 toggle recording (debounced)
  let lastF9 = 0;
  globalShortcut.register("F9", () => {
    if (Date.now() - lastF9 < 500) return;
    lastF9 = Date.now();
    sendCommand("toggle");
  });

  // F10 = Save last result to Google Keep
  globalShortcut.register("F10", () => {
    if (!lastPastedText) {
      console.log("[SpeakNote] Keep保存: テキストなし");
      playBeep(300, 100); // low beep = no text
      return;
    }
    clipboard.writeText(lastPastedText);
    exec(`start "" "https://keep.google.com/#NOTE"`, (err) => {
      if (err) console.error("[SpeakNote] Keep open error:", err.message);
    });
    playBeep(1000, 80); setTimeout(() => playBeep(1200, 80), 100); // success beep
    console.log("[SpeakNote] Keep保存: クリップボードにコピー済み →", lastPastedText.substring(0, 30));
  });

  // F12 = Copy selection + auto-register to dictionary
  globalShortcut.register("F12", () => {
    if (!lastPastedText) {
      playBeep(300, 100);
      return;
    }
    // Ctrl+C to grab selected text
    execFile(keyhelper, ["copy"], (err) => {
      setTimeout(() => {
        const corrected = clipboard.readText().trim();
        if (!corrected || corrected === lastPastedText) {
          playBeep(300, 100);
          return;
        }
        // Find what changed and auto-register
        console.log("[SpeakNote] F12学習: 元=", lastPastedText, "→ 修正=", corrected);
        if (speechWs && speechWs.readyState === WebSocket.OPEN) {
          speechWs.send(JSON.stringify({ type: "learn_compare", original: lastPastedText, corrected: corrected }));
        }
        playBeep(1000, 80); setTimeout(() => playBeep(1200, 80), 100);
      }, 300);
    });
  });

  // F8 = Toggle chat mode (debounced)
  let lastF8 = 0;
  globalShortcut.register("F8", () => {
    if (Date.now() - lastF8 < 1000) return; // 1秒デバウンス
    lastF8 = Date.now();
    chatMode = !chatMode;
    if (chatMode) {
      playBeep(800, 80); setTimeout(() => playBeep(1200, 80), 100);
    } else {
      playBeep(1200, 80); setTimeout(() => playBeep(800, 80), 100);
    }
    sendCommand(chatMode ? "chat_mode_on" : "chat_mode_off");
    console.log("[SpeakNote] モード:", chatMode ? "会話" : "整形");
  });

  // F11 = Toggle AI cleanup
  globalShortcut.register("F11", () => {
    aiEnabled = !aiEnabled;
    sendCommand(aiEnabled ? "ai_on" : "ai_off");
    playBeep(aiEnabled ? 1000 : 400, 150);
    console.log("[SpeakNote] AI整形:", aiEnabled ? "ON" : "OFF");
  });

  // Alt/Option key detection (cross-platform)
  if (process.platform === "win32") {
    // === Windows: koffi (Win32 API) ===
    try {
      const koffi = require("koffi");
      const user32 = koffi.load("user32.dll");
      const GetAsyncKeyState = user32.func("short GetAsyncKeyState(int vKey)");
      const GetForegroundWindow = user32.func("uintptr_t GetForegroundWindow()");
      SetForegroundWindow = user32.func("int SetForegroundWindow(uintptr_t hWnd)");
      let altWasDown = false;
      let stopTimer = null;

      setInterval(() => {
        const isDown = (GetAsyncKeyState(0xA5) & 0x8000) !== 0; // 0xA5 = Right Alt only
        if (isDown && !altWasDown) {
          altWasDown = true;
          if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
          // 処理中（Whisper/AI整形中）はAlt入力をブロック → 前の記録が再書き込みされる問題を防止
          if (isProcessing) {
            console.log("[SpeakNote] Alt無視: 処理中");
            return;
          }
          if (autoLearnEnabled) checkPreviousPaste();
          savedHwnd = GetForegroundWindow();
          console.log("[SpeakNote] 保存hwnd:", savedHwnd);
          warmVercel();
          playStartBeep();
          sendCommand("start");
        } else if (!isDown && altWasDown) {
          altWasDown = false;
          if (isProcessing) return; // 処理中はstopも無視
          playStopBeep();
          stopTimer = setTimeout(() => { sendCommand("stop"); stopTimer = null; }, 600);
        }
      }, 80);

      console.log("[SpeakNote] 起動完了 - 右Alt押す=録音 / F9=トグル / ボタン");
    } catch (err) {
      console.log("[SpeakNote] Alt無効:", err.message);
    }
  } else if (process.platform === "darwin") {
    // === Mac: uiohook-napi で右Option検知 + トグル動作 ===
    try {
      const { uIOhook, UiohookKey } = require("uiohook-napi");
      let isRecording = false;

      // uiohook-napi のキーコード: RightAlt = 3640 (Mac では右Option相当)
      const RIGHT_OPTION = 3640;

      uIOhook.on('keydown', (e) => {
        if (e.keycode !== RIGHT_OPTION) return;
        // トグル動作（1回目=開始、2回目=終了）
        if (!isRecording) {
          isRecording = true;
          if (autoLearnEnabled) checkPreviousPaste();
          // 直前のフロントアプリ名を保存（osascript）
          execFile("osascript", ["-e",
            'tell application "System Events" to return name of first application process whose frontmost is true'
          ], { timeout: 1500 }, (err, stdout) => {
            if (!err) savedMacApp = stdout.trim();
            console.log("[SpeakNote] 保存App:", savedMacApp);
          });
          warmVercel();
          playStartBeep();
          sendCommand("start");
          console.log("[SpeakNote] 録音開始（右Option）");
        } else {
          isRecording = false;
          playStopBeep();
          sendCommand("stop");
          console.log("[SpeakNote] 録音終了（右Option）");
        }
      });

      uIOhook.start();
      console.log("[SpeakNote] 起動完了 - 右Option押す=録音トグル / F9=トグル / ボタン");
    } catch (err) {
      console.log("[SpeakNote] Option無効（Accessibility権限要確認）:", err.message);
    }
  } else {
    console.log("[SpeakNote] 起動完了 - F9=トグル / ボタン (Linux: キー無効)");
  }
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("will-quit", () => { globalShortcut.unregisterAll(); httpServer.close(); });
