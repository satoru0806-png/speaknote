# SpeakNote Android IME 設計書

**バージョン**: 1.0
**作成日**: 2026-03-09
**対象**: SpeakNote Android カスタムキーボード（IME）ネイティブアプリ化

---

## 1. システム全体構成図

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Android デバイス                              │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  任意のアプリ（LINE, Twitter, Gmail, メモ帳, etc.）             │  │
│  │                                                                 │  │
│  │   [テキスト入力フィールド]  ← InputConnection ← SpeakNote IME  │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                              ↑                                       │
│            Android IME Framework (InputMethodManager)               │
│                              ↑                                       │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │                 SpeakNote IME Service                          │   │
│  │  (com.speaknote.ime / SpeakNoteInputMethodService)            │   │
│  │                                                               │   │
│  │  ┌─────────────────┐   ┌──────────────────┐                  │   │
│  │  │  キーボード UI   │   │  音声入力モジュール │                 │   │
│  │  │  KeyboardView   │   │  VoiceRecorder   │                  │   │
│  │  │  ・日本語入力    │   │  ・録音制御       │                  │   │
│  │  │  ・英語入力     │   │  ・SpeechRecog   │                  │   │
│  │  │  ・数字入力     │   │    nizer API     │                  │   │
│  │  └─────────────────┘   └──────────────────┘                  │   │
│  │           ↓                       ↓                           │   │
│  │  ┌─────────────────────────────────────────┐                  │   │
│  │  │          コアロジック層                   │                  │   │
│  │  │  ・AI整形リクエスト管理                   │                  │   │
│  │  │  ・履歴管理（Room DB）                    │                  │   │
│  │  │  ・設定管理（DataStore）                  │                  │   │
│  │  │  ・InputConnection制御                   │                  │   │
│  │  └─────────────────────────────────────────┘                  │   │
│  └───────────────────────────────────────────────────────────────┘   │
│                              ↓                                       │
│                      ネットワーク層                                    │
└─────────────────────────────────────────────────────────────────────┘
                              ↓ HTTPS
┌─────────────────────────────────────────────────────────────────────┐
│              既存 Vercel バックエンド                                  │
│                                                                      │
│  POST /api/clean                                                     │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │  Claude Haiku (claude-haiku-4-5)                              │   │
│  │  ・フィラー除去（えーと、あのー）                                │   │
│  │  ・句読点追加                                                   │   │
│  │  ・言い直し修正                                                 │   │
│  └───────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. 技術スタック選定と理由

### 2.1 選定マトリクス

| 技術要素 | 選定技術 | 候補1 | 候補2 | 選定理由 |
|---------|---------|-------|-------|---------|
| 言語 | **Kotlin** | Java | Flutter | IME開発の公式言語、Android APIとの親和性最高 |
| 最低サポートバージョン | **Android 8.0 (API 26)** | Android 7.0 | Android 9.0 | 国内シェア95%以上をカバー、SpeechRecognizer安定版 |
| 音声認識 | **Android SpeechRecognizer API** | Google ML Kit | OpenAI Whisper | オフライン不可だがIMEとして実用的、追加費用ゼロ |
| ローカルDB | **Room** | SQLite直接 | Realm | Googleリコメンド、型安全、LiveData対応 |
| 設定管理 | **DataStore (Preferences)** | SharedPreferences | Room | 非同期対応、Coroutines親和性高 |
| 非同期処理 | **Kotlin Coroutines + Flow** | RxJava | AsyncTask | モダンAPI、軽量、テスタブル |
| HTTP通信 | **OkHttp + Retrofit** | Ktor | Volley | 枯れた実績、IMEの軽量要件に適合 |
| シリアライズ | **Kotlinx Serialization** | Gson | Moshi | Kotlin純正、反射なし |
| ビルドツール | **Gradle (Kotlin DSL)** | Groovy DSL | Maven | Android標準 |
| テスト | **JUnit5 + Espresso** | Robolectric | Mockito単体 | UIテストまで含む |

### 2.2 技術選定の根拠詳細

**なぜFlutterではなくネイティブKotlinか**
- IME（InputMethodService）はAndroid固有の低レベルAPIであり、Flutterでは実装困難
- InputConnection, KeyEvent, SoftKeyboardのレイアウト制御はネイティブAPIが必須
- IMEの応答速度要件（キータップ <50ms）にFlutterのPlatform Channelは不向き

**なぜWeb Speech APIではなくAndroid SpeechRecognizer APIか**
- IMEはWebView環境ではなくネイティブサービスとして動作するため、Web Speech APIが使用不可
- Android SpeechRecognizer APIはGoogle音声認識エンジンを直接利用し、品質は同等
- オフライン音声認識（オンデバイス）への切替も将来的に可能

