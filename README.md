# ｽﾀｯｸﾁｬﾝ Android Local Voice PoC

Android端末だけで、完全ローカルの日本語音声会話を動かすためのPoCです。

```text
Android microphone (16 kHz PCM)
        ↓
WebRTC VAD (20 ms frames) + adaptive RMS
        ↓
sherpa-onnx Whisper Small multilingual（language=ja）
        ↓
LiteRT-LM 0.14.0 / Gemma 4 E2BまたはE4B IT（GPU優先、CPU退避）
        ↓ streamed Japanese text
Piper Plus Android AAR + Japanese voice model
        ↓ PCM16
Android AudioTrack
```

M5StackChanとのUSBシリアル接続は次の段階です。音声I/Oは`PcmAudioSource`と
`PcmAudioSink`で分離してあり、Androidマイク／スピーカーをUSB実装へ交換できます。
`StackChanFrameCodec`にはPCM・制御・表情・動作用のフレーム形式も含めています。

## 実装済み

- LiteRT-LM 0.14.0とGemma 4 E2BまたはE4B ITによるアプリ内LLM推論
- E2BとE4Bの選択保存、およびモデルごとに独立した保存領域
- GPU初期化、モデル能力に応じたMTP有効化、GPU失敗時のCPU退避
- 選択したLLMを途中再開し、サイズとSHA-256を検証してから配置するアプリ内ダウンローダー
- RunAnywhere SDK 0.20.6によるWhisperファイル管理とONNXバックエンド登録
- sherpa-onnxを直接使い、認識器生成時に`language=ja`を固定するバッチSTT
- ランタイムに依存しない`LocalLanguageModel`境界と4ターンの短期履歴
- LiteRT-LMの会話セッションを再利用するストリーミング生成
- Gemmaのthinking無効化
- 句点単位でのPiper Plus逐次合成とAudioTrack再生
- タップ式Push-to-Talk
- WebRTC VADの20 msフレームと適応RMS判定を使う自動発話区切り
- 350 ms未満のクリック音などを破棄し、15秒の強制打ち切りまで待たない誤検出処理
- 自動会話中の「発話待ち」「発話中」表示
- Whisperの非音声字幕だけで構成された認識結果の破棄
- LLMの初回ページ読み込みをモデル準備中に行うウォームアップ
- APK更新後に保存済みGemmaとWhisperを再利用する処理
- 新経路の準備成功後に、旧版が保存したQwen3 4Bファイルだけを削除する移行処理
- RunAnywhere SDK初期化後のテレメトリ無効化
- 推論・再生の中断
- 推奨Piper Plus音声のダウンロード、SHA-256検証、辞書展開、自動ロード
- Piper音声モデル、JSON設定、OpenJTalk辞書のStorage Access Framework取込
- USBシリアル向けバイナリフレームcodecと単体テスト

## 開発環境

- Linux x86_64
- `curl`、`tar`、`unzip`
- Android Studio（IDEを使う場合）
- arm64-v8a Android端末、Android 8.0以上
- 初回モデル取得時のみインターネット接続
- Piper Plus Android AAR
- 任意音声を手動設定する場合は、Piper Plus互換の日本語`.onnx`、対応する`.json`、OpenJTalk辞書

E2Bの配布ファイルは2,588,147,712 bytes、E4Bは3,659,530,240 bytesです。
セットアップ開始時の空き容量は、E2Bで3.1GiB以上、E4Bで4.0GiB以上を目安にしてください。
両モデルは別々に保存されるため、両方を取得する場合はLiteRT-LMキャッシュ、Whisper、Piper Plusを含めて7GiB以上の余裕を確保してください。

JDK 17とAndroid SDKはプロジェクト内の`.toolchains/`へ導入します。
CLIビルドのGradleキャッシュも`.gradle-user-home/`へ分離するため、システム側のJavaやAndroid SDKを変更しません。

```bash
./scripts/bootstrap-dev.sh
./scripts/dev.sh java -version
```

セットアップスクリプトはTemurin 17.0.19+10、Android Command-line Tools 14742923、Android SDK 36、Build Tools 35.0.0を固定して導入します。
Android Studioから開く場合は、Gradle JDKに`.toolchains/temurin-17`を指定してください。

## 1. Piper Plus AARを確認する

