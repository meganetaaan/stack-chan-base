# Stack-chan USB CDC v2 contract

この文書は、ｽﾀｯｸﾁｬﾝとdock appの間で使うUSB CDC v2 wire contractの正本である。
[Android local voice dock app](../../apps/android-local-voice/README.md)を動かすAndroid端末、または[PC上のCodex voice dock app](../../apps/codex-voice/README.md)を動かすPCをUSBホスト、M5Stack CoreS3をUSB Serial/JTAGデバイスとして接続する。
Android側は`usb-serial-for-android`、Codex音声ブリッジはNode.jsの`serialport`でVID `0x303A`、PID `0x1001`のCDCポートを開く。
通信速度の設定値は115,200 baudだが、実際の転送はUSB CDCで行われる。

言語ごとのcodecは独立して実装し、次のversion付き共通fixtureで一致を検査する。

- [`test-vectors.json`](test-vectors.json)：frameのwire bytes、CRC、破損frame
- [`negotiation-vectors.json`](negotiation-vectors.json)：HELLO payloadとcapability交渉
- [`application-event-vectors.json`](application-event-vectors.json)：共通eventとraw Realtime eventの振り分け

外部リポジトリへfixtureをvendorする場合は、内容を変更せず、取得元のDock commitとfixtureのSHA-256を記録する。
Dock自身の文書へ自己参照するcommit hashは埋め込まず、fixtureの`schema`と`protocolVersion`で形式versionを識別する。

## 音声形式

マイクは16 kHz、16 bit little-endian、monoで固定する。
Firmwareは20 ms、640 bytes単位の`MICROPHONE_PCM`をUSBホストへ送る。
USBホストはsequenceの欠損を最大10フレームまで無音で補完し、それを超える欠損を通信エラーとする。

スピーカーは8 kHz、16 kHz、24 kHzの16 bit little-endian、monoを受け付ける。
USBホストの既定出力は24 kHzであり、入力音声のsample rateから線形補間で逐次変換する。
CoreS3の`AudioOut`にはUSBフレームと同じsample rateを指定する。
USBホストはスピーカーPCMを80 ms単位で送る。
payloadは8 kHzで1,280 bytes、16 kHzで2,560 bytes、24 kHzで3,840 bytesとなり、最大payload長に収まる。

会話は半二重で動作する。
マイク開始時は再生を停止し、スピーカー開始時は録音を停止する。

## フレーム形式

整数はlittle-endianで格納する。
CRC32は20 bytesのheaderとpayloadを対象とする。

```text
magic       uint16  0x5343（wire上は43 53）
version     uint8   2
type        uint8
flags       uint16
streamId    uint16
sequence    uint32
sampleRate  uint32
length      uint32
payload     byte[length]
crc32       uint32
```

payloadは最大4,096 bytesとする。
USB readとフレーム境界は一致しないため、受信側は断片化と複数フレームの結合を処理する。
magic、version、length、CRCが不正な場合は次のmagicまで読み飛ばして再同期する。

version 2はversion 1と後方互換ではない。
AndroidとFirmwareはcapability bit 9の`STREAM_ID`を必須として確認し、不一致なら接続を拒否する。
`HELLO`、`HELLO_ACK`、`STATUS`は`streamId=0`を使い、マイクとスピーカーの各sessionは0以外のIDを使う。
現在のsessionとIDが異なるPCM、credit、終了、取消し、errorは状態へ適用しない。

typeは`CONTROL=0`、`MICROPHONE_PCM=1`、`SPEAKER_PCM=2`を使用する。
診断Firmwareは`DIAGNOSTICS=5`でAudioOutの統計を返す。
既存の`EXPRESSION=3`と`MOTION=4`は今回の音声経路では使用しない。
汎用application eventは`EVENT=6`を使用する。

## 制御手順

接続直後、USBホストは`HELLO`を送る。
HELLO payloadは最大payload長とcapability bitsetを並べた二つの`uint32`である。
Firmwareは同じ形式の`HELLO_ACK`を返す。
USBホストはマイク、スピーカー、credit、24 kHz出力のcapabilityを確認して`READY`へ遷移する。
USBホストはさらにcapability bit 9のstream ID対応を必須として確認する。

Android dock appとCodex音声ブリッジはcapability bit 10の`EVENT`を広告する。
Codex音声ブリッジはEVENTを必須として接続時に確認するが、Android dock appはEVENT非対応peerとも音声機能だけで接続できる。
各送信側はpeerがEVENTを広告した場合だけEVENTを送る。
会話操作のように双方向応答を必要とする機能は、dock appとFirmwareの双方がEVENTを広告した場合だけ利用できる。
このnegotiationにより、EVENTを解釈しない旧実装へ未知のframe typeを送らない。