**既存Vercelバックエンドを維持する理由**
- AI整形ロジック（Claude Haiku）をサーバーサイドに保持することでAPIキーの秘匿が可能
- ネイティブアプリにAPIキーを埋め込むのはリバースエンジニアリングのリスクがある
- バックエンドの改善がアプリアップデートなしで反映できる

---

## 3. 画面設計

### 3.1 キーボード UI（メイン画面）

```
┌─────────────────────────────────────────────────┐
│  SpeakNote キーボード（高さ: ~260dp）             │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │  [🎤 録音中... タップで停止]              │   │  ← 状態バー（32dp）
│  │  interim preview: "えーと今日の..."       │   │
│  └──────────────────────────────────────────┘   │
│                                                  │
│  ┌────────────────┐  ┌──────────────────────┐   │
│  │                │  │   AI整形  [ON] [OFF]  │   │  ← コントロールバー（48dp）
│  │   🎤 マイク    │  │   履歴   設定         │   │
│  │  (80x80dp)    │  └──────────────────────┘   │
│  └────────────────┘                              │
│                                                  │
│  ── 通常キーボード エリア ──────────────────────  │
│                                                  │
│  [あ][か][さ][た][な][は][ま][や][ら][わ][⌫]   │  ← 行1（46dp）
│  [い][き][し][ち][に][ひ][み] 　[り][を]        │
│  [う][く][す][つ][ぬ][ふ][む][ゆ][る][ん]       │
│  [え][け][せ][て][ね][へ][め] 　[れ][ー]        │
│  [お][こ][そ][と][の][ほ][も][よ][ろ][。]       │
│                                                  │
│  [あA1] [、] [　スペース　] [。] [改行↵]         │  ← 下部バー（52dp）
└─────────────────────────────────────────────────┘

状態遷移:
  idle   → 録音ボタン表示（グレー）
  recording → 波形アニメ + 赤背景 + 「タップで停止」
  processing → スピナー + 「AI整形中...」
  done   → 結果プレビュー（自動でフィールドに挿入済み）
  error  → エラーメッセージ（2秒後にidle）
```

### 3.2 キーボードモード切替

```
[あA1] ボタン長押し → モード選択パネル表示:
┌──────────────────────────────────────┐
│  ひらがな  |  ABC英字  |  123数字    │
└──────────────────────────────────────┘

英字モード:
[q][w][e][r][t][y][u][i][o][p][⌫]
[a][s][d][f][g][h][j][k][l][ ↵ ]
[⇧][z][x][c][v][b][n][m][.][⇧]
[あ][,][       space      ][.][↵]

数字モード:
[1][2][3][4][5][6][7][8][9][0][⌫]
[-][/][:][;][(][)][¥][@]["][↵ ]
[.][,][?][!][']["][+][=][#][%]
[あ][       space         ][↵]
```

### 3.3 音声入力結果パネル（録音停止後）

```
┌────────────────────────────────────────────────┐
│  ┌──────────────────────────────────────────┐  │
│  │  AI整形結果:                             │  │
│  │  「今日の会議はよろしくお願いします。」  │  │
│  │                                          │  │
│  │  [✓ 入力確定]  [✏ 編集]  [× 破棄]     │  │
│  └──────────────────────────────────────────┘  │
│  元テキスト: えーと今日の会議よろしくお願いします│
└────────────────────────────────────────────────┘
```

### 3.4 設定画面（独立Activity）

```
┌────────────────────────────────────────────────┐
│  ← SpeakNote 設定                              │
├────────────────────────────────────────────────┤
│  AI整形                                         │
│  ┌────────────────────────────────────────┐    │
│  │  AI整形を有効化           [  OFF ◉ ON] │    │
│  │  Vercel API URL (カスタム)              │    │
│  │  [https://speaknote.vercel.app       ] │    │
│  └────────────────────────────────────────┘    │
│                                                  │
│  音声認識                                        │
│  ┌────────────────────────────────────────┐    │
│  │  認識言語              [日本語 (ja-JP)] │    │
│  │  音声フィードバック          [ON ◉ OFF] │    │
│  │  認識タイムアウト         [30秒 ▼]      │    │
│  └────────────────────────────────────────┘    │
│                                                  │
│  キーボード                                      │
│  ┌────────────────────────────────────────┐    │
│  │  キーボード高さ    [標準 / 高め / 低め]  │    │
│  │  キータッチ音           [ON ◉ OFF]      │    │
│  │  バイブレーション         [ON ◉ OFF]    │    │
│  └────────────────────────────────────────┘    │
│                                                  │
│  データ                                          │
│  ┌────────────────────────────────────────┐    │
│  │  履歴の保存件数           [50件 ▼]      │    │
│  │  履歴を全削除              [削除]        │    │
│  └────────────────────────────────────────┘    │
│                                                  │
│  バージョン: 1.0.0                               │
└────────────────────────────────────────────────┘
```

