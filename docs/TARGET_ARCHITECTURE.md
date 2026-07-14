# Androidローカル音声対話の目標アーキテクチャ

更新日：2026年7月14日

状態：E2Bの実機動作を確認、E4Bの選択経路を実装

対象端末：motorola razr 50 ultra

この文書は、現在動作しているPoCを、低遅延の音声対話とスタックチャンの身体表現へ段階的に発展させるための設計である。

現行実装の構成は[ARCHITECTURE.md](ARCHITECTURE.md)に、実測値は[VALIDATION.md](../VALIDATION.md)に記録している。

## 実装反映状況

2026年7月14日に、LLM交換の第一段階をソースへ反映した。

| 項目 | 状態 |
|---|---|
| `LocalLanguageModel`境界 | 導入済み。`ConversationEngine`からRunAnywhereのLLM APIを除去 |
| Gemma 4 E2B | LiteRT-LM 0.14.0で実装済み。razr 50 ultraでGPU推論を確認 |
| Gemma 4 E4B | E2Bと切替可能。ダウンロードと実機推論は未検証 |
| MTP | モデル能力を検査し、GPU経路で有効化 |
| モデル取得 | アプリ内ダウンロード、途中再開、容量検査、サイズ検査、SHA-256検査を実装 |
| 会話セッション | 履歴が一致する間は再利用し、履歴窓の移動または中断時に再生成 |
| 外部アプリ | LLM-Hub、AI Edge Gallery、AICoreへ依存しない |
| 実機性能 | E2Bの応答生成を確認。E4Bの速度、メモリ、会話品質は未測定 |

LLM-HubのソースはPolyForm Noncommercial Licenseであるため、コードは移植していない。
実装はApache License 2.0のLiteRT-LM公式Kotlin APIと公開モデル情報だけを使用している。

## 採用方針

ASR、LLM、TTSを順に接続するカスケード構成は維持する。

モデルや推論ランタイムは会話制御から分離し、実機測定の結果に応じて各段を単独で交換できるようにする。

速度優先の第一候補は、次の構成である。

| 段 | 第一候補 | 代替候補 |
|---|---|---|
| 発話開始検知 | WebRTC VADと適応RMS | sherpa-onnx Silero VAD |
| 発話終了判定 | 調整可能な無音判定 | Androidへ移植したVAP |
| ASR | Parakeet TDT-CTC 0.6B Japanese int8のCTC経路 | ReazonSpeech Zipformer、現行Whisper Small |
| LLM | Gemma 4 E2BまたはE4B ITとLiteRT-LMのGPU経路 | Qwen3.5 2BとRunAnywhereのCPU経路 |
| TTS | Piper Plus | 当面は設けない |
| 音声入出力 | スタックチャンとのUSBシリアル | Android端末のマイクとスピーカー |
| 身体表現 | 状態駆動の表情、口、名前付きモーション | 制約付きのLLM補助判断 |

Gemma 4 E2Bを選ぶ理由は、モデル単体の能力だけではない。

GoogleがAndroid向けにGPU実行、モバイル量子化、Multi-Token Predictionを同じランタイムで提供しており、現行のCPU中心の4B推論より高速化の余地が大きいからである。

ただし、Googleが公開した52 tokens/sという値はSamsung S26 Ultraでの測定値であり、razr 50 ultraの予測値としては扱わない。

razr 50 ultra上のTTFT、生成速度、メモリ、発熱を測り、後述の採用条件を満たした場合に限って既定経路へ切り替える。

## 書籍から取り入れる設計

参考書籍は[book_sakura.pdf](../../book_sakura.pdf)の『オープンソースで作る音声対話AI』である。

書籍の記述とこのPoCへの反映を次に示す。

| 書籍の論点 | この設計への反映 |
|---|---|
| 第1章のカスケード型処理パイプライン | ASR、LLM、TTSの境界を保ち、エンドツーエンド音声モデルには置き換えない |
| 第3章のVADとVAP | 軽量VADを常時動作させ、発話終了だけを交換可能なTurnTakingPolicyへ分離する |
| 第4章の日本語ASR比較 | Parakeet 0.6B Japaneseを第一の比較候補にする |
| 第5章の2B級SLM | Qwen3.5 2Bを比較対象にし、スマートフォン向け実行経路を持つGemma 4 E2Bも同じ条件で測る |
| 第6章の軽量TTS | 既に動作しているPiper Plusを維持する |
| 第7章の表示遅延 | 表情と口の動きをLLMの後処理にせず、会話状態と再生PCMへ直接同期する |

書籍の評価値は候補選定の根拠にはなるが、対象端末での性能を保証しない。

モデルの採否は、同じ音声、同じプロンプト、同じ温度条件を使う実機測定で決める。

