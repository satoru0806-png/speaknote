# SpeakNote Mac 起動手順

## 前提
- macOS 12 以降
- Node.js 18+
- Xcode Command Line Tools（`xcode-select --install`）

## セットアップ

```bash
# 1. クローン（初回のみ）
git clone https://github.com/satoru0806-png/speaknote.git
cd speaknote

# 2. 最新コードを取得
git pull origin master

# 3. 依存パッケージインストール（uiohook-napiのnativeビルドあり）
npm install

# 4. 起動
npx electron .
```

## 初回起動時の重要な設定

### Accessibility（アクセシビリティ）権限

1. SpeakNote起動時に「アクセシビリティで入力監視」ダイアログが出る
2. システム設定 → プライバシーとセキュリティ → アクセシビリティ
3. **Electron** / **Terminal** / **Claude Code** を有効化
4. SpeakNoteを再起動

権限がないと右Option検知が動きません。

## 使い方

| 操作 | 動作 |
|------|------|
| **右Option（⌥）を1回押す** | 録音開始 |
| **もう1回押す** | 録音終了 → AI整形 → 直前アプリにCmd+V貼り付け |
| **F9キー** | 代替トグル（Electronウィンドウが前面にいる時） |

## 動作フロー

```
右Option押す
  → 直前のフロントアプリ名を保存（osascript）
  → 録音開始

もう1回押す
  → 録音停止
  → Whisperで文字起こし
  → AI整形（/api/clean）
  → クリップボードに書き込み
  → 直前アプリをactivate
  → 150ms待機
  → Cmd+V送信
```

## トラブルシュート

### 右Optionが反応しない
- Accessibility権限を再確認
- `uIOhook.start()`のログが出ているか確認
- uiohookのkeycodeを確認（3640が右Option）
  - `uIOhook.on('keydown', e => console.log(e.keycode))` でデバッグ

### ペーストされない
- Claude CodeかTerminalもAccessibility許可
- savedMacAppのログ確認
- osascriptエラーメッセージ確認

### ネイティブビルドに失敗
```bash
xcode-select --install
npm rebuild
```

## Windows版との違い

| 項目 | Windows | Mac |
|------|---------|-----|
| キー | 右Alt | 右Option（⌥） |
| 動作 | 押しっぱなし | トグル（1回目開始、2回目終了） |
| キー検知 | koffi + Win32 API | uiohook-napi |
| フォーカス復元 | SetForegroundWindow | AppleScript activate |
| 貼り付け | keyhelper.exe（SendInput） | osascript（Cmd+V） |

## 改善アイデア（将来）

- Touch Bar 対応
- Menu Bar アイコン表示
- Spotlight 起動統合
- 通知センター連携