### 3.5 履歴パネル（キーボード内スライドアップ）

```
[履歴] ボタンタップ → キーボードエリアが履歴表示に切替:

┌────────────────────────────────────────────────┐
│  履歴                              [× 閉じる]  │
├────────────────────────────────────────────────┤
│  14:32  「今日の会議はよろしくお願いします。」  │  ← タップで再入力
│  13:55  「メモを追加しておきます。」            │
│  11:20  「電話番号は090-1234-5678です。」       │
│  昨日   「明日の打ち合わせ、10時から会議室Bで」 │
│  昨日   「ありがとうございます。」              │
│                                                  │
│  [全履歴を削除]                                  │
└────────────────────────────────────────────────┘
```

---

## 4. モジュール構成

### 4.1 クラス・ファイル一覧

```
com.speaknote.ime
│
├── service/
│   └── SpeakNoteInputMethodService.kt
│       役割: InputMethodServiceを継承したIMEのエントリポイント
│       責務: キーボードView生成、InputConnection管理、ライフサイクル制御
│
├── keyboard/
│   ├── KeyboardView.kt
│   │   役割: カスタムキーボードUI（View）の描画・タッチイベント処理
│   │   責務: キーレイアウト表示、タップ/長押しイベント発行
│   │
│   ├── KeyboardLayout.kt
│   │   役割: キーレイアウトのデータモデル
│   │   責務: ひらがな/英字/数字モードのキー配列定義
│   │
│   └── KeyboardMode.kt
│       役割: キーボードモードのEnum
│       責務: HIRAGANA, ALPHABET, NUMBER, VOICE_RESULT の状態管理
│
├── voice/
│   ├── VoiceRecorderController.kt
│   │   役割: Android SpeechRecognizer APIのラッパー
│   │   責務: 録音開始/停止、認識結果/中間結果のFlow発行、エラー処理
│   │
│   └── VoiceState.kt
│       役割: 音声入力の状態モデル
│       責務: IDLE, RECORDING, PROCESSING, DONE, ERROR のSealed Class
│
├── ai/
│   ├── AiCleanRepository.kt
│   │   役割: AI整形APIとのデータレイヤ
│   │   責務: Vercel /api/clean へのHTTPリクエスト、レスポンスパース、オフラインフォールバック
│   │
│   ├── AiCleanRequest.kt
│   │   役割: リクエストDTOデータクラス
│   │
│   └── AiCleanResponse.kt
│       役割: レスポンスDTOデータクラス
│
├── history/
│   ├── HistoryDatabase.kt
│   │   役割: Room Databaseの定義
│   │
│   ├── HistoryDao.kt
│   │   役割: HistoryEntryのCRUD操作インターフェース
│   │
│   ├── HistoryEntity.kt
│   │   役割: 履歴テーブルのエンティティ（id, text, rawText, timestamp）
│   │
│   └── HistoryRepository.kt
│       役割: HistoryDaoのラッパー、Flow<List<HistoryEntity>>を提供
│
├── settings/
│   ├── SettingsDataStore.kt
│   │   役割: DataStore<Preferences>を使った設定管理
│   │   責務: aiEnabled, apiUrl, language, hapticFeedback 等の読み書き
│   │
│   └── SettingsActivity.kt
│       役割: 設定画面のActivity（AndroidManifestで宣言）
│
├── ui/
│   ├── ImeViewController.kt
│   │   役割: IMEのUIロジック調整（ViewModelの代替、Serviceとの橋渡し）
│   │   責務: VoiceState変化 → UI更新、履歴パネルの表示切替
│   │
│   └── KeyboardPanel.kt
│       役割: キーボードパネル全体のレイアウト（ConstraintLayout）
│
├── input/
│   └── InputCommitManager.kt
│       役割: InputConnectionへのテキスト送信
│       責務: commitText(), deleteSurroundingText(), sendKeyEvent() のラッパー
│
└── util/
    ├── AudioFeedback.kt
    │   役割: タップ音・バイブレーション制御
    │
    └── NetworkChecker.kt
        役割: ネットワーク接続確認（ConnectivityManager）
```

### 4.2 主要クラスの関係図

```
SpeakNoteInputMethodService (IME エントリポイント)
         │
         ├── creates ──→ KeyboardPanel (UI ルートView)
         │                    ├── KeyboardView (キー描画)
         │                    └── 状態バー, コントロールバー
         │
         ├── uses ──────→ ImeViewController
         │                    ├── observes ──→ VoiceRecorderController
         │                    │                    └── uses → SpeechRecognizer
         │                    ├── uses ──────→ AiCleanRepository
         │                    │                    └── uses → Retrofit + OkHttp
         │                    ├── uses ──────→ HistoryRepository
         │                    │                    └── uses → Room DAO
         │                    └── uses ──────→ SettingsDataStore
         │
         └── uses ──────→ InputCommitManager
                              └── uses → InputConnection (Android framework)
```

