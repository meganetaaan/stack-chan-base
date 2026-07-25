# Codex音声ブリッジ次期ロードマップ

更新日: 2026-07-25

状態: 設計案

## 目的

本資料は、Codex音声ブリッジを都度起動する実験用CLIから、Stack-chanを日常的に待機させられる常駐サービスへ発展させるための実装方針を定める。

対象は次の三点である。

1. ブリッジを常駐させ、Stack-chanの頭上タッチセンサから会話を開始および終了する。
2. ユーザーの発話を受け付けている間、Stack-chanの画面へ聞き取り中アイコンを表示する。
3. 表情や安全なモーションを、Codexが呼び出せるツールとして提供する。

起動語、BLE接続、複数台の同時制御、任意コードをFirmwareで実行する機能は今回の対象外とする。

## 現状

現行ブリッジはapp-serverとUSBの接続後、直ちにRealtime WebRTCセッションを開始する。

プロセス全体を止める`AbortSignal`はあるが、一回の会話だけを開始または停止するセッション制御はない。

Realtime接続が一時的に切れた場合は、USB接続を維持したまま指数バックオフで再接続する。

利用上限や構成不整合は再試行不能としてプロセスを終了する。

会話表示は`idle`、`recognizing`、`speaking`の三状態である。

`idle`はアイコンを消す状態だが、現行実装ではRealtime接続後にマイクを動かしている間にも使われる。

このため、待機中と聞き取り中を画面上でもコード上でも区別できない。

USB contractの`STATUS=48`は、`IDLE=0`、`RECOGNIZING=1`、`SPEAKING=2`を定義している。

Firmwareは`RECOGNIZING`で回転インジケーターを表示し、`SPEAKING`では半二重通信によってマイクが停止していることを示すアイコンを表示する。

`EVENT=6`は双方向application eventを運べるが、現行ブリッジが扱うeventは承認要求に限られる。

`EXPRESSION=3`と`MOTION=4`にはpayload仕様がなく、現行音声経路では使用していない。

Codex CLI 0.145.0から生成したapp-server schemaには、`thread/start.dynamicTools`とserver requestの`item/tool/call`が存在する。

現行ブリッジはdynamic toolを登録せず、`item/tool/call`も処理していない。

現行のserver request listenerは全requestをApprovalManagerへ渡すため、`item/tool/call`を追加してもroutingしなければunsupported errorで先に拒否される。

現行のdevice event処理も承認eventだけを解釈するため、会話操作とaction resultを種類別に配送するrouterが必要である。

`thread/resume`には`dynamicTools`フィールドがないため、再開したthreadでのツール再登録可否は実機検証が必要である。

## 目標とする利用体験

ブリッジはログインセッション中に常駐し、app-serverと指定したStack-chanへの接続を維持する。

起動直後は**standby**となり、Realtimeセッションとマイク入力を開始しない。

頭上センサを短く一回タップするとRealtimeセッションを開始する。

WebRTCとCoreS3マイクの準備が整った時点で聞き取り中アイコンを表示する。

会話中にもう一度短くタップすると、認識中または再生中であっても会話を終了する。

終了時はマイク、再生queue、WebRTC、未完了のRealtime応答を停止し、standbyへ戻る。

短いタップは会話の切り替えに使い、前後方向のスワイプによる既存のなで動作は維持する。

初期実装では、一つのdaemonプロセス内で同じCodex threadを再利用し、タップではRealtimeセッションだけを開閉する。

プロセス再起動後も同じthreadを使うか、新しいthreadを始めるかは設定可能にする余地を残す。

## 構成

常駐プロセス内の責務を次のように分離する。

```text
頭上タップ
  ↓
Firmware
  ↓  EVENT conversation.toggle
USB device supervisor
  ↓
Conversation session controller
  ├─ RealtimeAudioBridgeを開始または停止
  ├─ STATUSで画面状態を同期
  └─ 一時障害だけを再接続

Codex dynamic tool call
  ↓
app-server request handler
  ↓
Stack-chan action dispatcher
  ↓  EVENT robot.action.request
Firmware action executor
  ↓  EVENT robot.action.result
app-server response
```

**USB device supervisor**は、USBの接続、切断、再接続とcapability negotiationを担当する。

**Conversation session controller**は、ユーザーが会話を希望しているかを表すdesired stateと、実際のRealtime状態を分けて管理する。

