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

// --- Load API key ---
const envPath = path.join(__dirname, "..", ".env.local");
let ANTHROPIC_API_KEY = "";
try {
  const envContent = fs.readFileSync(envPath, "utf-8");
  const match = envContent.match(/ANTHROPIC_API_KEY=(.+)/);
  if (match) ANTHROPIC_API_KEY = match[1].trim();
} catch {}

// --- AI text cleanup ---
function cleanWithAI(rawText) {
  return new Promise((resolve) => {
    if (!ANTHROPIC_API_KEY || !rawText.trim()) { resolve(rawText); return; }
    const body = JSON.stringify({
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
        { role: "user", content: rawText }
      ],
    });
    const req = https.request({
      hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Length": Buffer.byteLength(body) },
      timeout: 8000,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => { chunks.push(chunk); });
      res.on("end", () => {
        try {
          const data = Buffer.concat(chunks).toString("utf-8");
          resolve(JSON.parse(data).content?.[0]?.text?.trim() || rawText);
        } catch { resolve(rawText); }
      });
    });
    req.on("error", () => resolve(rawText));
    req.on("timeout", () => { req.destroy(); resolve(rawText); });
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
    setTimeout(() => SetForegroundWindow(savedHwnd), 100);
    setTimeout(() => SetForegroundWindow(savedHwnd), 250);
  }

  // Wait for focus restoration, then paste (keyhelper handles Alt-up + Ctrl+V)
  setTimeout(() => {
    // Verify focus before paste
    if (savedHwnd && SetForegroundWindow) {
      SetForegroundWindow(savedHwnd);
    }
    setTimeout(() => {
      execFile(keyhelper, ["paste"], (err) => {
        if (err) console.error("[SpeakNote] Paste error:", err.message);
        else {
          console.log("[SpeakNote] 貼り付け完了");
          if (autoLearnEnabled) {
            pendingLearnCheck = { text: text, hwnd: savedHwnd };
          }
        }
      });
    }, 150);
  }, 400);
}

// --- System beep via PowerShell (works even when Edge is background) ---
function playBeep(freq, duration) {
  exec(`powershell -c "[console]::beep(${freq},${duration})"`, { windowsHide: true });
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
  } else {
    res.writeHead(404); res.end();
  }
});

const wss = new WebSocket.Server({ server: httpServer });

wss.on("connection", (ws) => {
  console.log("[SpeakNote] Edge WebSocket接続!");
  speechWs = ws;

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
  tray.setToolTip("SpeakNote - Alt=録音 / F9=トグル / F10=Keep / F11=AI切替");
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

  console.log("[SpeakNote] AI整形:", ANTHROPIC_API_KEY ? "有効" : "無効");

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
        // Wait 1.5s after Alt release for speech recognition to finalize
        stopTimer = setTimeout(() => {
          sendCommand("stop");
          stopTimer = null;
        }, 1500);
      }
    }, 30);

    console.log("[SpeakNote] 起動完了 - Alt押す=録音 / F9=トグル / ボタン");
  } catch (err) {
    console.log("[SpeakNote] 起動完了 - F9=トグル / ボタン (Alt無効:", err.message + ")");
  }
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("will-quit", () => { globalShortcut.unregisterAll(); httpServer.close(); });
