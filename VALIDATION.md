# 検証記録

更新日：2026年7月21日

対象LLM：Gemma 4 E2BおよびE4B IT、LiteRT-LM 0.14.0

対象端末：motorola razr 50 ultra

## モデル選択とPiper自動準備の実装後のホスト検査

Linux x86_64上のプロジェクトローカル環境で、次の検査を実行した。

- `python3 scripts/check_project.py`
  - 必須ファイル、Manifest、Gradle設定、固定モデル情報、Piper Plus AARのSHA-256を検査
  - Kotlinソース60ファイルを検出
- `./scripts/dev.sh ./gradlew :app:testDebugUnitTest`
  - 37 tests、0 failures、0 errors
  - 文分割、実際の20 ms単位での発話区切り、短い音響インパルスの破棄、Whisper非音声字幕の除外を検査
  - 認識WAVと再生trace、12秒分のPCM送信、Firmwareエラー時の再生中断を検査
  - PCM変換、シリアルフレーム、Piper配布物、辞書ZIPの安全な展開、E2BとE4Bのrevision、サイズ、SHA-256定義を検査
- `./scripts/dev.sh ./gradlew :app:assembleDebug`
  - JDK 17.0.19
  - Gradle 8.13
  - Android Gradle Plugin 8.13.2
  - Kotlin 2.3.21
  - Android SDK 36
  - LiteRT-LM 0.14.0
  - Piper Plus v1.13.0のローカルAAR
- `./scripts/dev.sh ./gradlew :app:lintDebug`
  - 0 errors
  - 16 warnings
  - 15件は固定依存版より新しい版が存在するという通知
  - 1件はarm64-v8a限定APKに対するChromeOS x86_64 ABIの通知
  - 実装コードに対する警告は0件

生成したdebug APKは86,798,317 bytesである。

```text
app/build/outputs/apk/debug/app-debug.apk
SHA-256: 6a979e2387d79ff9bc1b46c22b4ed50f2f2ad3f0ecd2e569324a00b7588d420f
```

## Gemmaモデル取得情報の検査

E2BとE4Bの取得情報は次のrevisionへ固定した。

| モデル | revision | ファイルサイズ | SHA-256 |
|---|---|---:|---|
| E2B | `a4a831c060880f3733135ad22f10e0e9f758f45d` | 2,588,147,712 bytes | `181938105e0eefd105961417e8da75903eacda102c4fce9ce90f50b97139a63c` |
| E4B | `f7ad3343bd6ebc9607f4dc3bc4f2398bd5749bc5` | 3,659,530,240 bytes | `0b2a8980ce155fd97673d8e820b4d29d9c7d99b8fa6806f425d969b145bd52e0` |

2026年7月14日のHugging Face応答では、各`x-linked-etag`が上表のSHA-256と一致した。

両ファイルの1,048,576 byte地点を1 byteだけRange取得し、次の応答を確認した。

```text
E2B: HTTP 206, Content-Range: bytes 1048576-1048576/2588147712
E4B: HTTP 206, Content-Range: bytes 1048576-1048576/3659530240
```

したがって、現在の配布先は実装した途中再開方式を受け付ける。

E2BとE4Bは端末上のアプリが全ファイルのSHA-256を検証済みである。

アプリは端末上で選択モデルの全ファイルを読み、上表のSHA-256と一致した場合だけ`.litertlm`へatomic renameする。

## モデル選択と実機回帰

debug APKを`adb install -r`で上書きし、既存のE2B、Whisper、Piper Plusを保持した。

カバーディスプレイ上でE2BとE4Bの選択ボタンを確認した。
E4Bを選ぶと表示が`Gemma 4 E4B IT`と約3.66GBへ変わり、アプリ再起動後も選択が保持された。

既存E2Bに対してAndroid instrumented testを実行し、8.347秒で1件成功した。
LiteRT-LMはGPUバックエンドを選び、指示に対して`はい`を生成した。

E4Bのダウンロード、GPUロード、応答生成は実機で確認済みである。
E2Bとの速度および会話品質の比較値はまだ測定していない。

最終debug APKのE4B smoke testは22.352秒で成功した。
LiteRT-LMはGPUバックエンドを選び、指示に対して`はい`を生成した。