この作業ディレクトリには、2026年7月14日時点の最新リリースである[Piper Plus v1.13.0](https://github.com/ayutaz/piper-plus/releases/tag/v1.13.0)から生成したAndroid AARを配置済みです。
公式リリースにはAndroid AARがないため、タグ`v1.13.0`のソースと同リリースworkflowのarm64-v8a成果物からローカルビルドしました。

```text
app/libs/piper-plus-release.aar
SHA-256: b43d4aeb46af952db7205106dfed68a51bab19fc8343370479a467caf9e3b688
```

次のコマンドで配置済みAARを検証できます。

```bash
sha256sum -c app/libs/piper-plus-release.aar.sha256
```

AARを差し替える場合は、インストールスクリプトを使います。

```bash
cd /path/to/stackchan-local-voice-poc
./scripts/install_piper_aar.sh \
  /path/to/piper-plus/android/piper-plus/build/outputs/aar/piper-plus-release.aar
```

スクリプトはPiper用ONNX Runtimeの名前をRunAnywhere側と分離し、AARとSHA-256記録を更新します。
AAR本体はサイズと再配布条件を考慮して`.gitignore`の対象にしています。
AAR未配置でもプロジェクトはコンパイルできますが、TTSのロードは無効です。
AARは`com.piperplus.PiperPlus`をリフレクションで読み込むため、配置後はGradle Syncと再ビルドが必要です。

## 2. Androidアプリをビルドする

Android Studioでルートディレクトリを開くか、CLIを使います。

```bash
./scripts/dev.sh ./gradlew :app:assembleDebug
```

`gradle-wrapper.jar`はプロジェクトに含めています。
Gradle 8.13の配布ZIPは`gradle-wrapper.properties`に記録したSHA-256と照合します。

## 3. 端末上でセットアップする

1. 「E2B（速度重視）」または「E4B（品質重視）」を選びます。
   E2Bは応答速度、E4Bは会話品質を比較するための選択肢です。
2. 「モデルをダウンロードして準備」を実行します。
   選択したGemma 4をアプリ内へ取得し、SHA-256検証、LiteRT-LMロード、初回ウォームアップまで行います。
   旧版のQwen3 4Bがアプリ内部に残っている場合は、新経路の準備成功後に削除して保存領域を回収します。
   中断したダウンロードは次回実行時に続きから再開します。
   GPUを利用できない端末ではCPUへ退避し、画面に実際のバックエンドを表示します。
3. 「推奨音声をダウンロードして準備」を実行します。
   初回はつくよみちゃんコーパスの利用条件を確認します。
   アプリが音声モデル、設定JSON、辞書ZIPを取得し、SHA-256検証、辞書展開、Piper Plusロードまで実行します。
4. 「録音開始」→発話→「録音終了・応答」で最初の会話を確認します。
5. Push-to-Talkが安定した後に「自動VAD」を有効にします。

任意のPiper Plus音声を使う場合は、「任意音声の手動設定」からONNX、JSON、OpenJTalk辞書を取り込み、「Piper Plusをロード」を実行します。

Gemmaはバックアップ対象外のアプリ内部ストレージ、Piper Plusのモデルと辞書は`files/piper-plus/`へ保存されます。
セットアップ後の推論、認識、合成はネットワークを使用しません。
LLM-HubやAI Edge Galleryなど、別アプリのインストールや起動は不要です。

## モデル設定を変更する

LLMの取得情報は`model/GemmaModelManifest.kt`、ASRの取得情報は`model/ModelCatalog.kt`にあります。

| 用途 | 構成 |
|---|---|
| LLM | Gemma 4 E2BまたはE4B IT、LiteRT-LM 0.14.0、最大コンテキスト2,048 tokens |
| STT | sherpa-onnx Whisper Small multilingual、`language=ja`、4 CPU threads |
| VAD | android-vad WebRTC 2.0.10、20 ms frames |
| TTS | 自動取得したつくよみちゃん音声、または端末から取り込んだPiper Plus日本語モデル |

LLMは`.litertlm`形式をLiteRT-LMで実行し、会話制御からは`LocalLanguageModel`として扱います。
現在のモデルURLはHugging Faceのrevisionへ固定し、ファイルサイズとSHA-256も固定しています。
別モデルへ差し替える場合は、形式だけでなくチャットテンプレート、thinking設定、MTP能力をアダプター側で確認してください。
既定のSTTは、RunAnywhere 0.20.6が呼び出し時の日本語指定をネイティブ認識器へ反映しないため、同梱されたsherpa-onnx 1.12.20を直接使います。
VADはWebRTC方式のため、外部モデルをダウンロードしません。
モデルごとのライセンスと再配布条件は、アプリ配布前に個別確認してください。

## テスト

プロジェクト構造と純Kotlin部分は次で確認できます。
`kotlinc`がない環境では、smoke testスクリプトが同等のGradle単体テストを実行します。

```bash
./scripts/dev.sh ./scripts/run_pure_kotlin_smoke.sh
python3 ./scripts/check_project.py
```

Android側の単体テストは、SDK環境で実行します。

```bash
./scripts/dev.sh ./gradlew :app:testDebugUnitTest
```

## 検証状況

- Piper Plus v1.13.0 AARを組み込んだdebug APK生成は通過
- GradleによるdebugコンパイルでLiteRT-LM 0.14.0 APIとの整合を確認
- motorola razr 50 ultra上でRunAnywhere ONNXとPiper Plus JNIの同時ロードを確認
- motorola razr 50 ultra上で旧Qwen3経路の会話開始を確認
- 修正版Whisperの1秒無音デコードは1.19秒で、認識言語`ja`を確認
- Gemma 4 E2Bのダウンロード、GPUロード、応答生成をmotorola razr 50 ultraで確認
- Gemma 4 E4Bのダウンロード、GPUロード、応答生成をmotorola razr 50 ultraで確認
- 推奨Piper Plus音声の自動取得、検証、辞書展開、非無音PCM生成をmotorola razr 50 ultraで確認

詳細は`VALIDATION.md`を参照してください。

## 次期設計

速度優先のLLM交換、ASR候補、発話区切り、Piper Plusの低遅延化、スタックチャンの表情とサーボ、物理操作を含む設計は[目標アーキテクチャ](docs/TARGET_ARCHITECTURE.md)にまとめています。

モデルの公表ベンチマークだけでは採用せず、motorola razr 50 ultra上のTTFT、生成速度、RTF、発熱で段階ごとに判定します。

## PoCの境界

この段階ではAndroid端末のマイクとスピーカーを使う半二重会話です。M5StackChanの
USB CDC接続、M5側PCM再生、表情・サーボ同期は未接続ですが、差し替え境界と
フレームcodecは用意しています。詳細は`docs/SERIAL_NEXT_STEP.md`を参照してください。
