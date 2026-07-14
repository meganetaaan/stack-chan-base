# Piper Plus Android setup

## 配置済みAAR

この作業ディレクトリには、Piper Plus v1.13.0からローカルビルドしたAARを配置済みです。
公式リリースにはAndroid AARがないため、タグ`v1.13.0`のAndroidラッパーと同リリースworkflowのarm64-v8a成果物を組み合わせています。

```bash
sha256sum -c app/libs/piper-plus-release.aar.sha256
```

取得元とハッシュは`app/libs/README.md`に記録しています。

## 必要な3要素

1. `piper-plus-release.aar`
2. Piper Plus互換の日本語音声モデル `.onnx`
3. そのモデルの設定 `.json` とOpenJTalk辞書

AARは`app/libs/piper-plus-release.aar`へ置きます。日本語モデルと辞書はAPKへ固定せず、
端末上のファイル選択UIで取り込みます。モデルのライセンスと音声話者の利用条件を
アプリコードから分離するためです。

## 日本語音声資産の例

Piper Plus v1.13.0で利用できる現行の単一話者モデルとして、[Piper Plus つくよみちゃん](https://huggingface.co/ayousanz/piper-plus-tsukuyomi-chan)があります。
使用する場合は、モデルリポジトリから`tsukuyomi-chan-6lang-fp16.onnx`と`config.json`を同じ端末へ保存します。
このモデルにはつくよみちゃんコーパスの利用条件が適用されるため、取得前にモデルカードのLicense節を確認してください。

OpenJTalk辞書は[Piper Plus v1.13.0](https://github.com/ayutaz/piper-plus/releases/tag/v1.13.0)の`piper-linux-x64.tar.gz`に含まれる次のディレクトリを利用できます。
辞書データ自体はCPUアーキテクチャに依存しません。

```text
piper/share/open_jtalk/dic/
```

端末へコピーした後、画面ではONNX、JSON、辞書の順に選択します。
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

## 辞書フォルダ

ファイル選択時は、OpenJTalk辞書ファイルが直接入っているフォルダを選択します。
親フォルダを選択すると、native側が期待するパスとずれる可能性があります。
取り込んだファイルは次へコピーされます。

```text
files/piper-plus/voice.onnx
files/piper-plus/voice.onnx.json
files/piper-plus/open_jtalk_dic/...
```