---

## 5. データフロー

### 5.1 音声入力 → テキスト出力の完全フロー

```
[ユーザー: マイクボタンをタップ]
          │
          ▼
VoiceRecorderController.startRecording()
  - SpeechRecognizer.startListening(intent)
  - intent.lang = "ja-JP"
  - intent.EXTRA_PARTIAL_RESULTS = true
          │
          ▼ (リアルタイム)
SpeechRecognizer.onPartialResults()
  - interim text を StateFlow<VoiceState.Recording> に emit
  - KeyboardPanel の状態バーにプレビュー表示
          │
[ユーザー: マイクボタンを再タップ]
          │
          ▼
VoiceRecorderController.stopRecording()
  - SpeechRecognizer.stopListening()
          │
          ▼
SpeechRecognizer.onResults()
  - finalText を取得
  - StateFlow<VoiceState.Processing> に emit
          │
          ▼ (条件分岐)
          ├── [AI整形 OFF の場合]
          │       │
          │       ▼
          │   InputCommitManager.commitText(finalText)
          │       └── InputConnection.commitText(text, 1)
          │           → テキストフィールドに即時入力
          │
          └── [AI整形 ON の場合]
                  │
                  ▼
          AiCleanRepository.clean(finalText)
            ├── NetworkChecker.isAvailable() == false
            │       → オフラインフォールバック: finalText をそのまま使用
            │
            └── OkHttp POST https://speaknote.vercel.app/api/clean
                  body: { "text": finalText }
                        │
                        ▼ (HTTPS)
                Vercel /api/clean
                  - Claude Haiku でフィラー除去・整形
                  - response: { "cleaned": "整形済みテキスト" }
                        │
                        ▼
          AiCleanResponse.cleaned を受信
                  │
                  ▼
          StateFlow<VoiceState.Done(cleanedText, rawText)> emit
                  │
                  ▼
          ImeViewController が状態を観察
            - 結果パネルをキーボードエリアに表示
            - cleanedText と rawText を表示
                  │
          [ユーザー: 「入力確定」ボタンタップ]
                  │
                  ▼
          InputCommitManager.commitText(cleanedText)
            └── InputConnection.commitText(cleanedText, 1)
                → 対象アプリのテキストフィールドに入力
                  │
                  ▼
          HistoryRepository.insert(HistoryEntity(cleanedText, rawText, now()))
            → Room DB に保存
                  │
                  ▼
          StateFlow<VoiceState.Idle> に戻る
```

### 5.2 通常キーボード入力フロー

```
[キータップ]
     │
     ▼
KeyboardView.onTouchEvent()
  - タップ座標からキーを特定
  - AudioFeedback.playClick() (設定ONの場合)
     │
     ▼ (キーの種類)
     ├── 文字キー → InputCommitManager.commitText(char)
     ├── 削除キー → InputCommitManager.deleteSurroundingText(1, 0)
     ├── Enter   → InputCommitManager.sendKeyEvent(KeyEvent.KEYCODE_ENTER)
     ├── スペース → InputCommitManager.commitText(" ")
     └── モード切替 → ImeViewController.switchMode(KeyboardMode)
```

### 5.3 履歴再利用フロー

```
[履歴ボタンタップ]
     │
     ▼
ImeViewController.showHistoryPanel()
  - HistoryRepository.getRecentHistory(50) を Flow で observe
  - 履歴一覧を KeyboardPanel 内に表示
     │
[履歴アイテムタップ]
     │
     ▼
InputCommitManager.commitText(historyItem.text)
  → テキストフィールドに入力
```

---

## 6. API連携設計

### 6.1 既存Vercelバックエンドとの接続

**エンドポイント**: `POST https://speaknote.vercel.app/api/clean`
**認証**: なし（CORS open）
**変更不要**: 既存APIをそのまま利用

**Retrofitインターフェース定義**:
```
interface SpeakNoteApiService {
    @POST("api/clean")
    suspend fun cleanText(@Body request: AiCleanRequest): AiCleanResponse
}

@Serializable data class AiCleanRequest(val text: String)
@Serializable data class AiCleanResponse(val cleaned: String)
```

**OkHttp設定**:
```
タイムアウト:
  - connect: 10秒
  - read: 30秒 (Claude APIの応答待ち)
  - write: 10秒

リトライ: 1回 (IMEの応答性を優先)
インターセプター: ログ出力 (デバッグビルドのみ)
```