録音は`MIC_START`、`MIC_STARTED`、`MICROPHONE_PCM`、`MIC_STOP`、`MIC_STOPPED`の順で制御する。
USBホストは`MIC_STOPPED`を受信するまで、同じstream ID、sample rate、空payloadの`MIC_STOP`を500ミリ秒間隔で再送できる。
Firmwareは最初の`MIC_STOP`で録音を停止し、同じ要求の再送には録音状態を変更せず`MIC_STOPPED`を再送する。
停止済みstreamと異なる古い`MIC_STOP`は、現在の録音sessionへ適用しない。
この再送履歴は次の有効な`HELLO`で破棄する。
再生は`SPEAKER_START`、`SPEAKER_CREDIT`、`SPEAKER_PCM`、`SPEAKER_END`、`SPEAKER_DONE`の順で制御する。
Firmwareがcapability bit 6を返した場合、USBホストは各文のPCM直前に`SPEAKER_TEXT=37`を送る。
`SPEAKER_TEXT` payloadは最大1,024 bytesのUTF-8で、sample rateは再生中の値と一致させる。
このcapabilityは任意であり、未対応Firmwareに対してUSBホストは字幕を送らない。
中断時は`SPEAKER_ABORT`を送る。
Firmwareがcapability bit 8を返した場合、USBホストは`STATUS=48`で会話状態を送る。
payloadは1 byteで、既存値を`IDLE=0`、`RECOGNIZING=1`、`SPEAKING=2`とする。

Firmwareがcapability bit 11の`STATUS_EXTENDED`を返した場合、USBホストは`LISTENING=3`、`CONNECTING=4`、`ERROR=5`も送信できる。
`LISTENING`はCoreS3の`MIC_STARTED`確認後だけ表示し、準備中の状態と区別する。
`CONNECTING`はapp-serverまたはRealtimeへの接続中、`ERROR`は利用上限などの再試行不能状態を表す。
bit 11を返さないFirmwareに対して、USBホストは拡張状態を`IDLE=0`へ縮退させる。
既存の`STATUS_ICON` bitと値0から2の意味は変更しない。

## Application event

`EVENT=6`は音声transportから独立した双方向application eventを運ぶ。
payloadはUTF-8 JSONとし、一つのeventは最大64 KiBとする。
一つのUSB frameに収まらないeventは、HELLOで合意した最大payload長以下に分割する。

- `flags` bit 0の`START`はeventの先頭frameを表す。
- `flags` bit 1の`END`はeventの末尾frameを表す。
- 一つのeventは0以外の同じ`streamId`をmessage IDとして使う。
- `sequence`はeventごとに0から開始し、frameごとに1増加する。
- 単一frameのeventは`START | END`を設定する。
- sequence欠落、不正なUTF-8、64 KiB超過はevent全体を破棄する。音声sessionには適用しない。

Stack-chan共通eventはトップレベルに`schema: "stackchan.event.v1"`、`type`、opaqueな`requestId`を持つ。
このschemaを持つ未知または不正なeventを、schemaのないraw Realtime eventとして処理してはならない。
壊れたJSONまたは不正なapplication eventはそのeventだけを破棄し、後続eventの受信を継続する。
Codex app-server固有のJSON-RPC payloadをそのままFirmwareへ転送してはならない。
Codex音声ブリッジは、コマンド実行とファイル変更を次の共通eventへ正規化する。

| direction | type | purpose |
| --- | --- | --- |
| Dock app → Firmware | `approval.request` | 種別、タイトル、要約、詳細を表示する |
| Firmware → Dock app | `approval.presented` | 同じ`requestId`の画面表示完了を通知する |
| Firmware → Dock app | `approval.response` | `decision`を`approve`または`decline`で返す |
| Dock app → Firmware | `approval.resolved` | 自端末または別clientで処理済みの画面を閉じる |
| Dock app → Firmware | `approval.suspended` | app-server再接続中として操作を一時停止する |
| Firmware → Dock app | `conversation.start` | 頭上センサの前方スワイプによる会話開始を要求する |
| Firmware → Dock app | `conversation.stop` | 頭上センサの後方スワイプによる会話停止を要求する |
| Dock app → Firmware | `conversation.result` | 会話操作の受理結果と現在状態を返す |

会話開始要求は次の形にする。

```json
{
  "schema": "stackchan.event.v1",
  "type": "conversation.start",
  "requestId": "conversation-a1b2c3d4-42",
  "source": "headTouch",
  "gesture": "forwardSwipe"
}
```

停止要求は`type="conversation.stop"`、`gesture="backwardSwipe"`とする。
開始と停止はtoggleとして解釈せず、明示された操作だけを適用する。
Android dock appは待機中の開始要求を自動会話モードへの切替として処理し、Push-to-Talk実行中の開始要求を拒否する。
停止要求はAndroidの会話モードにかかわらず冪等に処理する。

dock appは次の形で結果を返す。

```json
{
  "schema": "stackchan.event.v1",
  "type": "conversation.result",
  "requestId": "conversation-a1b2c3d4-42",
  "success": true,
  "state": "connecting"
}
```

`state`は`standby`、`connecting`、`listening`、`recognizing`、`speaking`、`blocked`のいずれかとする。
失敗時は`success=false`と短い`error`文字列を追加できる。