## 現行PoCの制約

### LLMが会話制御へ直結している

[ConversationEngine.kt](../app/src/main/java/jp/stackchan/localvoicepoc/conversation/ConversationEngine.kt)はRunAnywhereの静的APIを直接呼び出している。

この依存関係では、LiteRT-LMを試すために会話制御まで変更する必要があり、ランタイム間の公平な比較も難しい。

旧Qwen3 4B経路では、修正前のTTFTが30.530秒であり、ウォームアップも初回15.260秒、ページキャッシュ後3.323秒だった。

会話時に10秒以上かかるという実機観測もあるため、LLM交換を最初の性能改善対象にする。

### 発話終了だけで800ミリ秒を消費する

[UtteranceAccumulator.kt](../app/src/main/java/jp/stackchan/localvoicepoc/conversation/UtteranceAccumulator.kt)は、発話終了条件を800ミリ秒の連続無音に固定している。

この値は短い雑音を誤発話として扱う問題を避ける一方、正常な発話にも必ず待ち時間を加える。

開始判定、終了判定、短い衝撃音の除外を別の判断として測定できる構造が必要である。

### 音声認識はWhisperのバッチ処理である

現行Whisper Smallは、一秒の無音に対して1.192秒を要した。

この値は実発話の実時間係数ではないため、発話長別の測定を追加してから別モデルと比較する。

### TTSの上流機能を利用していない

Piper Plus上流にはストリーミングC APIと音素タイミング出力がある。

現行AARアダプターは文全体からShortArrayを得る一括合成であり、上流のストリーミングとタイミングを公開していない。

[SentenceChunker.kt](../app/src/main/java/jp/stackchan/localvoicepoc/conversation/SentenceChunker.kt)も、句点がない場合は52文字まで合成を始めない。

LLMの高速化後は、この二点が最初の可聴音までの遅延として残る。

### シリアルcodecはパケット単位に限られる

[StackChanFrame.kt](../app/src/main/java/jp/stackchan/localvoicepoc/serial/StackChanFrame.kt)は、フレームのエンコード、デコード、CRC検査を実装している。

USBから届く任意長のバイト列を連続的に読み、途中フレームを保持し、破損後に再同期する処理はまだない。

センサーイベント、再生位置、フロー制御、動作の安全条件も未定義である。

## 目標コンポーネント

会話制御は推論ランタイムとハードウェアの両方から独立させる。

~~~text
                         ConversationCoordinator
                                   │
       ┌───────────────────────────┼───────────────────────────┐
       │                           │                           │
   音声入力経路                対話生成経路                 身体反応経路
       │                           │                           │
 AudioInput                  SpeechRecognizer          InteractionInput
       │                           │                           │
 TurnDetector               LanguageModel             InteractionRouter
       │                           │                           │
 TurnTakingPolicy           SpeechChunker                    │
       └───────────────▶     SpeechSynthesizer          BehaviorDirector
                                   │                           │
                              AudioOutput                BehaviorOutput
                                   │                           │
                         StackChanConnection ◀────────────────┘

 各コンポーネント ───────────────▶ TurnTelemetry
~~~

**ConversationCoordinator**は、一回の発話をASR、LLM、TTSへ渡し、キャンセルと状態遷移を管理する。

**TurnDetector**は音声フレームごとの発話開始を検出する。

**TurnTakingPolicy**は、現在の発話を確定するか、続きを待つか、短い雑音として破棄するかを決める。

**LanguageModel**は、ランタイム固有のチャットテンプレートを隠し、テキスト差分だけを会話制御へ返す。

**InteractionRouter**は、頭への接触、筐体の振動、画面タップを会話命令と非言語反応へ振り分ける。

**BehaviorDirector**は、会話状態、物理操作、再生PCMから表情と名前付きモーションを決める。

**TurnTelemetry**は、各段の時刻、モデル、バックエンド、メモリ、温度を一つのターン記録へ集約する。

## Kotlin側の境界

LLMには次の意味を持つインターフェースを設ける。

実装時の名前や戻り値は変更できるが、ライフサイクルとキャンセルの責務は維持する。

~~~kotlin
interface LocalLanguageModel : AutoCloseable {
    val status: StateFlow<ModelStatus>
    suspend fun prepare(profile: LanguageModelProfile)
    fun generate(request: GenerationRequest): Flow<TextDelta>
    suspend fun cancel()
}

data class GenerationRequest(
    val systemInstruction: String,
    val messages: List<DialogueMessage>,
    val maxOutputTokens: Int,
    val sampling: SamplingProfile,
)
~~~

RunAnywhereとLiteRT-LMは、それぞれLocalLanguageModelのアダプターになる。

会話制御は、Qwen固有のno-think指示やGemma固有の応答チャネルを知らない。

