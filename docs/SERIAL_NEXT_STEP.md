# CoreS3 USB CDC音声通信

Android端末をUSBホスト、M5Stack CoreS3をUSB Serial/JTAGデバイスとして接続する。
Android側は`usb-serial-for-android`でVID `0x303A`、PID `0x1001`のCDCポートを開く。
通信速度の設定値は115,200 baudだが、実際の転送はUSB CDCで行われる。

## 音声形式

マイクは16 kHz、16 bit little-endian、monoで固定する。
Firmwareは20 ms、640 bytes単位の`MICROPHONE_PCM`をAndroidへ送る。
Androidはsequenceの欠損を最大10フレームまで無音で補完し、それを超える欠損を通信エラーとする。

スピーカーは8 kHz、16 kHz、24 kHzの16 bit little-endian、monoを受け付ける。
Androidの既定出力は24 kHzであり、Piperが返すsample rateから線形補間で逐次変換する。
CoreS3の`AudioOut`にはUSBフレームと同じsample rateを指定する。
AndroidはスピーカーPCMを80 ms単位で送る。
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

## 制御手順

接続直後、Androidは`HELLO`を送る。
HELLO payloadは最大payload長とcapability bitsetを並べた二つの`uint32`である。
Firmwareは同じ形式の`HELLO_ACK`を返す。
Androidはマイク、スピーカー、credit、24 kHz出力のcapabilityを確認して`READY`へ遷移する。
Androidはさらにcapability bit 9のstream ID対応を必須として確認する。

録音は`MIC_START`、`MIC_STARTED`、`MICROPHONE_PCM`、`MIC_STOP`、`MIC_STOPPED`の順で制御する。
再生は`SPEAKER_START`、`SPEAKER_CREDIT`、`SPEAKER_PCM`、`SPEAKER_END`、`SPEAKER_DONE`の順で制御する。
Firmwareがcapability bit 6を返した場合、Androidは各文のPCM直前に`SPEAKER_TEXT=37`を送る。
`SPEAKER_TEXT` payloadは最大1,024 bytesのUTF-8で、sample rateは再生中の値と一致させる。
このcapabilityは任意であり、未対応Firmwareに対してAndroidは字幕を送らない。
中断時は`SPEAKER_ABORT`を送る。
Firmwareがcapability bit 8を返した場合、Androidは`STATUS=48`で会話状態を送る。
payloadは1 byteで、`IDLE=0`、`RECOGNIZING=1`、`SPEAKING=2`とする。

Firmwareのスピーカーqueueは1秒分である。
`SPEAKER_CREDIT` payloadは新たに送信可能になったbytes数を表す増分値である。
未消費creditの上限は8 KiBとし、一回の送信量がFirmwareのnative USB受信ringに収まるよう制限する。
Androidはcreditを消費してからPCMを送り、FirmwareはPCM queueに空きが生じた分だけcreditを返す。
Androidは最大5秒分のPCMを送信待ちqueueへ保持し、Piper合成をcredit待ちから分離する。
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
Androidはcodeと対象stream IDを再生traceおよび画面のエラーへ残す。

再生traceのschema version 2は、各`UsbSerialPort.write`について、要求byte数、完了byte数、queue投入時刻、実write開始時刻、完了時刻、frame種別、control、stream ID、sequence、sample rate、payload byte数を記録する。
時刻は再生trace開始からのmicrosecond単位の相対値である。
送信処理へのファイルI/O混入を避けるため、記録は再生中にメモリへ保持し、再生の終了または失敗時にJSONLへまとめて保存する。
traceにはPCM本体と字幕本文を保存しない。
字幕については文字数とUTF-8 byte数だけを保存する。
一つのtraceは10,000 eventまでとし、超過分がある場合は`trace_truncated`へ件数を記録する。

保存先はアプリの`voice-diagnostics/playback-traces`ディレクトリである。
PCへ取得したschema version 2のtraceは、Firmwareリポジトリの`usb-audio-diagnostics.py --replay-trace`で再生できる。
PC側はPCM本体を無音で再生成し、記録されたwrite境界と`startedElapsedUs`の間隔を再現する。

## 接続確認

1. USB音声対応Firmwareを書き込んだCoreS3をAndroid端末へ接続する。
2. AndroidのUSB利用許可を承認する。
3. アプリ画面の「CoreS3 USB」が「接続済み」になることを確認する。
4. Push-to-Talkで録音し、CoreS3のマイク入力とスピーカー出力を確認する。
5. ケーブルを抜き、会話が待機状態へ戻ることを確認する。
6. 再接続後に「USB接続を再試行」を押し、再び接続済みになることを確認する。

応答がない場合は、Firmwareが専用manifestで書き込まれていることと、データ通信対応ケーブルであることを確認する。
CoreS3のUSB Serial/JTAGポートをxsbugと音声通信で同時利用しない。