## Piper Plus推奨音声の自動準備

自動準備へ固定した配布物は次のとおりである。

| 配布物 | ファイルサイズ | SHA-256 |
|---|---:|---|
| つくよみちゃん6言語FP16 ONNX | 39,652,717 bytes | `5289e9b6eaf21080803b7fe1c4dc85b5491d4c216121207a41df18dd5f68e5d7` |
| 設定JSON | 6,901 bytes | `516058f405ec914140f34832a9d8bb5d8272ba62af9bc7ffb29349715a539780` |
| Piper Plus v1.13.0 Windows ZIP | 32,461,242 bytes | `d8b6237a546d996a65009bd88f2eb845fad876505952cce98eb3fedaf99fa3d7` |

motorola razr 50 ultra上の初回instrumented testは11.041秒で成功した。
この時間には約72MBのダウンロード、三ファイルのSHA-256検証、107,304,813 bytesの辞書展開、Piper Plusロード、非無音PCM生成を含む。

同じテストの二回目は2.686秒で成功した。
ログはONNXと設定JSONを既存ファイルとして確認し、OpenJTalk辞書を`確認済み`として扱ったため、ネットワーク取得と再展開を行っていない。

キャッシュ済み資産に対する最終debug APKの回帰試験は2.711秒で成功し、非無音PCMを生成した。

辞書展開処理はZIP内の`piper/share/open_jtalk/dic/`だけを対象にし、展開先外へ移動するパスを拒否する。
単体テストでは必要な辞書ファイルだけを展開できることと、`../`を含むエントリーを拒否することを確認した。

## APKとネイティブライブラリの検査

APKにはarm64-v8aのnative libraryが16本含まれる。

`liblitertlm_jni.so`を含み、旧LLM用のllama.cppライブラリは含まれない。

`zipalign -c -P 16 -v 4`は成功した。

`readelf -lW`で16本すべてのLOAD segmentを調べ、`p_align`が`0x4000`以上であることを確認した。

マージ済みManifestには、GPU経路用の`libOpenCL.so`と`libvndksupport.so`が`required=false`で含まれる。

Piper Plus用ONNX Runtime 1.20.0は`libonnxrtpiper.so`、RunAnywhere側ONNX Runtime 1.17.1は`libonnxruntime.so`として分離されている。

## 旧Qwen3経路の実機記録

次の結果はGemma移行前のQwen3 4B経路で取得した比較基準である。

motorola razr 50 ultraの初期実装では、自動会話1回の録音が最大長の15秒まで終了せず、STTへ480,000 bytesが渡されていた。

この音声のSTTは9.334秒、Qwen3 4BのTTFTは30.530秒であり、応答開始までの合計は約55秒だった。

認識結果は英語判定となり、`(clicking) (scissors snipping)`という非音声字幕が返った。

原因は次の三点だった。

- 100msのPCMチャンクを、10ms、20ms、30msだけを受け付けるWebRTC VADへそのまま渡していた
- 350ms未満の短い誤検出を発話として開始した後、終了条件を満たせず15秒まで保持していた
- RunAnywhere 0.20.6のONNX STTが呼び出し時の`language=ja`を反映せず、ロード時の既定値`en`を使っていた

修正版では、100msチャンクを20msずつ処理し、350ms未満の短い検出を後続無音時点で破棄する。

STTはsherpa-onnx 1.12.20を直接呼び出し、認識器生成時に`language=ja`と4 CPU threadsを設定する。

修正後の実機では、Whisper認識器の生成が5.807秒、1秒の無音PCMのデコードが1.192秒だった。

旧Qwen3 4Bのモデルロードは3.226秒、初回ウォームアップは15.260秒、OSページキャッシュ後の再実行は3.323秒だった。

RunAnywhere ONNX、Piper Plus JNI、WebRTC VADの同一プロセスでのロードも確認済みである。

## CoreS3 USB音声経路

Androidのdebug unit testで、Firmwareと共通のwire vector、断片受信、複数frame結合、CRC破損後の再同期を確認した。
同じtestで16 kHzから24 kHzへの補間値、22.05 kHz入力のchunk境界、24 kHzの無変換経路を確認した。