Qwen3.5はQwen3と異なり、no-think文字列による切り替えを公式にはサポートしないため、現在のプロンプトを全モデルへ流用してはいけない。

モデルアダプターがチャットテンプレート、思考モード、停止条件を所有する。

ASRには既存のLocalSpeechRecognizer境界を維持し、モデルプロファイルと認識結果のメタデータを加える。

認識結果には本文、処理時間、音声時間、使用モデル、信頼度が得られる場合はその値を含める。

ネイティブリソースは所有者を一つにし、prepareの再実行時と画面破棄時に確実にcloseする。

コルーチンは構造化並行性に従い、アプリケーションスコープの親Jobからターン単位の子Jobを生成する。

音声入力、シリアルI/O、推論は注入したCoroutineDispatcherで分離し、単体テストではテスト用dispatcherへ交換する。

LLMからTTSへのチャネルは無制限にせず、二文程度の容量で背圧をかける。

UIは不変なStateFlowを購読し、ネイティブSDKを直接操作しない。

依存関係はApplicationに置く一つのcomposition rootで生成する。

この規模では新しいDIフレームワークの導入を必須にせず、手動DIで所有関係を明示する。

## LLMの構成

### Gemma 4 E2BおよびE4BとLiteRT-LM

速度優先の既定値はGemma 4 E2B ITとし、会話品質を優先するときはE4B ITを選択する。
両モデルのLiteRT-LM形式をLiteRT-LM 0.14.0で実行する。

Kotlin APIはコルーチン向けのFlow、CPU、GPU、NPUバックエンド、会話セッションを提供している。

このPoCでは、テキスト以外のGemmaエンコーダーをロードしない。

初期設定は次のとおりとする。

| 項目 | 初期値 |
|---|---|
| 実行バックエンド | GPUを試し、初期化失敗時だけCPUへ退避 |
| 最大コンテキスト | 2,048 tokens |
| 出力長 | システム指示で1〜3文。LiteRT-LM 0.14.0のConversation APIにはターン別token上限がない |
| 思考モード | 無効 |
| MTP | モデル能力を確認し、GPU経路で有効 |
| 会話 | ターンごとに作り直さず、一つのConversationを再利用 |
| キャッシュ | context.cacheDir配下 |

2,048 tokensを選ぶ理由は、音声雑談に256K tokensの文脈は不要であり、KV cacheとprefillが応答開始を遅らせるからである。

会話履歴が上限へ近づいたら、古い発話をそのまま追加せず、短い構造化要約へ置き換える。

LiteRT-LM 0.14.0のMTP切り替えはExperimentalFlagsに属するため、SDK更新時にコンパイル検査と実機再測定を行う。
GPU初期化または初回生成に失敗した場合はMTPを無効にしてCPUエンジンを生成し、CPUでも生成検査を行う。

依存バージョンにはlatest.releaseを使わず、検証した0.14.0へ固定する。

公式LiteRT-LMファイルは、E2Bが約2.59GB、E4Bが約3.66GBである。

Googleのモデル資料はモバイルの推論メモリを1.1GB、テキストのみを0.84GBと見積もっているが、これはファイル容量ではなく特定構成での推論メモリの目安である。

AndroidのGPUメモリはPSSへすべて現れない場合があるため、PSS、Graphics、native heapを分けて測る。

### Qwen3.5 2BとRunAnywhere

Qwen3.5 2Bは、モデル能力と移行コストを比べるための第二候補である。

公式モデルはApache 2.0で、2B parameters、non-thinking既定、MTP学習済みとされている。

一方、公開ソース版RunAnywhere 0.20.9のllama.cppバックエンドはAndroidでCPU NEONを使う。

RunAnywhereのQHexRTは公開ビルドでは実行不能なshellであり、非公開アーカイブを持つ許可済みビルドだけが利用できる。

したがって、QHexRTをこのOSS PoCの性能計画へ含めない。

2026年7月14日時点では、GitHubの最新安定releaseが0.20.9である一方、Maven CentralのAndroid artifactは0.20.8が最新である。

Qwen3.5 2Bを測る場合は、まずMaven Centralの0.20.8でチャットテンプレートとGGUFの互換性を確認し、不足する場合だけ0.20.9のsource buildを検討する。

GGUF変換物はQwen公式配布ではない場合があるため、配布元、量子化方式、SHA-256、派生物のライセンスをモデル台帳へ記録する。

### LLM候補の役割