**RealtimeAudioBridge**は一回のRealtimeセッションだけを担当し、セッション専用の`AbortController`で停止できるようにする。

**Stack-chan action dispatcher**はapp-serverのツール呼び出しを検証し、Codex固有のrequestをStack-chan共通eventへ変換する。

**Server request router**は承認requestをApprovalManagerへ、`item/tool/call`をStack-chan action dispatcherへ一回だけ配送する。

**Device event router**は`approval.*`、`conversation.*`、`robot.action.*`をそれぞれのmanagerへ配送する。

承認UIの管理は会話セッションから独立させ、standby中も既存の承認要求を扱えるようにする。

## 会話状態

内部状態と画面表示を次のように定義する。

| 内部状態 | Realtime | CoreS3マイク | 画面 | 意味 |
| --- | --- | --- | --- | --- |
| `standby` | 停止 | 停止 | なし | 常駐中だが会話していない |
| `starting` | 接続中 | 停止 | なし | WebRTCと音声経路を準備している |
| `listening` | 接続済み | 動作中 | マイク | 発話を受け付けている |
| `recognizing` | 接続済み | 動作中 | 回転インジケーター | 発話区切り後の処理を待っている |
| `speaking` | 接続済み | 停止 | ミュート | Stack-chanが再生中である |
| `stopping` | 終了中 | 停止中 | なし | 音声資源を解放している |
| `blocked` | 停止 | 停止 | エラー表示は将来対応 | 利用上限などにより自動再試行できない |

`starting`では準備前に聞き取り中と表示しない。

`listening`への遷移は、WebRTCの開始とUSBの`MIC_STARTED`確認後に行う。

`input_audio_buffer.speech_started`を受けても`listening`を維持する。

`input_audio_buffer.speech_stopped`または`input_audio_buffer.committed`で`recognizing`へ遷移する。

最初の可聴出力を再生する直前に`speaking`へ遷移する。

再生完了後、会話継続を希望していれば`listening`へ戻る。

状態遷移は次の規則に従う。

| 現在状態 | 入力 | 次状態 | 処理 |
| --- | --- | --- | --- |
| `standby` | タップ | `starting` | Realtimeを一回だけ開始する |
| `starting` | 開始成功 | `listening` | マイクを開始して表示を更新する |
| `starting` | タップ | `stopping` | 接続処理を取り消す |
| `listening` | 発話区切り | `recognizing` | 応答を待つ |
| `recognizing` | 可聴出力 | `speaking` | マイクを止めて再生する |
| `speaking` | 再生完了 | `listening` | マイクを再開する |
| 会話中の全状態 | タップ | `stopping` | 現在の処理を中断する |
| `stopping` | 解放完了 | `standby` | 次のタップを待つ |
| 会話中の全状態 | 一時的なRealtime障害 | `starting` | desired stateが有効な間だけ再接続する |
| 会話中の全状態 | 再試行不能エラー | `blocked` | 自動再接続を停止する |
| 全状態 | USB切断 | `standby` | desired stateを解除し、再接続後も自動録音しない |

同時に存在できるRealtimeAudioBridgeは最大一つとする。

`standby`、`starting`、`stopping`、`blocked`ではCoreS3マイクのPCMを送信してはならない。

同じタッチeventを再受信しても状態を二回切り替えてはならない。

停止要求を受けた後に、古いセッションの非同期完了通知が新しいセッションの状態を変更してはならない。

## USB contractの拡張

### 会話切り替えevent

Firmwareは生のセンサ値ではなく、debounce済みの会話操作を送る。

deviceからhostへのeventを次の形にする。

```json
{
  "schema": "stackchan.event.v1",
  "type": "conversation.toggle",
  "requestId": "touch-boot-id-42",
  "source": "headTouch"
}
```

`requestId`はFirmwareの一回の起動中だけでも重複しない値とする。

hostは処理結果を次のeventで返す。

```json
{
  "schema": "stackchan.event.v1",
  "type": "conversation.result",
  "requestId": "touch-boot-id-42",
  "success": true,
  "state": "starting"
}
```

Firmwareが結果を再要求した場合、hostは同じ`requestId`へ同じ結果を返す。

Firmwareは`press`から`release`までを追跡し、スワイプへ遷移しなかった短いタップだけを`conversation.toggle`へ変換する。

