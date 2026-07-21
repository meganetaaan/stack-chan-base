# Architecture

> この文書は、現在動作しているPoCの構成を記録する。
>
> 次期構成と移行順序は[TARGET_ARCHITECTURE.md](TARGET_ARCHITECTURE.md)を参照する。

## コンポーネント境界

```text
MainActivity / Compose UI
        │
MainViewModel
        │ events / commands
ConversationEngine
 ├─ PcmAudioSource       ← SerialPcmAudioSource / CoreS3 microphone
 ├─ EndpointDetector     ← WebRTC VADと適応RMS
 ├─ LocalSpeechRecognizer← sherpa-onnx Whisper Small
 ├─ LocalLanguageModel   ← LiteRT-LM / Gemma 4 E2BまたはE4B
 ├─ SpeechSynthesizer    ← PiperPlusReflectionSynthesizer
 └─ PcmAudioSink         ← SerialPcmAudioSink / CoreS3 AudioOut
```

`ConversationEngine`は推論SDKをimportせず、`LocalLanguageModel`と`LocalSpeechRecognizer`だけを参照します。

LLMは`LiteRtGemmaLanguageModel`が所有します。
同アダプターは、選択されたGemma 4 E2BまたはE4BをGPUで初期化し、OpenCL経路の初期化またはウォームアップ生成に失敗した場合だけCPUへ退避します。
会話セッションは履歴が一致する間再利用し、4ターンの履歴窓が移動した場合や生成を中断した場合に作り直します。

E2BとE4Bは別々のアプリ内部ディレクトリへ保存します。
選択状態はSharedPreferencesへ保存し、モデル変更時はロード済みエンジンを閉じてから新しいモデルを準備します。

RunAnywhereはWhisperファイルの取得と保存先管理だけに残しています。
認識処理はsherpa-onnxを直接呼び出し、LLM生成、VAD、TTSには使用しません。

モデル準備は`ModelSetupManager`が調整します。
`GemmaModelStore`は、選択されたモデルをHugging Faceの固定revisionから途中再開で取得し、期待サイズとSHA-256を検証してからatomic renameします。
旧版のQwen3 4Bについては、新経路の準備成功後に、既知のモデルIDとファイル名に一致するアプリ内部ファイルだけを削除します。
したがって、LLM-Hubなどの外部アプリは実行時依存に含まれません。

## 会話シーケンス

```text
LISTENING/RECORDING
  → TRANSCRIBING
  → THINKING
  → SPEAKING
  → LISTENING or IDLE
```

音声認識はCoreS3からUSB CDCで受信する16kHz、16bit、mono PCMです。
LLM出力はストリームで受信し、`SentenceChunker`が日本語の句点・疑問符・感嘆符で安定した文を切り出します。
各文をPiper Plusへ送り、全文生成の完了前に読み上げを開始します。
Piperのsample rateはAndroid側で既定24kHzへ逐次変換します。
変換後PCMは80ms単位にまとめて最大5秒のproducer queueへ入れ、USB送信だけをCoreS3のcreditで制御します。
これにより、Piperの次文合成は直前の文がCoreS3で消費されるまで待ちません。

CoreS3はUSBのpoll、フレーム処理、CRC32計算をCore 1の高優先度Workerで実行します。
Workerは1秒分のPCM queueへ500msをprebufferし、64KiBの共有ringを介してmain VMの`AudioOut`へ渡します。
`AudioOut`の未使用書き込み可能量は次のUSB frame到着まで保持します。
各文のUTF-8字幕はPCMと同じqueue順序で処理し、対応するPCMを書き込む直前に吹き出しへ表示します。
実再生中は自律表情を停止し、PCMのRMSから口の開きを更新します。

Gemmaのthinkingは、LiteRT-LMのテンプレートコンテキスト`enable_thinking=false`で無効にします。
会話制御にはGemma固有のプロンプト記法を置きません。

## Piper Plusの任意依存

Piper Plus AARは配布形態がローカルAARであるため、ソースコードは直接importしません。
`PiperPlusReflectionSynthesizer`が以下の公開APIを実行時に解決します。

- `PiperPlus.create(Context, modelPath, configPath, dictDir)`
- `getSampleRate()`
- `synthesize(String, speakerId)`
- `close()`

この設計により、AAR未配置でもRunAnywhere部分とUIをビルド・確認できます。

推奨音声は`PiperAssetStore`が準備します。
同ストアは固定revisionのONNXと設定JSON、および固定releaseの辞書ZIPを途中再開可能な形式で取得し、サイズとSHA-256を検証します。
辞書ZIPからは`piper/share/open_jtalk/dic/`だけを一時ディレクトリへ展開し、必須ファイルと展開先を検査してから既存辞書と入れ替えます。
すべての準備が成功した後に保存先を切り替えるため、失敗時も手動設定した音声資産は残ります。

推奨音声の利用条件確認は配布物の世代IDとともに保存します。
revisionまたはPiper Plusの固定版を変更した場合は、利用条件を再確認します。

## キャンセル

中断操作では、次をまとめて止めます。

- CoreS3マイクのUSBストリーム
- LiteRT-LM Conversation generation
- Piper Plus側の次回出力
- CoreS3 AudioOutのUSB再生キュー
- 会話セッションcoroutine

Piper Plusのone-shot native推論そのものを強制終了するAPIは使っていないため、合成中の
cancelは結果を破棄する方式です。文を短く区切ることで停止遅延を抑えています。