### 6.2 エラーハンドリング戦略

| エラー種別 | 原因 | 対処 |
|-----------|------|------|
| ネットワーク未接続 | オフライン | 未整形テキストをそのまま入力、トースト通知 |
| タイムアウト (30秒超過) | サーバー高負荷 | フォールバック、次回リトライはユーザー操作時 |
| HTTP 500 | Vercelエラー | フォールバック + 「AI整形に失敗しました」通知 |
| HTTP 4xx | リクエスト異常 | フォールバック |
| 空レスポンス | Claudeが空返却 | 元テキストで代替 |

### 6.3 カスタムAPIエンドポイント対応

設定画面からAPIのベースURLを変更可能にする。
デフォルト値: `https://speaknote.vercel.app`
用途: 社内デプロイ版や個人Vercelへの切替に対応。

### 6.4 セキュリティ考慮

- APIキーはクライアント側に存在しない（すべてVercelサーバーサイドで管理）
- HTTPS必須（OkHttp の `HttpsURLConnection` デフォルト動作）
- 送信データは音声認識結果テキストのみ（個人情報の最小化）
- 将来的にAPIキー認証が必要になった場合: Android Keystore を使用してトークンを暗号化保存

---

## 7. 開発フェーズ分割

### Phase 1: IME基盤 + 音声入力 (4〜5週間)

**目標**: 最小限のIMEとして動作し、音声入力でテキストが入力できる状態

**Week 1-2: プロジェクト基盤**
- [ ] Androidプロジェクト作成（Kotlin, minSdk 26）
- [ ] `InputMethodService` の基本実装
- [ ] `AndroidManifest.xml` にIMEサービス宣言
- [ ] `method.xml` でIMEメタデータ定義
- [ ] シンプルなキーボードレイアウト（XML）の作成
- [ ] 日本語テキスト入力が対象アプリに届くことを確認

**Week 3-4: 音声入力実装**
- [ ] `SpeechRecognizer` API の統合
- [ ] マイクパーミッション（RECORD_AUDIO）リクエスト処理
- [ ] 録音中プレビュー（中間結果）表示
- [ ] 音声認識結果をテキストフィールドに送信

**Week 5: 安定化**
- [ ] エラーハンドリング実装（マイク拒否、認識失敗）
- [ ] 録音タイムアウト処理
- [ ] 音声フィードバック（ビープ音、バイブ）

**Phase 1 成果物**:
- 動作するAndroid APK（デバッグビルド）
- LINEやGmailで音声入力が可能な状態
- 内部テスト用APKの配布

---

### Phase 2: AI整形 + 通常キーボード + 履歴 (4〜5週間)

**目標**: 既存PWAと同等の機能をIMEとして実現

**Week 6-7: AI整形統合**
- [ ] Retrofit + OkHttp の導入
- [ ] `AiCleanRepository` 実装
- [ ] 非同期処理（Coroutines）でUI非ブロック
- [ ] AI整形ON/OFFトグル
- [ ] AI整形結果の確認パネル表示
- [ ] オフライン時フォールバック

**Week 8: 通常キーボード**
- [ ] ひらがなキーボードの完全実装
- [ ] 英数字キーボードの実装
- [ ] モード切替（あA1ボタン）
- [ ] 長押し（濁音、半濁音）
- [ ] 基本的な日本語変換（ローマ字入力は Phase 3 で対応）

**Week 9: 履歴機能**
- [ ] Room Database スキーマ設計・実装
- [ ] `HistoryDao`, `HistoryRepository` 実装
- [ ] キーボード内履歴パネルUI
- [ ] 履歴タップで再入力

**Week 10: 設定画面**
- [ ] `SettingsActivity` 実装
- [ ] DataStore による設定永続化
- [ ] APIエンドポイントカスタム設定

**Phase 2 成果物**:
- PWAと同等機能のIME APK
- 設定画面付き
- クローズドベータテスト（Google Play 内部テスト）

---

### Phase 3: 品質向上 + Play Store リリース (3〜4週間)

**目標**: 一般ユーザーが安心して使えるアプリとしてPlay Storeに公開

**Week 11-12: UX向上**
- [ ] アニメーション（録音中波形、マイクボタンパルス）
- [ ] キーボード高さのカスタマイズ
- [ ] 日本語変換候補バー（かな→漢字変換、Google IME APIまたは独自辞書）
- [ ] ダークテーマ対応
- [ ] タブレット対応レイアウト

**Week 13: テスト・品質**
- [ ] JUnit5 ユニットテスト（Repository層）
- [ ] Espresso UIテスト（基本フロー）
- [ ] 複数端末での動作確認（Samsung, Pixel, AQUOS）
- [ ] メモリリーク確認（LeakCanary）
- [ ] ProGuard/R8 難読化設定