| 候補 | Androidの主経路 | 利点 | 制約 | 役割 |
|---|---|---|---|---|
| Gemma 4 E2B IT | LiteRT-LM GPUとMTP | GPU応答生成を実機確認済み | 会話品質が不足する場合がある | 速度基準 |
| Gemma 4 E4B IT | LiteRT-LM GPUとMTP | E2Bより大きい会話モデル | 実機速度、メモリ、安定性が未確認 | 品質候補 |
| Qwen3.5 2B | RunAnywhere llama.cpp CPU NEON | 現行SDKの置換範囲が小さい | 公開経路ではGPUを使わない | 比較候補 |
| Qwen3 4B | RunAnywhere llama.cpp CPU NEON | 旧実装で動作済み | 10秒以上の応答遅延 | 回帰比較 |
| Gemma 3 1B | LiteRT-LM CPUまたはGPU | 小さく速度の下限を確認できる | 対話品質が下がる可能性がある | 緊急時の速度優先候補 |

モデルを切り替えるときは、旧LLMをcloseしてから新LLMをロードする。

複数LLMの同時常駐は比較画面でも許可しない。

### LLMの採用条件

Gemma 4を会話用LLMとして採用する条件は、次のすべてを満たすことである。

- razr 50 ultraでGPU初期化と連続生成が安定する。
- ウォーム状態のTTFTがp50で1.5秒以下になる。
- 生成速度がp50で15 tokens/s以上になる。
- 15分の連続会話でクラッシュ、OOM、回復不能なGPUエラーが発生しない。
- 固定した日本語対話セットで、利用目的を満たす指示追従と会話の一貫性がある。

E4Bは、上記の遅延と安定性を満たし、同じ対話セットでE2Bより品質が改善した場合に選ぶ。

Samsung S26 Ultraの公表値は参考値に留め、上記判定へ代入しない。

GPU経路が条件を満たさない場合はCPU経路を測り、それでも遅い場合はQwen3.5 2BかGemma 3 1Bを選ぶ。

## ASRの構成

### Parakeet Japaneseを最初に比較する

第一候補は、sherpa-onnxが配布するParakeet TDT-CTC 0.6B Japanese int8のCTCモデルである。

配布物は約625MiBのmodel.int8.onnxとtokens.txtで構成される。

現行Whisper Smallの約450MBより大きいが、CTCの一回のforward処理で認識できるため、デコーダーを反復実行するWhisperより短い処理時間を期待できる。

これはアーキテクチャからの予想であり、razr上の実時間係数で確認する。

現在同梱しているsherpa-onnx 1.12.20のKotlin定義にはOfflineNemoEncDecCtcModelConfigがある。

まず既存native libraryでモデル生成と一発話の認識を試し、互換性がなければsherpa-onnx 1.13.4への更新を別作業として行う。

native libraryを更新する場合は、RunAnywhere側とPiper Plus側に既に存在するONNX RuntimeとのSONAME、シンボル版、ロード順を再検査する。

### 比較手順

Whisper Small、Parakeet CTC、ReazonSpeech Zipformerへ同じ16kHz PCMを入力する。

評価音声は最低30発話とし、次を均等に含める。

- 静かな場所での短い雑談
- 一秒前後の間を含む発話
- 固有名詞と数値
- スタックチャンへの短い命令
- スピーカー再生音が回り込む条件
- 生活雑音を含む条件

各モデルについて、モデルロード時間、RTF、CER、空結果率、非音声字幕率、peak PSSを記録する。

第一判定はRTF p50が0.5以下であることとし、認識品質は現行Whisperから悪化させない。

部分認識は画面表示に使えるが、初期実装では発話確定前にLLMを開始しない。

途中結果からLLMを先行実行すると、訂正時のKV cache破棄と音声の誤応答が増えるためである。

## 発話区切り

発話開始には現在のWebRTC VADを残す。

この処理は軽く、修正版が短い衝撃音を破棄できるため、LLMとASRの高速化前に置き換える理由がない。

発話終了はTurnTakingPolicyへ分離し、次の三つの実装を同じ入力で比較できるようにする。

1. 固定無音長とヒステリシス
2. Silero VADの発話確率と無音長
3. VADとVAPの組み合わせ

最初の実装では終了無音長を800ミリ秒から450ミリ秒へ下げ、350、450、600、800ミリ秒を設定画面または開発者設定で比較する。

短い雑音の破棄に使うminimumSpeechMsは、終了無音長と独立して維持する。

MaAIは日本語のターン交替、あいづち、うなずきをCPUでリアルタイムに予測できるため、スタックチャンとの相性がよい。

ただし、現行公開実装はPythonとPyTorchを前提とし、Android向けKotlin APIや配布モデルを提供していない。

MaAIを最初のリリース条件にはせず、TurnTakingPolicyを先に用意してからONNXまたは別のAndroidランタイムへの移植可能性を調べる。

MaAI本体はMITだが学習済みモデルのライセンスはモデルごとに異なるため、採用する重みを個別に確認する。

