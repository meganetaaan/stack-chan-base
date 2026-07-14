# M5StackChan USB serial next step

> この文書は、現在のcodecを使う最初の接続手順を記録する。
>
> センサー、身体表現、flow control、安全制御を含む目標仕様は[TARGET_ARCHITECTURE.md](TARGET_ARCHITECTURE.md)を参照する。

PoCのAndroid音声I/Oを次のように置き換えます。

```text
AndroidMicrophoneSource  → SerialPcmAudioSource
AndroidPcmAudioSink      → SerialPcmAudioSink
```

`StackChanFrameCodec`のフレームは次の固定ヘッダーを持ちます。

```text
magic       uint16  "SC"
version     uint8   1
type        uint8
flags       uint16
reserved    uint16
sequence    uint32
sampleRate  uint32
length      uint32
payload     byte[length]
crc32       uint32  header + payload
```

型はcontrol、microphone PCM、speaker PCM、expression、motion、diagnosticsです。
PCMは16bit little-endian monoとし、20〜100ms単位で送ります。

実装順序は次の通りです。

1. AndroidからM5へ`CONTROL/HELLO`を送り、protocol versionと最大フレーム長を合意する。
2. `SPEAKER_PCM`だけを実装し、Android TTSをM5のI2Sで再生する。
3. `MICROPHONE_PCM`を実装し、AndroidマイクをM5マイクへ置き換える。
4. `EXPRESSION`と`MOTION`をLLM/TTS状態へ同期する。
5. USB切断時にAudioSource/Sinkを閉じ、会話をIDLEへ戻す。

Android側はUSB Host APIまたは`usb-serial-for-android`でCDC/ACMを開きます。音声は再送より
低遅延を優先し、sequence gapを検出したら欠損フレームを無音で補う方針が適しています。