**Week 14: Play Store 準備・リリース**
- [ ] 署名付きリリースAPK / AABビルド
- [ ] Play Store コンソール設定
- [ ] ストア掲載用スクリーンショット（8枚）
- [ ] プロモーション用グラフィック
- [ ] プライバシーポリシーページ（必須）
- [ ] リリースノート記載
- [ ] 段階的ロールアウト（20% → 50% → 100%）

**Phase 3 成果物**:
- Google Play Store 公開版
- プライバシーポリシーURL
- 監視ダッシュボード（Firebase Crashlytics）

---

## 8. ディレクトリ構成

```
speaknote-android/
├── app/
│   ├── src/
│   │   ├── main/
│   │   │   ├── AndroidManifest.xml
│   │   │   ├── java/com/speaknote/ime/
│   │   │   │   ├── SpeakNoteApp.kt                  # Application クラス
│   │   │   │   ├── service/
│   │   │   │   │   └── SpeakNoteInputMethodService.kt
│   │   │   │   ├── keyboard/
│   │   │   │   │   ├── KeyboardView.kt
│   │   │   │   │   ├── KeyboardLayout.kt
│   │   │   │   │   └── KeyboardMode.kt
│   │   │   │   ├── voice/
│   │   │   │   │   ├── VoiceRecorderController.kt
│   │   │   │   │   └── VoiceState.kt
│   │   │   │   ├── ai/
│   │   │   │   │   ├── AiCleanRepository.kt
│   │   │   │   │   ├── AiCleanRequest.kt
│   │   │   │   │   └── AiCleanResponse.kt
│   │   │   │   ├── history/
│   │   │   │   │   ├── HistoryDatabase.kt
│   │   │   │   │   ├── HistoryDao.kt
│   │   │   │   │   ├── HistoryEntity.kt
│   │   │   │   │   └── HistoryRepository.kt
│   │   │   │   ├── settings/
│   │   │   │   │   ├── SettingsDataStore.kt
│   │   │   │   │   └── SettingsActivity.kt
│   │   │   │   ├── ui/
│   │   │   │   │   ├── ImeViewController.kt
│   │   │   │   │   └── KeyboardPanel.kt
│   │   │   │   ├── input/
│   │   │   │   │   └── InputCommitManager.kt
│   │   │   │   └── util/
│   │   │   │       ├── AudioFeedback.kt
│   │   │   │       └── NetworkChecker.kt
│   │   │   ├── res/
│   │   │   │   ├── layout/
│   │   │   │   │   ├── keyboard_panel.xml           # キーボード全体レイアウト
│   │   │   │   │   ├── keyboard_status_bar.xml      # 状態表示バー
│   │   │   │   │   ├── keyboard_control_bar.xml     # マイク・AI切替バー
│   │   │   │   │   ├── keyboard_result_panel.xml    # 認識結果確認パネル
│   │   │   │   │   ├── keyboard_history_panel.xml   # 履歴パネル
│   │   │   │   │   └── activity_settings.xml        # 設定画面
│   │   │   │   ├── xml/
│   │   │   │   │   └── method.xml                   # IMEメタデータ
│   │   │   │   ├── drawable/
│   │   │   │   │   ├── ic_mic.xml
│   │   │   │   │   ├── ic_mic_active.xml
│   │   │   │   │   ├── bg_key_normal.xml
│   │   │   │   │   ├── bg_key_special.xml
│   │   │   │   │   └── anim_mic_pulse.xml
│   │   │   │   ├── values/
│   │   │   │   │   ├── strings.xml
│   │   │   │   │   ├── colors.xml
│   │   │   │   │   ├── dimens.xml
│   │   │   │   │   └── themes.xml
│   │   │   │   └── values-night/
│   │   │   │       └── themes.xml                   # ダークテーマ
│   │   │   └── assets/
│   │   │       └── keyboard_layouts/
│   │   │           ├── hiragana.json
│   │   │           ├── alphabet.json
│   │   │           └── number.json
│   │   ├── test/
│   │   │   └── java/com/speaknote/ime/
│   │   │       ├── AiCleanRepositoryTest.kt
│   │   │       ├── HistoryRepositoryTest.kt
│   │   │       └── VoiceRecorderControllerTest.kt
│   │   └── androidTest/
│   │       └── java/com/speaknote/ime/
│   │           └── ImeFlowTest.kt
│   └── build.gradle.kts
├── build.gradle.kts
├── settings.gradle.kts
├── gradle/
│   └── libs.versions.toml                           # バージョンカタログ
├── keystore/
│   └── speaknote-release.jks                        # 署名キー（gitignore必須）
├── .gitignore
└── README.md
```

### AndroidManifest.xml 重要設定