## TTSの構成

Piper Plus v1.13.0と現在の日本語音声モデルを維持する。

LLMとASRの変更時にTTSまで同時交換すると、遅延と音質の原因を切り分けられないためである。

第一段階ではSentenceChunkerだけを改善する。

強い句読点では直ちに文を確定し、24文字を超えた後の読点または改行でも句を確定する。

任意の24文字で切断すると読みと韻律を壊すため、分割位置は句境界に限る。

最大出力は64 tokensを目標とする。
LiteRT-LM 0.14.0のConversation APIにはターン別token上限がないため、現実装では一文から三文のシステム指示で長さを抑えている。
途中停止を加える場合は、文の途中で音声を切らず、生成済みの文境界と`cancelProcess`の状態をそろえる。

第二段階ではPiper Plus AARへ上流C APIのストリーミング合成と音素タイミングを公開する。

最初のPCMが得られた時点で再生を始め、文全体の合成を待たない。

口の開閉はテキスト生成時刻ではなく、AudioOutputが実際に再生するPCMの包絡線か音素タイミングへ同期する。

音声モデルのライセンスはPiper Plus本体と別に管理する。

## スタックチャンを対話周辺機器として扱う

スタックチャンは生のサーボ装置ではなく、音声、センサー、安全な身体動作を提供する対話周辺機器として扱う。

Androidは対話と高水準の行動選択を担当し、スタックチャンのfirmwareは音声I/O、センサー前処理、サーボの安全制御を担当する。

~~~text
Android                                      スタックチャン

ASR、LLM、TTS                               マイク、スピーカー
会話状態                    USB             画面、接触、加速度
BehaviorDirector  ◀────────────────────▶    MotionController
StackChanConnection                          安全制限、watchdog
~~~

この分担なら、Android側の推論が停止してもサーボ角度と速度をfirmware側で制限できる。

### メディアと制御を分ける

同じUSB接続上に、二種類の論理経路を設ける。

**メディア経路**は、マイクPCMとスピーカーPCMを低遅延で運ぶ。

**制御経路**は、能力交換、センサーイベント、表情、モーション、診断、ACKを運ぶ。

メディアフレームは欠損時に再送しない。

遅れて届いた音声は会話の時系列を壊すため、sequenceの欠損を無音で補うか、その発話を破棄する。

制御コマンドはactionIdを持ち、ACKがない場合だけ上限回数まで再送する。

再送されても同じactionIdを二度実行しない。

### 接続確立

接続時はCONTROLのHELLOとCAPABILITIESを交換する。

能力情報には次を含める。

- protocol version
- firmware version
- 最大payload長
- 対応するマイクsample rate
- 対応するスピーカーsample rate
- PCM16または追加codec
- 受信bufferの容量
- 対応する表情と名前付きモーション
- 接触、加速度、画面タップなどのセンサー
- flow controlと時刻同期の機能

Androidは能力情報にない表情、モーション、sample rateを送らない。

現在の20バイトheaderと4バイトCRCは維持できる。

時刻、sample index、actionIdは各payloadへ追加し、headerの意味を変える場合だけprotocol versionを上げる。

### ストリームデコーダー

USB readが一フレームと一致する前提を置かない。

FrameStreamDecoderは受信bufferへバイトを追加し、magic、version、length、CRCを順に検査する。

lengthはCAPABILITIESで合意した上限とアプリ側の絶対上限の小さい方に制限する。

不正なlengthまたはCRCを検出したら、次のmagicまで一バイトずつ進めて再同期する。

未知のtypeは接続全体を落とさず、診断へ記録して破棄する。

### 音声帯域とflow control

16kHz、PCM16、monoは一方向32,000 bytes/sである。

22.05kHzのTTS出力は一方向44,100 bytes/sである。

921,600 baudを8N1で使う場合、理論上の一方向上限は92,160 bytes/sだが、USB CDC実装、firmwareのtask、フレーム処理の損失を含まない。

実装前に一方向と全二重の持続throughputを測り、sample rateを16kHzまたは22.05kHzから交渉する。

20ミリ秒の16kHz PCMは640 bytesであり、現在の24 bytesのフレーム付加情報はpayload比で約3.8パーセントになる。

スピーカー再生にはPLAY_BEGIN、SPEAKER_PCM、PLAY_END、PLAY_CANCELを使う。

スタックチャンは受信可能なbuffer時間またはcreditを通知し、Androidはその範囲を超えて送らない。

bufferは遅延を隠すほど大きくせず、初期値を100ミリ秒から200ミリ秒としてunderflowと操作遅延を測る。

第一段階は半二重PCMとし、TTS再生中はマイク音声をASRへ渡さない。

