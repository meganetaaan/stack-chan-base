# 検証記録

更新日：2026年7月14日

対象LLM：Gemma 4 E2BおよびE4B IT、LiteRT-LM 0.14.0

対象端末：motorola razr 50 ultra

## E2BとE4Bの選択実装後のホスト検査

Linux x86_64上のプロジェクトローカル環境で、次の検査を実行した。

- `python3 scripts/check_project.py`
  - 必須ファイル、Manifest、Gradle設定、固定モデル情報、Piper Plus AARのSHA-256を検査
  - Kotlinソース47ファイルを検出
- `./scripts/dev.sh ./gradlew :app:testDebugUnitTest`
  - 16 tests、0 failures、0 errors
  - 文分割、発話区切り、短い音響インパルスの破棄、Whisper非音声字幕の除外を検査
  - PCM変換、シリアルフレーム、Piper取得URL、E2BとE4Bのrevision、サイズ、SHA-256定義を検査
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

生成したdebug APKは86,626,133 bytesである。

```text
app/build/outputs/apk/debug/app-debug.apk
SHA-256: 72417ed8ca9932927c4e3312ae081a96aeb75bfa7456080c7e7ad9d81a00294b
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

E2Bは端末上のアプリが全ファイルのSHA-256を検証済みである。
E4Bはモデル全体をまだ取得していないため、端末上の全ファイル検証は実施していない。

アプリは端末上で選択モデルの全ファイルを読み、上表のSHA-256と一致した場合だけ`.litertlm`へatomic renameする。

## モデル選択と実機回帰

debug APKを`adb install -r`で上書きし、既存のE2B、Whisper、Piper Plusを保持した。

カバーディスプレイ上でE2BとE4Bの選択ボタンを確認した。
E4Bを選ぶと表示が`Gemma 4 E4B IT`と約3.66GBへ変わり、アプリ再起動後も選択が保持された。

既存E2Bに対してAndroid instrumented testを実行し、8.347秒で1件成功した。
LiteRT-LMはGPUバックエンドを選び、指示に対して`はい`を生成した。

E4Bの選択状態は確認済みだが、3,659,530,240 bytesの本体は自動取得していない。
E4Bのロード、生成速度、メモリ使用量、会話品質はモデル取得後に測定する。

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

## E4Bで必要な実機検査

次の確認が残っている。

1. E4Bのモデル準備を開始し、途中再開とSHA-256検証を確認する。
2. `準備完了 (GPU)`または`準備完了 (CPU)`が表示され、ウォームアップ生成が成功することを確認する。
3. 固定した日本語5発話以上でTTFT、生成速度、最初の可聴音までの時間をE2Bと比較する。
4. 同じ会話課題で応答の一貫性と指示追従をE2Bと比較する。
5. 15分の連続会話でクラッシュ、OOM、回復不能なGPUエラーがないことを確認する。
6. E2Bへ戻したときに、保存済みモデルを再ダウンロードせず再ロードできることを確認する。

GPU初期化またはウォームアップに失敗した場合、アプリはMTPを無効にしてCPUへ退避する。

CPU表示はセットアップ失敗ではないが、応答速度の採用条件を満たすかは別途測定する必要がある。