```xml
<!-- IMEサービス宣言（必須） -->
<service
    android:name=".service.SpeakNoteInputMethodService"
    android:label="SpeakNote"
    android:permission="android.permission.BIND_INPUT_METHOD"
    android:exported="true">
    <intent-filter>
        <action android:name="android.view.InputMethod" />
    </intent-filter>
    <meta-data
        android:name="android.view.im"
        android:resource="@xml/method" />
</service>

<!-- 設定画面 -->
<activity
    android:name=".settings.SettingsActivity"
    android:label="SpeakNote 設定"
    android:exported="false" />

<!-- 必要なパーミッション -->
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.VIBRATE" />
```

---

## 9. リスクと対策

### 9.1 技術リスク

| リスク | 発生確率 | 影響度 | 対策 |
|--------|---------|--------|------|
| SpeechRecognizerがバックグラウンドサービス（IME）で動作しない | 中 | 高 | Phase 1 Week 1で最初に検証。代替: RecognizerIntent で音声入力Activityを起動 |
| RECORD_AUDIO パーミッションがIMEで取得できない | 中 | 高 | IMEでは通常のruntime permissionが使えないため、専用のPermissionActivity経由でリクエスト |
| キーボード高さがアプリによって異なる | 低 | 中 | WindowInsets API で動的に高さを調整、最小高さ保証 |
| Android 14以降のバックグラウンドマイク制限 | 低 | 高 | IMEはフォアグラウンドサービスに相当するため問題なし（要検証） |
| Vercel Cold Start によるAI整形遅延（3秒超） | 中 | 中 | タイムアウト30秒設定、フォールバック実装、将来的にサーバーレス関数のウォームアップ |
| 日本語変換（かな漢字）の実装複雑度 | 高 | 中 | Phase 3で対応、Phase 2はひらがな直接入力のみ。既存IMEライブラリ（Mozc/Google IME SDK）の調査 |

### 9.2 リスク詳細: SpeechRecognizer in IME

IMEはServiceとして動作するため、`SpeechRecognizer` の利用に制約がある可能性がある。

**対策A（推奨）**: `SpeechRecognizer.createSpeechRecognizer(context)` をIMEサービスのコンテキストで直接作成し、Phase 1 Week 1で動作検証する。

**対策B（フォールバック）**: `RecognizerIntent.ACTION_RECOGNIZE_SPEECH` を使い、別Activityで音声認識を行い、結果をIMEに返す。ユーザー体験はやや劣るが確実に動作する。

**対策C（将来）**: Google ML Kit Speech-to-Text（オンデバイス）を使用することでバックグラウンド制約を回避。

### 9.3 ビジネスリスク

| リスク | 対策 |
|--------|------|
| Claude APIの料金増加 | Vercel側でレート制限実装、月間上限設定 |
| Google Play ポリシー違反（マイク権限の説明不足） | プライバシーポリシーページ作成、権限説明ダイアログの充実 |
| ユーザーの入力データプライバシー懸念 | AI整形OFF時はオンデバイス処理のみ、プライバシーポリシーで明記 |
| Android バージョン断片化 | minSdk 26（Android 8.0）以上に限定、古い端末は対象外 |

---

## 10. 配布方法（Google Play Store）

### 10.1 リリース前チェックリスト

**アカウント設定**
- [ ] Google Play Developer アカウント作成（登録料: $25 USD 一回のみ）
- [ ] 開発者名・連絡先の登録
- [ ] 支払い情報の設定（有料アプリ配布時）

**アプリ設定**
- [ ] アプリのパッケージ名確定: `com.speaknote.ime`（変更不可のため慎重に）
- [ ] バージョンコード・バージョン名の管理ポリシー決定
- [ ] 署名キー（.jks）の作成・安全な保管（紛失するとアップデート不可）

**必須ドキュメント**
- [ ] プライバシーポリシーページ（Webページ必須）
  - 収集するデータ: 音声認識結果テキスト（AI整形ON時のみサーバー送信）
  - データの用途: テキスト整形のみ、サーバーに保存しない
  - 第三者への提供: なし（Claude API経由だがAnthropicのポリシーを参照）
- [ ] 利用規約ページ

**ストア掲載素材**
- [ ] アプリアイコン: 512×512px PNG
- [ ] 機能グラフィック: 1024×500px
- [ ] スクリーンショット: 最低2枚、最大8枚（16:9 または 9:16）
- [ ] 短い説明: 80文字以内
- [ ] 詳細説明: 4000文字以内

### 10.2 リリース戦略

**段階1: 内部テスト**
- 対象: 開発チームメンバー（最大100人）
- 目的: 基本動作確認
- 期間: Phase 1 完了後〜

