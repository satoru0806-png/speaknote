const { app, BrowserWindow, Tray, Menu, clipboard, globalShortcut } = require("electron");
const path = require("path");
const http = require("http");
const https = require("https");
const { exec, execFile } = require("child_process");
const fs = require("fs");
const WebSocket = require("ws");

let tray;
let speechWs = null; // Active WebSocket connection to Edge
let savedHwnd = null; // Foreground window handle saved when Alt is pressed
let aiEnabled = true; // AI cleanup toggle
let autoLearnEnabled = false; // Auto-learn toggle
let userDict = []; // User dictionary [{from, to}]
let lastPastedText = ""; // Last pasted text for Keep saving
let chatMode = false; // false=整形, true=会話
let chatHistory = []; // [{role, content}, ...]
const MAX_CHAT_TURNS = 20;

// --- Vercel API base URL ---
const VERCEL_API = "https://web-five-alpha-24.vercel.app";

// --- Load optional keys (ElevenLabs only) ---
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

// --- AI text cleanup (via Vercel API) ---
function cleanWithAI(rawText) {
  return new Promise((resolve) => {
    if (!rawText.trim()) { resolve(rawText); return; }
    const body = JSON.stringify({ text: rawText });
    const req = https.request({
      hostname: new URL(VERCEL_API).hostname,
      path: "/api/clean",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => { chunks.push(chunk); });
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          resolve(data.cleaned || rawText);
        } catch { resolve(rawText); }
      });
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

function pasteText(text) {
  clipboard.writeText(text);
  lastPastedText = text; // Save for F10 Keep
  console.log("[SpeakNote] クリップボード:", text);

  // Restore focus to the window that was active when Alt was pressed
  if (savedHwnd && SetForegroundWindow) {
    console.log("[SpeakNote] フォーカス復元: hwnd=", savedHwnd);
    // Try 3 times to ensure focus is restored
    SetForegroundWindow(savedHwnd);
    setTimeout(() => SetForegroundWindow(savedHwnd), 80);
  }

  // Wait for focus restoration, then paste (keyhelper handles Alt-up + Ctrl+V)
  setTimeout(() => {
    if (savedHwnd && SetForegroundWindow) SetForegroundWindow(savedHwnd);
    setTimeout(() => {
      execFile(keyhelper, ["paste"], { timeout: 3000 }, (err) => {
        if (err) console.error("[SpeakNote] Paste error:", err.message);
        else {
          console.log("[SpeakNote] 貼り付け完了");
          if (autoLearnEnabled) {
            pendingLearnCheck = { text: text, hwnd: savedHwnd };
          }
        }
      });
    }, 100);
  }, 200);
}

// --- System beep (PowerShell singleton for speed) ---
let beepProcess = null;
function playBeep(freq, duration) {
  exec(`powershell -NoProfile -c "[console]::beep(${freq},${duration})"`, { windowsHide: true, timeout: 3000 });
}
function playStartBeep() { playBeep(1000, 80); }
function playStopBeep() { playBeep(800, 80); }

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
      if (msg.type === "result" && msg.text) {
        console.log("[SpeakNote] 認識結果(raw):", msg.text);
        const rawText = msg.text;
        let finalText = rawText;
        if (aiEnabled) {
          finalText = await cleanWithAI(rawText);
          console.log("[SpeakNote] 整形結果:", finalText);
        } else {
          console.log("[SpeakNote] そのまま出力:", finalText);
        }
        // Apply user dictionary
        for (const entry of userDict) {
          finalText = finalText.split(entry.from).join(entry.to);
        }
        pasteText(finalText);
        // Send both raw and final text back for diff detection
        ws.send(JSON.stringify({ type: "pasted", raw: rawText, text: finalText }));
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
  tray.setToolTip("SpeakNote - Alt=録音 / F8=会話 / F9=トグル / F10=Keep / F11=AI切替");
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

  // Alt key via koffi
  try {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");
    const GetAsyncKeyState = user32.func("short GetAsyncKeyState(int vKey)");
    const GetForegroundWindow = user32.func("void* GetForegroundWindow()");
    SetForegroundWindow = user32.func("int SetForegroundWindow(void* hWnd)");

    let altWasDown = false;
    let stopTimer = null;

    setInterval(() => {
      const isDown = (GetAsyncKeyState(0x12) & 0x8000) !== 0;
      if (isDown && !altWasDown) {
        altWasDown = true;
        if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
        // Check previous paste for corrections (only when auto-learn is ON)
        if (autoLearnEnabled) checkPreviousPaste();
        // Save the currently focused window BEFORE Edge gets focus
        savedHwnd = GetForegroundWindow();
        console.log("[SpeakNote] 保存hwnd:", savedHwnd);
        playStartBeep();
        sendCommand("start");
      } else if (!isDown && altWasDown) {
        altWasDown = false;
        playStopBeep();
        // Wait 600ms after Alt release for speech recognition to finalize
        stopTimer = setTimeout(() => {
          sendCommand("stop");
          stopTimer = null;
        }, 600);
      }
    }, 80);

    console.log("[SpeakNote] 起動完了 - Alt押す=録音 / F9=トグル / ボタン");
  } catch (err) {
    console.log("[SpeakNote] 起動完了 - F9=トグル / ボタン (Alt無効:", err.message + ")");
  }
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("will-quit", () => { globalShortcut.unregisterAll(); httpServer.close(); });