現行のTouchPanelは単一の`onEvent` callbackしか持たないため、会話操作と既存のなで動作を共存させるには購読の多重化が必要である。

### 聞き取り中status

既存値を変更せず、`LISTENING=3`を追加する。

```text
IDLE=0
RECOGNIZING=1
SPEAKING=2
LISTENING=3
```

古いFirmwareは未知のstatus値を不正要求として拒否するため、値の追加だけでは後方互換にならない。

新しいcapability bitとして`STATUS_LISTENING`を追加し、Firmwareがこのbitを返した場合だけhostが`LISTENING=3`を送る。

未対応Firmwareでは`listening`を`IDLE=0`へ縮退し、音声会話自体は継続する。

既存の`STATUS_ICON` bitとstatus値の意味は変更しない。

### Stack-chan action event

表情とモーションは、payload未定義の`EXPRESSION=3`および`MOTION=4`を推測して使わない。

初期実装では、相関IDと実行結果を扱える`EVENT=6`へ共通actionを追加する。

Firmwareは新しい`ROBOT_ACTION` capabilityを広告し、hostは対応機にだけactionを送る。

hostからFirmwareへの要求を次の形にする。

```json
{
  "schema": "stackchan.event.v1",
  "type": "robot.action.request",
  "requestId": "tool-call-id",
  "action": "set_emotion",
  "arguments": {
    "emotion": "HAPPY"
  }
}
```

Firmwareからhostへの結果を次の形にする。

```json
{
  "schema": "stackchan.event.v1",
  "type": "robot.action.result",
  "requestId": "tool-call-id",
  "success": true,
  "result": {
    "emotion": "HAPPY"
  }
}
```

失敗時は`success=false`と短い`error`文字列を返す。

Firmwareは`requestId`ごとに実行結果を一定数保持し、再送された要求を二重実行しない。

hostはUSB切断時に未送信の古いactionを再接続後へ持ち越さず、ツール呼び出しを失敗として返す。

action名と引数は顔エンジンやサーボdriverの内部APIではなく、Stack-chan共通の意味単位とする。

Firmwareは共通の表情名を、その機体で使用中のface profileへ変換する。

機体固有のactionを追加する場合は、threadを開始する前にdevice capabilityを取得できるよう、現行のapp-server、thread、USBの接続順も見直す。

## Codexツール

app-serverとの第一候補はdynamic toolである。

新しいthreadを開始するときに`thread/start.dynamicTools`へツール定義を渡し、`item/tool/call`へ応答する。

この経路では、app-serverのrequest IDとtool call IDをUSBの`requestId`へ対応付ける。

Codex app-server固有のJSON-RPC payloadはFirmwareへ転送しない。

最初のvertical sliceは`set_emotion`だけに絞る。

既存のStack-chan側実装との互換性を保つため、表情名は`NEUTRAL`、`ANGRY`、`SAD`、`HAPPY`、`SLEEPY`、`DOUBTFUL`、`COLD`、`HOT`を候補とする。

これらは共通contract上の意味名であり、Firmware内部の表情preset名をwireへ露出しない。

次に、安全な意味単位だけを受け付ける`play_motion`を追加する。

モーション名は`nod`、`shake_head`、`look_left`、`look_right`、`look_up`、`look_down`、`center`を候補とする。

LEDが存在する機体だけに`set_led`を公開し、状態取得が安定した後に`get_robot_status`を追加する。

初期の共通ツールは固定catalogにし、LED名などの機体固有catalogはcapability discoveryの方式が決まるまで公開しない。

音声再生とAudioOutの所有権が競合する`play_melody`は初期対象から外す。

各ツールのJSON Schemaは`additionalProperties=false`とし、enum、数値範囲、配列長をhostとFirmwareの両方で検証する。

表情変更はローカルかつ可逆な操作として自動実行を許可する。

サーボを動かすツールは意味的なallowlistだけを公開し、生の角度、速度、トルク値をモデルへ渡さない。

モーション実行中に失敗しても、Firmwareは最終処理でトルクを解放する。

USB未接続時はツールをqueueへ貯めず、現在利用できないことをCodexへ返す。

同じ出力資源を使うactionは直列化し、表情状態と音声口パクが互いを不用意に初期化しないようにする。

### 先行検証