CoreS3 Firmwareでは207件のunit testと69件のarchitecture testが成功した。
release manifestをESP-IDF 6.0でbuildし、6,018,928 bytes（`0x5BD770`）のESP32-S3 imageを生成した。
SHA-256は`75e1980957ceae11b5cff1a7d6945d1cea15a3681f85b5d7def5cc76b75e251b`である。
app partitionには63%の空きがある。

motorola razr 50 ultraとCoreS3をUSB接続し、CoreS3のマイク入力、スピーカー出力、音声対話の基本経路を確認した。

再生平滑化の変更後は、Androidのunit testで字幕とPCMの順序、80 msのPCM分割、旧Firmwareとの互換性、credit停止中のproducer queueを確認した。
CoreS3 Firmwareでは、Workerと共有ringの責務、保持した`AudioOut`書き込み可能量、字幕順序、口パク量子化をunit testとarchitecture testで確認した。
CoreS3向けrelease buildと、自律表情停止中の口更新を含むModdable testも成功した。

音量0の実機診断では、UIを有効にした状態で24 kHz、15.04秒、721,920 bytesを約14.99秒のAudioOut書き込み区間で処理した。
受信bytesと書き込みbytesは一致し、starvationは0回だった。
8 kHzと16 kHzの8秒再生、および24 kHzの吹き出し付き8秒再生でもbytesは一致し、starvationは0回だった。

今回報告された「途切れる」は音声の一部が欠落する現象ではなく、再生セッションが数秒で終了する現象である。
PCから送った15.04秒の固定長PCMはCoreS3で最後まで再生されたため、CoreS3単体の持続再生経路では早期終了を再現していない。

Androidは、Piper合成が正常に最後まで終わった場合だけ`SPEAKER_END`を送る。
合成の取消しまたは例外時は、部分PCMを正常終了として扱わず、同期的に`SPEAKER_ABORT`を送る。
新しい再生を開始する前には、前回の遅延`SPEAKER_ABORT`が終わるまで待つ。
単体テストでは12秒分の全PCM frameが`SPEAKER_END`より前に送られることと、Firmwareの`ERROR`がcredit待ちを直ちに解除することを確認した。

端末には、Piper入力sample数、24 kHz変換後のPCM長、送信frame数、`SPEAKER_END`、`SPEAKER_DONE`、`SPEAKER_ABORT`、例外をJSON Linesで保存する。
この記録により、Piperが短いPCMを返した場合、Androidが途中終了した場合、CoreS3が先に終了した場合を区別できる。

自動VADでは、CoreS3から届くPCM chunkが20 msであるにもかかわらず、発話蓄積器が1 chunkを100 msとして数えていた。
そのため、350 msの発話開始条件は実時間で約80 ms、15秒の上限は実時間で約3秒になっていた。
修正版はchunk byte数、sample rate、channel数、sample幅から実時間を計算し、VADの初期校正を300 msにした。
Whisperへ渡した音声はWAV、その認識結果と除外理由はJSONとして端末へ保存する。

release Firmwareの`speakerVolume`は0.25である。
認識中は回転インジケーター、発話中はスピーカーアイコンを表示する。

対象CoreS3（MAC address `44:1B:F6:E2:82:B0`）にはrelease Firmwareを書き込み、`HELLO_ACK`のcapability `0x0000017f`と三つの状態通知を確認した。
motorola razr 50 ultraには上記debug APKを`adb install -r`で上書きし、起動を確認した。

AndroidとCoreS3を直接接続した状態では、再生早期終了、0.25音量、認識中・発話中アイコン、口パク、吹き出し、診断ファイル生成を再確認する必要がある。

## E4Bで残る性能検査

次の確認が残っている。

1. 固定した日本語5発話以上でTTFT、生成速度、最初の可聴音までの時間をE2Bと比較する。
2. 同じ会話課題で応答の一貫性と指示追従をE2Bと比較する。
3. 15分の連続会話でクラッシュ、OOM、回復不能なGPUエラーがないことを確認する。
4. E2Bへ戻したときに、保存済みモデルを再ダウンロードせず再ロードできることを確認する。

GPU初期化またはウォームアップに失敗した場合、アプリはMTPを無効にしてCPUへ退避する。

CPU表示はセットアップ失敗ではないが、応答速度の採用条件を満たすかは別途測定する必要がある。