全二重会話は、スピーカー参照信号を使うAECとbarge-in検出を実装した後に有効にする。

接触、振動、画面タップによる停止は、半二重の段階でも常に受け付ける。

### 再生時刻への同期

AndroidがPCMを送信した時刻と、スタックチャンがPCMを再生した時刻は一致しない。

表情と口の動きは送信時刻ではなく、スタックチャンが報告する再生sample indexへ同期する。

スタックチャンは定期的に現在の再生位置、buffer量、underflow数をDIAGNOSTICSで返す。

長時間の同期には両者のmonotonic clockの差を推定し、壁時計は使わない。

## 物理操作と身体表現

物理イベントは、連続センサー値をそのままLLMへ渡さない。

firmwareがdebounce、閾値、cooldownを処理し、意味のあるInteractionEventへ変換する。

初期イベントは次のとおりとする。

| イベント | payloadの例 | 即時反応 | 会話への作用 |
|---|---|---|---|
| HeadTouchStarted | 強度、時刻 | 笑顔、小さく傾く | IDLEなら起動候補 |
| HeadTouchEnded | 継続時間、時刻 | 中立へ戻る | 必要なら接触の要約を履歴へ追加 |
| BodyShaken | 強度、方向、時刻 | 動作停止、困惑表情 | 再生と生成を中断 |
| ScreenTapped | 座標、時刻 | タップ位置の反応 | 起動、選択、発話確定 |
| ButtonPressed | button id、時刻 | 押下表示 | PTTまたはキャンセル |

即時反応はLLMを待たず、100ミリ秒以内を目標にする。

その後の発話内容へ影響する場合だけ、InteractionRouterが「頭をなでられた」などの短い意味表現を次のLLM入力へ追加する。

毎フレームの加速度値を会話履歴へ入れない。

### 会話状態と表情

表情は会話の主状態から決定し、LLM出力がなくても動作する。

| 会話状態 | 基本表情 | 動作 |
|---|---|---|
| IDLE | 中立または眠そう | 低頻度の待機動作 |
| LISTENING | 注視 | 小さな追従 |
| RECORDING | 聞き入る | 控えめなうなずき |
| TRANSCRIBING | 待機 | 動きを減らす |
| THINKING | 考える | ゆっくり傾く |
| SPEAKING | 発話表情 | PCM同期の口、文境界の小動作 |
| INTERRUPTING | 驚きまたは中立 | 再生と動作を停止 |
| ERROR | 困惑 | 安全位置へ戻る |

MaAIのうなずき予測を将来導入する場合も、出力はBehaviorDirectorの入力に留める。

MaAIがサーボを直接操作する構造にはしない。

### サーボの安全条件

LLMはPWM値、角度列、速度列を直接生成しない。

Androidが送れる動作はNOD、TILT、LOOK_LEFT、LOOK_RIGHT、RESET_POSEなどの名前付きgestureに限定する。

各gestureはintensity、durationMs、priority、actionIdを持つ。

firmwareは次を必ず制限する。

- 可動角
- 最高速度
- 最高加速度
- 一動作の最長時間
- 接続断時の中立位置
- watchdog timeout
- 同時動作の競合
- 電流または温度を取得できる場合の停止条件

BodyShaken、PLAY_CANCEL、USB切断は、通常の表情命令より高い優先度で動作を停止する。

将来LLMのtool callingでgestureを選ばせる場合も、許可list、引数検査、頻度制限を通す。

## 会話状態とキャンセル

会話状態と身体状態を一つの巨大なenumへ統合しない。

会話状態は推論の進行を表し、身体状態は複数の入力を合成した結果としてBehaviorDirectorが管理する。

これにより、「THINKING中に頭をなでられた」などの組み合わせを状態数の増加なしで扱える。

一回のキャンセルは次の順に伝播させる。

1. 新しい音声入力とセンサー起因の開始を止める。
2. LLM生成をcancelする。
3. 未処理のTTS文を破棄する。
4. AudioOutputへPLAY_CANCELを送る。
5. BehaviorDirectorへ安全姿勢を要求する。
6. 各子Jobの終了を待ってLISTENINGまたはIDLEへ戻す。

cancel要求は冪等にし、複数回届いても例外にしない。

## 性能測定

### ターン単位の時刻

時刻にはSystemClock.elapsedRealtimeNanosに相当するmonotonic clockを使う。

各ターンで次を記録する。

| 時刻 | 意味 |
|---|---|
| speechStart | VADが発話開始を確定した |
| lastSpeechFrame | 最後の発話frameを受けた |
| endpointCommitted | 発話終了を確定した |
| asrStarted、asrFinished | ASRの開始と終了 |
| llmStarted、firstToken、llmFinished | LLMの開始、TTFT、終了 |
| ttsStarted、firstPcm | TTSの開始、最初のPCM |
| outputQueued、firstAudible | 出力投入、端末側で確認できる再生開始 |
| turnFinished | 再生と身体動作が終了した |