dynamic toolを本実装する前に、Realtime v3の会話から`item/tool/call`が発生することを一つの固定ツールで確認する。

Codex CLI 0.145.0のschemaはdynamic toolの存在を示すが、Realtime経路での呼び出しまで保証していない。

`thread/resume`後にも登録済みツールが有効かを確認する。

dynamic toolがRealtimeで利用できない場合は、WebRTCの`oai-events` data channelへ`session.update`を送り、bridge自身がfunction callを実行する経路を第二候補とする。

第二候補でも、raw Realtime eventをそのままFirmwareへ中継せず、`robot.action.request`へ正規化する。

MCP serverを別プロセスとして追加する案は、daemonとのIPCとライフサイクルが増えるため第三候補とする。

Stack-chanリポジトリのcommit `4b65e9e4`には、`set_emotion`、`play_motion`、`set_led`、`play_melody`、`get_robot_status`の先行実装と入力検証がある。

ツール名と安全制約はこの先行実装を再利用し、bridge専用の別仕様を増やさない。

## 常駐サービス

CLIはバックグラウンドへforkせず、foregroundのまま`systemd --user`に監視させる。

unitには絶対パスの`WorkingDirectory`と実行ファイルを指定する。

USBポートは`ttyACM0`の列挙順ではなく、可能な限り`/dev/serial/by-id/`のデバイス固有symlinkで固定する。

同型のStack-chanが複数接続されている場合、自動検出で最初の一台を選んではならない。

app-serverが未起動でもdaemonは終了せず、既存の指数バックオフで接続を待つ。

app-serverへの接続が回復しても、ユーザーのタップなしにRealtimeとマイクを開始しない。

一時的なWebRTC切断は、会話継続を希望している間だけ自動再接続する。

利用上限ではdaemon自体を終了せず、Realtimeの自動再試行を停止して`blocked`へ遷移する。

利用上限の解除時刻をapp-serverから取得できない場合は、次のタップを明示的な再試行として扱う。

USB切断後に同じ機体が戻っても、意図しない録音を避けるためstandbyから再開する。

`SIGTERM`では新しいeventを受け付けず、再生、マイク、Realtime、未解決承認の順序を定めて安全に停止する。

ログはjournalへ送り、PCM、承認本文、ツール引数の機微情報を常時保存しない。

## 実装段階

### Phase 0: contractとapp-server経路の検証

- `conversation.toggle`、`conversation.result`、`LISTENING=3`、`STATUS_LISTENING`、`ROBOT_ACTION`、`robot.action.*`をUSB contractへ追記する。
- Realtime v3からdynamic toolを一回呼び出せるか確認する。
- `thread/resume`後のdynamic toolの有効性を確認する。
- device capabilityを確認してからthreadへtool catalogを登録する接続順を決める。
- 頭上タップとなで動作を共存させるTouchPanel購読方式を決める。

### Phase 1: 会話セッション制御

- `ConversationSessionController`を追加する。
- プロセス、app-server、USB、Realtimeの`AbortSignal`を分離する。
- 接続直後のRealtime自動開始を廃止し、standbyから始める。
- 頭上タップeventで開始と停止を切り替える。
- 一時障害の再接続をdesired stateで制限する。
- 利用上限をdaemon常駐のまま`blocked`に留める。

### Phase 2: 聞き取り中表示

- `ConversationState`へ`listening`を追加し、曖昧な`idle`をstandby用途へ限定する。
- USB capabilityと`LISTENING=3`を実装する。
- Firmwareへ通常マイクアイコンを追加する。
- WebRTC通知、再生開始、再生終了と表示状態を同期する。

### Phase 3: 常駐運用

- `systemd --user` unitの雛形を追加する。
- デバイス固有pathの確認手順をREADMEへ追加する。
- app-server、USB、Realtimeを独立して再接続するログを整える。
- 終了、USB抜線、app-server再起動を含むsoak testを行う。

### Phase 4: 表情ツール

- `thread/start.dynamicTools`と`item/tool/call`をbridgeへ追加する。
- server requestとdevice eventを種類別に一回だけ配送するrouterを追加する。
- `robot.action.request`と`robot.action.result`を両端へ実装する。
- `set_emotion`を実機で確認する。
- requestの重複、timeout、USB切断、未知の引数を検査する。

### Phase 5: 身体表現の拡張

