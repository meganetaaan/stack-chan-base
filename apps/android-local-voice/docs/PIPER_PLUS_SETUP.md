# Piper Plus Android setup

## AARのローカル配置

Piper Plus AARはGit管理していないため、fresh cloneには含まれません。
タグ`v1.13.0`のAndroidラッパーと同リリースworkflowのarm64-v8a成果物からローカルビルドし、インストールスクリプトで配置してください。

```bash
./scripts/install_piper_aar.sh \
  /path/to/piper-plus/android/piper-plus/build/outputs/aar/piper-plus-release.aar
```

```bash
sha256sum -c app/libs/piper-plus-release.aar.sha256
```

取得元とハッシュは`app/libs/README.md`に記録しています。

## 必要な3要素

1. `piper-plus-release.aar`
2. Piper Plus互換の日本語音声モデル `.onnx`
3. そのモデルの設定 `.json` とOpenJTalk辞書

AARは`app/libs/piper-plus-release.aar`へ置きます。
日本語モデルと辞書はAPKへ同梱せず、推奨音声の自動セットアップまたは端末上のファイル選択UIで取得します。

## 推奨音声の自動セットアップ

「推奨音声をダウンロードして準備」を押すと、アプリは次の処理を連続して実行します。

1. つくよみちゃんコーパスの利用条件を初回だけ確認する。
2. ONNX、設定JSON、辞書ZIPをアプリ内部へダウンロードする。
3. 配布情報へ固定したファイルサイズとSHA-256を検証する。
4. 辞書ZIPから`piper/share/open_jtalk/dic/`だけを安全な一時ディレクトリへ展開する。
5. 辞書の必須ファイルを検査し、Piper Plusへロードする。

取得情報は次のとおりです。

| 配布物 | サイズ | SHA-256 |
|---|---:|---|
| つくよみちゃん6言語FP16 ONNX | 39,652,717 bytes | `5289e9b6eaf21080803b7fe1c4dc85b5491d4c216121207a41df18dd5f68e5d7` |
| 設定JSON | 6,901 bytes | `516058f405ec914140f34832a9d8bb5d8272ba62af9bc7ffb29349715a539780` |
| Piper Plus v1.13.0 Windows ZIP | 32,461,242 bytes | `d8b6237a546d996a65009bd88f2eb845fad876505952cce98eb3fedaf99fa3d7` |

ダウンロード量は約72MBで、展開後の辞書を含む保存領域は約147MBです。
処理中に必要なZIPと一時領域を含め、端末には300MiB以上の空きを確保します。

ダウンロード済みのONNXと設定JSONにはSHA-256マーカーを保存します。
展開済み辞書にも元ZIPのSHA-256を保存するため、同じ固定版の再準備ではネットワーク取得を繰り返しません。

## 日本語音声資産の例

Piper Plus v1.13.0で利用できる現行の単一話者モデルとして、[Piper Plus つくよみちゃん](https://huggingface.co/ayousanz/piper-plus-tsukuyomi-chan)があります。
使用する場合は、モデルリポジトリから`tsukuyomi-chan-6lang-fp16.onnx`と`config.json`を同じ端末へ保存します。
このモデルにはつくよみちゃんコーパスの利用条件が適用されるため、取得前にモデルカードのLicense節を確認してください。

OpenJTalk辞書は[Piper Plus v1.13.0](https://github.com/ayutaz/piper-plus/releases/tag/v1.13.0)の`piper-windows-x64.zip`に含まれる次のディレクトリを利用します。
辞書データ自体はCPUアーキテクチャに依存しません。

```text
piper/share/open_jtalk/dic/
```

任意音声を手動設定する場合は、端末へコピーした後、画面でONNX、JSON、辞書の順に選択します。
辞書では`sys.dic`、`unk.dic`、`matrix.bin`などが直接入っている`dic`フォルダを選択してください。

## AARの要件

AAR内部には少なくとも次が必要です。

```text
classes.jar
jni/arm64-v8a/libonnxrtpiper.so
jni/arm64-v8a/libpiper_plus.so
jni/arm64-v8a/libpiper_plus_jni.so
```

Piper PlusはONNX Runtime 1.20.0、RunAnywhereは1.17.1を要求し、`OrtGetApiBase`のシンボル版が異なります。
一方をGradleの`pickFirst`で選択すると、もう一方のnative libraryをロードできません。
このプロジェクトではPiper側を`libonnxrtpiper.so`へ分離し、RunAnywhere側の`libonnxruntime.so`と併存させます。

Android 15以降の16 KiBページサイズへ対応するには、APK内の配置だけでなく各ELFのLOADセグメントも16 KiB以上でアラインされている必要があります。
JNIラッパーには`-Wl,-z,max-page-size=16384`を指定してください。
NDK r26の`libc++_shared.so`は4 KiBアラインメントのため、このAARでは上流の`piper-plus-g2p`モジュールと同じく`c++_static`を使っています。

AARの差し替えには次のスクリプトを使います。

```bash
./scripts/install_piper_aar.sh /path/to/piper-plus-release.aar
```

スクリプトはPiper側のONNX Runtime、SONAME、`libpiper_plus.so`の依存名を分離してから、`app/libs/piper-plus-release.aar`とSHA-256記録を更新します。
すでに分離済みのAARを入力しても同じ結果になるよう設計しています。

## 手動設定の辞書フォルダ

ファイル選択時は、OpenJTalk辞書ファイルが直接入っているフォルダを選択します。
親フォルダを選択すると、native側が期待するパスとずれる可能性があります。
取り込んだファイルは次へコピーされます。

```text
files/piper-plus/voice.onnx
files/piper-plus/voice.onnx.json
files/piper-plus/open_jtalk_dic/...
```

自動セットアップした推奨音声は、固定版ごとに次の下へ保存されます。

```text
files/piper-plus/recommended/<setup-id>/voice.onnx
files/piper-plus/recommended/<setup-id>/voice.onnx.json
files/piper-plus/recommended/<setup-id>/open_jtalk_dic/...
```