firstAudibleはAndroid AudioTrackでは推定値、スタックチャン接続時は再生sample indexから得る。

時刻に加えて、ASRのRTF、prompt tokens、generated tokens、tokens/s、TTSのRTF、audio buffer量、underflow、PSS、thermal statusを記録する。

通常ビルドでは発話音声と会話本文をログへ保存しない。

評価モードで本文やPCMを保存する場合は明示的に有効化し、アプリ内部領域から利用者が操作してexportする。

### 暫定性能目標

次の値は設計の採否を決める初期目標であり、達成済みの値ではない。

Phase 0の実測後に、端末のばらつきと音質を見て調整する。

| 指標 | 中央値目標 | 悪化側の目標 |
|---|---:|---:|
| 最後の発話frameからendpoint確定 | p50で450 ms以下 | p95で700 ms以下 |
| 3秒発話のASR | p50で1.5 s以下 | p95で2.4 s以下 |
| LLM TTFT | p50で1.5 s以下 | p95で2.5 s以下 |
| LLM生成速度 | p50で15 tokens/s以上 | p10で10 tokens/s以上 |
| TTS開始から最初のPCM | p50で400 ms以下 | p95で700 ms以下 |
| endpoint確定から最初の可聴音 | p50で3.0 s以下 | p95で5.0 s以下 |
| 物理操作から即時反応 | p50で70 ms以下 | p95で100 ms以下 |

ASRには発話長が異なる測定も行い、RTF p50 0.5以下を別の採用条件とする。

15分の連続会話では、クラッシュとOOMがなく、後半5分のp50遅延が前半5分の1.5倍を超えないことを確認する。

発熱、電池消費、GPUエラーは性能値と同じ記録へ残す。

## モデル管理

LLMについては、ランタイムから独立した`GemmaModelManifest`へ置き換えた。
ASRは現在も`ModelCatalog`とRunAnywhereの保存先管理を使用している。

各manifestは次を持つ。

- idと表示名
- 用途
- runtimeとformat
- versionまたはrevision
- download URL
- file size
- SHA-256
- license名とlicense URL
- 必要な関連ファイル
- 対応するbackend
- 既定のcontextとthread数

Gemmaの取得は一時ファイルへ書き、sizeとSHA-256を確認した後にatomic renameする。
通信中断後はHTTP Rangeで取得を再開し、再開を拒否するサーバーでは一時ファイルを先頭から置き換える。

モデルが利用条件への同意を必要とする場合は、同意状態をモデルrevisionと結び付ける。

別revisionへ差し替えたときは以前の同意を暗黙に引き継がない。

モデルファイルはアプリのバックアップ対象から外す。

## 段階移行

### Phase 0

旧Qwen3 4B経路では基準値を取得済みだが、統一したTurnTelemetryは未実装である。

Push-to-Talkと自動VADの両方で、最低30発話の基準値を採る。

判定条件は、endpoint、ASR、LLM、TTS、再生の時間を一ターン内で分離できることである。

### Phase 1

`LocalLanguageModel`を導入し、`ConversationEngine`からRunAnywhereのLLM呼び出しを除去した。

キャンセル、履歴、TTS開始順の回帰試験は実機検証に残っている。

ソース上の判定条件は満たした。

### Phase 2

LiteRT-LM 0.14.0とGemma 4 E2Bをアプリへ組み込み、razr 50 ultraでGPU応答生成を確認した。

E2BとE4Bの選択、選択状態の保存、モデル別の保存領域も実装した。
ソース上の既定値は、速度を優先してE2Bのままとする。

次にE4Bのダウンロード再開、SHA-256検証、GPU初期化、CPU退避、MTPを検査する。

同じ会話課題でE2BとE4Bを比較し、応答待ち時間と会話品質の差から利用モデルを決める。

条件を満たさない場合は、Maven CentralのRunAnywhere 0.20.8とQwen3.5 2B、必要ならGemma 3 1Bを測る。

### Phase 3

ASRのモデル選択をModelManifestへ移し、Parakeet CTCを追加する。

Whisper、Parakeet、ReazonSpeech Zipformerを固定音声で比較する。

同時にTurnTakingPolicyを導入し、終了無音長を実測で選ぶ。

判定条件は、認識品質を維持しながらASRのRTFとendpoint遅延が目標を満たすことである。

### Phase 4

SentenceChunkerの初回句を短くし、Piper PlusのストリーミングJNIを追加する。

firstPcmとfirstAudibleを別に測り、口の動きを再生PCMへ同期する。