- `play_motion`を追加する。
- 機体capabilityに応じて`set_led`と`get_robot_status`を公開する。
- 自律表情、口パク、承認画面との資源競合を整理する。
- AudioOutの共有方針が決まった後に`play_melody`を再検討する。

## テスト方針

変更は状態遷移ごとにREDを追加してから実装する。

bridge側はVitestで次を検査する。

- standbyでは`thread/realtime/start`と`MIC_START`を呼ばない。
- 一回の`conversation.toggle`でRealtimeを一回だけ開始する。
- 同じ`requestId`の再送で状態を二回切り替えない。
- `starting`中の停止が接続処理を取り消す。
- `speaking`中の停止が再生とRealtimeを取り消す。
- 停止した古いセッションの通知が新しい状態へ影響しない。
- 一時障害はdesired stateが有効な間だけ再試行する。
- 利用上限は自動再試行せず、次の明示操作まで待つ。
- USB切断後の再接続で自動録音しない。
- `STATUS_LISTENING`対応機だけへ`LISTENING=3`を送る。
- 未対応機では`IDLE=0`へ縮退する。
- dynamic toolの引数を検証してからFirmwareへ送る。
- tool resultを正しいapp-server requestへ一回だけ返す。
- tool timeoutとUSB切断を失敗として返し、後から届いた結果を無視する。

有限状態機械は、短いevent列を全列挙し、Realtimeの多重起動、standby中の録音、停止後の状態復活がないことを検査する。

Firmware側はNode testで次を検査する。

- 短いpressとreleaseが一回の`conversation.toggle`になる。
- swipeはなで動作だけに使われ、会話を切り替えない。
- bounceと長押しでtoggleを連続送信しない。
- `LISTENING=3`が通常マイクアイコンを表示する。
- `SPEAKING=2`が従来どおりミュート表示になる。
- actionの重複requestを二重実行しない。
- 未知のaction、表情、モーション、追加引数を拒否する。
- モーション失敗時にもトルクを解放する。

app-serverとのcontract testでは、使用中のCodex CLIから生成したschemaを基準にmethodとfieldを確認する。

Realtime tool経路だけはmockで追認せず、ChatGPT認証を使う短い実接続testを別に残す。

## 実機受け入れ条件

対象機を明示したUSB pathでdaemonを起動すると、Realtimeを開始せずstandbyになる。

頭上を一回タップすると、音声経路の準備後に聞き取り中アイコンが現れる。

ユーザーが話している間は聞き取り中アイコンが維持される。

発話区切り後は回転インジケーターへ変わる。

Stack-chanの再生中はミュート表示になり、再生終了後は聞き取り中へ戻る。

会話中の二回目のタップで音声が停止し、アイコンが消える。

停止後に無音RTP、マイクPCM、Realtimeの自動再接続を継続しない。

USBを抜き差ししても、タップするまで録音を再開しない。

同型機を二台接続しても、指定していない機体へ接続しない。

「うれしい表情にして」のような発話で`set_emotion`が一回だけ実行される。

未知の表情を指定した場合は、Firmwareを変更せずツール失敗をCodexへ返す。

一時的なWebRTC切断後も会話継続中なら再接続し、利用上限では自動再接続ループへ入らない。

30分以上の会話で、音声の途切れ、Realtimeの多重接続、USB queueの増加がないことを確認する。

## 未決事項

一回のタップで同じCodex threadの文脈をどこまで保持するかを決める必要がある。

daemon再起動後のthread再開時にdynamic toolを再登録できるかを確認する必要がある。

`blocked`とapp-server未接続を画面へ表示するか、ログだけに留めるかを決める必要がある。

聞き取り中アイコンの最終デザインと表示位置を決める必要がある。

頭上タップの最大時間とdebounce時間はCoreS3実機で調整する必要がある。

Stack-chanリポジトリの先行ツール実装をUSB音声Firmwareへ取り込む順序を決める必要がある。

## 参照

- [Bridge README](../README.md)
- [WebRTC transport調査](WEBRTC_TRANSPORT.md)
- [CoreS3 USB CDC音声通信](../../../docs/SERIAL_NEXT_STEP.md)
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Stack-chan realtime robot tools commit](https://github.com/stack-chan/stack-chan/commit/4b65e9e452d14bb5976735d44f6850c16d63b914)