Firmwareは結果を受信するまで、同じeventを同じ`requestId`で2秒ごとに再送する。
再送は10秒で停止し、画面をエラー状態へ移す。
dock appは直近64件の結果を保持し、同じ`requestId`の再送で会話を二重に開始または停止しない。
異なる論理操作に同じ`requestId`を再利用しない。

`approval.request`の詳細本文は16 KiBまでとし、切り詰めた場合は`truncated=true`を設定する。
dock appは`approval.presented`を受け取るまで同じ`requestId`のrequestを再送でき、Firmwareは冪等に扱う。
Firmwareはresponse送信後も画面を「送信中」として保持し、`approval.resolved`まで同じdecisionを再送できる。
dock appは重複responseへ二重にJSON-RPC応答してはならない。

承認自体に時間制限は設けない。
USB切断時は未解決のCodex server requestを拒否せず保持し、再接続後に画面を復元する。
別のCodex clientで処理された場合は、app-serverの`serverRequest/resolved`を`approval.resolved`へ変換する。
ブリッジを明示的に終了する場合だけ、未解決要求を`decline`してから接続を閉じる。

Firmwareのスピーカーqueueは1秒分である。
`SPEAKER_CREDIT` payloadは新たに送信可能になったbytes数を表す増分値である。
未消費creditの上限は8 KiBとし、一回の送信量がFirmwareのnative USB受信ringに収まるよう制限する。
USBホストはcreditを消費してからPCMを送り、FirmwareはPCM queueに空きが生じた分だけcreditを返す。
USBホストは最大5秒分のPCMを送信待ちqueueへ保持し、音声生成をcredit待ちから分離する。
一つのPCM frameに必要なcreditが15秒更新されない場合は、その再生をエラーとして中断する。
Firmwareは500 ms分をprebufferしてから再生を開始する。
短い発話は`SPEAKER_END`を受信した時点で、500 ms未満でも再生を開始する。
USBのpollとフレーム処理はCore 1の高優先度Workerで行う。
Firmwareは32 KiBのnative USB受信ringから16 KiBずつ、1回のpollで最大4回読み出す。
WorkerはWebRadioと同じ64 KiBの共有ringへPCMを渡し、main VMが実機の`AudioOut`へ書き込む。
`AudioOut`の書き込み可能bytes数はPCM queueが空でも保持し、次のPCM受信時に排出を再開する。

Firmwareは対応するPCMを`AudioOut`へ書き込む直前に字幕を最大2行の吹き出しへ反映する。
実再生中は自律表情を停止し、PCMのRMSを0.1刻み、125 ms間隔で口の開きへ反映する。
再生完了または`SPEAKER_ABORT`で吹き出しを消し、口を閉じて自律表情を再開する。
認識中は回転インジケーター、発話中はスピーカーアイコンを顔画面へ表示する。

`ERROR` payloadは4 bytesのcodeである。
code 6はスピーカーPCMのsequence欠落、code 7はPCM受信buffer超過、code 8は字幕queue超過を表す。
USBホストはcodeと対象stream IDを再生traceおよび画面のエラーへ残す。

再生traceのschema version 2は、各`UsbSerialPort.write`について、要求byte数、完了byte数、queue投入時刻、実write開始時刻、完了時刻、frame種別、control、stream ID、sequence、sample rate、payload byte数を記録する。
時刻は再生trace開始からのmicrosecond単位の相対値である。
送信処理へのファイルI/O混入を避けるため、記録は再生中にメモリへ保持し、再生の終了または失敗時にJSONLへまとめて保存する。
traceにはPCM本体と字幕本文を保存しない。
字幕については文字数とUTF-8 byte数だけを保存する。
一つのtraceは10,000 eventまでとし、超過分がある場合は`trace_truncated`へ件数を記録する。

保存先はアプリの`voice-diagnostics/playback-traces`ディレクトリである。
PCへ取得したschema version 2のtraceは、Firmwareリポジトリの`usb-audio-diagnostics.py --replay-trace`で再生できる。
PC側はPCM本体を無音で再生成し、記録されたwrite境界と`startedElapsedUs`の間隔を再現する。

## Android dock appでの接続確認

1. USB音声対応Firmwareを書き込んだCoreS3をAndroid端末へ接続する。
2. AndroidのUSB利用許可を承認する。
3. アプリ画面の「CoreS3 USB」が「接続済み」になることを確認する。
4. Push-to-Talkで録音し、CoreS3のマイク入力とスピーカー出力を確認する。
5. ケーブルを抜き、会話が待機状態へ戻ることを確認する。
6. 再接続後に「USB接続を再試行」を押し、再び接続済みになることを確認する。
7. 頭上センサの前方スワイプでAndroidが自動会話を開始し、後方スワイプで停止することを確認する。

応答がない場合は、Firmwareが専用manifestで書き込まれていることと、データ通信対応ケーブルであることを確認する。
CoreS3のUSB Serial/JTAGポートをxsbugと音声通信で同時利用しない。