**段階2: クローズドテスト（アルファ）**
- 対象: 招待制ベータテスター（知人・Twitterフォロワー）
- 目的: 一般ユーザーフィードバック収集
- 期間: Phase 2 完了後〜

**段階3: オープンテスト（ベータ）**
- 対象: Play Storeで任意参加
- 目的: 大規模ユーザーテスト
- 期間: Phase 3 中〜

**段階4: 一般公開**
- 段階的ロールアウト: 20% → 50% → 100%（各段階1週間）
- Crashlyticsでクラッシュ率監視（1%超過で即時ロールバック）

### 10.3 ビルド設定

```
リリースビルド:
  - minSdk: 26 (Android 8.0)
  - targetSdk: 35 (Android 15)
  - compileSdk: 35
  - 形式: AAB (Android App Bundle) ← Play Store 必須
  - 難読化: R8/ProGuard 有効
  - 署名: リリースキーストアで署名

バージョン管理ポリシー:
  versionCode: 自動インクリメント（CI/CDで管理）
  versionName: セマンティックバージョニング（1.0.0, 1.1.0, ...）
```

### 10.4 将来的な収益化オプション（参考）

| モデル | 説明 | 実装時期 |
|--------|------|---------|
| 無料（現在方針） | AI整形コストはVercelで負担 | Phase 3 |
| フリーミアム | 月50回無料、それ以上は月額300円 | 将来 |
| 買い切り | 980円の一回払い | 将来 |
| 企業向けライセンス | 独自APIキー設定可能なエンタープライズ版 | 将来 |

---

## 付録A: 主要な依存ライブラリ（libs.versions.toml）

```toml
[versions]
kotlin = "2.0.0"
agp = "8.5.0"
coroutines = "1.8.1"
retrofit = "2.11.0"
okhttp = "4.12.0"
room = "2.6.1"
datastore = "1.1.1"
kotlinx-serialization = "1.7.1"
leakcanary = "2.14"
firebase-crashlytics = "19.0.3"

[libraries]
kotlin-stdlib = { module = "org.jetbrains.kotlin:kotlin-stdlib", version.ref = "kotlin" }
kotlinx-coroutines-android = { module = "org.jetbrains.kotlinx:kotlinx-coroutines-android", version.ref = "coroutines" }
retrofit = { module = "com.squareup.retrofit2:retrofit", version.ref = "retrofit" }
retrofit-kotlinx-serialization = { module = "com.jakewharton.retrofit:retrofit2-kotlinx-serialization-converter", version = "1.0.0" }
okhttp = { module = "com.squareup.okhttp3:okhttp", version.ref = "okhttp" }
okhttp-logging = { module = "com.squareup.okhttp3:logging-interceptor", version.ref = "okhttp" }
room-runtime = { module = "androidx.room:room-runtime", version.ref = "room" }
room-ktx = { module = "androidx.room:room-ktx", version.ref = "room" }
room-compiler = { module = "androidx.room:room-compiler", version.ref = "room" }
datastore-preferences = { module = "androidx.datastore:datastore-preferences", version.ref = "datastore" }
kotlinx-serialization-json = { module = "org.jetbrains.kotlinx:kotlinx-serialization-json", version.ref = "kotlinx-serialization" }
leakcanary = { module = "com.squareup.leakcanary:leakcanary-android", version.ref = "leakcanary" }
firebase-crashlytics = { module = "com.google.firebase:firebase-crashlytics", version.ref = "firebase-crashlytics" }
```

---

## 付録B: method.xml（IMEメタデータ）

```xml
<!-- res/xml/method.xml -->
<?xml version="1.0" encoding="utf-8"?>
<input-method
    xmlns:android="http://schemas.android.com/apk/res/android"
    android:settingsActivity="com.speaknote.ime.settings.SettingsActivity"
    android:supportsSwitchingToNextInputMethod="true">
    <subtype
        android:label="日本語"
        android:imeSubtypeLocale="ja"
        android:imeSubtypeMode="keyboard" />
    <subtype
        android:label="English"
        android:imeSubtypeLocale="en_US"
        android:imeSubtypeMode="keyboard" />
</input-method>
```

---

## 付録C: PWAからの移行対応表

| PWA機能 | 使用技術 | Android IME実装 |
|---------|---------|----------------|
| Web Speech API | ブラウザ標準API | Android SpeechRecognizer API |
| fetch('/api/clean') | Fetch API | Retrofit + OkHttp |
| localStorage | ブラウザストレージ | Room DB + DataStore |
| navigator.clipboard | Clipboard API | InputConnection.commitText() |
| CSS animations | CSS | Android Animator / ObjectAnimator |
| Service Worker | PWA | 不要（ネイティブアプリ） |
| manifest.json | PWAマニフェスト | AndroidManifest.xml |

---

*設計書バージョン 1.0 - SpeakNote Android IME*