判定条件は、音質の破綻を増やさずTTSのp95目標を満たすことである。

### Phase 5

FrameStreamDecoder、USB接続状態機械、HELLO、CAPABILITIES、SPEAKER_PCMを実装する。

スピーカーが安定した後にMICROPHONE_PCMを追加する。

半二重で10分間の音声入出力を行い、sequence gap、CRC error、underflow、切断復帰を記録する。

判定条件は、Androidマイクとスピーカーをスタックチャンへ交換しても会話パイプラインを変更しないことである。

### Phase 6

センサーイベント、BehaviorDirector、名前付きgesture、firmware側の安全制限を実装する。

頭への接触、筐体の振動、画面タップをLLMなしで100ミリ秒以内に反応させる。

判定条件は、生成中または再生中の物理キャンセルが確実に効き、接続断時にサーボが安全姿勢へ戻ることである。

### Phase 7

MaAIまたは別VAPのAndroid実行可能性を検証する。

VAP、あいづち、うなずきのうち、固定無音判定より実測で改善する機能だけを採用する。

全二重音声とbarge-inはAECを含む独立した評価項目とする。

## 未確定事項

次の事項は実装前または実機測定で決める。

- Gemma 4 E4Bの汎用GPUモデルがrazr 50 ultraのOpenCL driverで安定するか
- E2BとE4BのMTPがこの端末でTTFT、生成速度、消費電力の合計を改善するか
- LiteRT-LMのテキストのみ実行時に実際のPSSとGPU memoryがいくらになるか
- Parakeet CTCが現在のsherpa-onnx 1.12.20 native libraryで動くか
- Piper PlusのストリーミングC APIを既存AARへ公開するために必要なJNI変更
- スタックチャンfirmwareが提供できるbaud、sample rate、buffer、センサー
- スピーカー回り込みに対するAECの配置をAndroidとfirmwareのどちらにするか
- 採用するMaAIモデルのライセンスとAndroid変換後の精度

これらは設計上の交換境界を変えない。

未確認の実行経路を既定にせず、各Phaseの判定条件を満たしたものだけを次の段階へ残す。

## 参照情報

外部情報は2026年7月14日に確認した。

- [Gemma 4 model overview](https://ai.google.dev/gemma/docs/core)
- [Gemma 4 model card](https://ai.google.dev/gemma/docs/core/model_card_4)
- [Gemma 4 Multi-Token Prediction](https://ai.google.dev/gemma/docs/mtp/overview)
- [LiteRT-LM Kotlin API](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.14.0/docs/api/kotlin/getting_started.md)
- [LiteRT-LM v0.14.0](https://github.com/google-ai-edge/LiteRT-LM/releases/tag/v0.14.0)
- [Gemma 4 E2B LiteRT-LM model](https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm)
- [Gemma 4 E4B LiteRT-LM model](https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm)
- [LiteRT-LM performance report](https://developers.googleblog.com/blazing-fast-on-device-genai-with-litert-lm/)
- [Google AI Edge Gallery](https://github.com/google-ai-edge/gallery)
- [Qwen3.5 2B model card](https://huggingface.co/Qwen/Qwen3.5-2B)
- [RunAnywhere v0.20.9](https://github.com/RunanywhereAI/runanywhere-sdks/releases/tag/v0.20.9)
- [RunAnywhere Android artifact on Maven Central](https://central.sonatype.com/artifact/io.github.sanchitmonga22/runanywhere-sdk-android)
- [RunAnywhere Android llama.cpp backend notes](https://github.com/RunanywhereAI/runanywhere-sdks/blob/v0.20.9/sdk/runanywhere-commons/README.md#llamacpp-backend)
- [RunAnywhere QHexRT public build limitation](https://github.com/RunanywhereAI/runanywhere-sdks/blob/v0.20.9/engines/AGENTS.md#private-engine-shells)
- [NVIDIA Parakeet TDT-CTC 0.6B Japanese](https://huggingface.co/nvidia/parakeet-tdt_ctc-0.6b-ja)
- [sherpa-onnx Parakeet Japanese int8](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-ctc/nemo/japanese.html)
- [sherpa-onnx ReazonSpeech Zipformer](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/zipformer-transducer-models.html#sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01-japanese)
- [sherpa-onnx v1.13.4](https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.4)
- [MaAI](https://github.com/MaAI-Kyoto/MaAI)
- [Piper Plus v1.13.0](https://github.com/ayutaz/piper-plus/releases/tag/v1.13.0)
- [motorola razr 50 ultra](https://www.motorola.com/gb/en/p/phones/razr/50-ultra/pmipmgs37ms)
- [Snapdragon 8s Gen 3](https://www.qualcomm.com/smartphones/products/8-series/snapdragon-8s-gen-3-mobile-platform)
