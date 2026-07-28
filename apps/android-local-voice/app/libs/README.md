# Piper Plus Android AAR

このディレクトリには、次の名前でAARを配置します。

```text
piper-plus-release.aar
```

現在のローカル成果物はPiper Plus v1.13.0です。

- タグ: `v1.13.0`
- ソースコミット: `7d3aa34e7acf5f8c91d6ad280aefbb369905db2a`
- native artifact: GitHub Actions run `27554313822`の`libpiper_plus-android-arm64-v8a`
- native artifact archive SHA-256: `9ae93009e115137e034d5ee76fe71380036d9b6c0044b554060100754b9f30c3`
- 分離前AAR SHA-256: `5a578d8ba1a53da3f85febd08353be49f8a7d166bd7fcd07e795d9c965b71daa`
- 配置済みAAR SHA-256: `b43d4aeb46af952db7205106dfed68a51bab19fc8343370479a467caf9e3b688`

公式リリースにはAndroid AARがないため、AARはタグのAndroidラッパーからローカルビルドしました。
JNIラッパーはC++ランタイムを静的リンクし、`-Wl,-z,max-page-size=16384`を指定しています。
これにより、AARはRunAnywhereの`libc++_shared.so`と衝突せず、16 KiBページサイズに対応します。
Piper Plus 1.20.0とRunAnywhere 1.17.1のONNX Runtimeは、`OrtGetApiBase`に異なるシンボル版を使うため相互置換できません。
インストールスクリプトはPiper側を`libonnxrtpiper.so`へ改名し、`libpiper_plus.so`の依存名とランタイムのSONAMEも同時に変更します。
置換前後の名前は同じバイト長なので、ELFセグメント配置と16 KiBアラインメントは変わりません。

AAR本体は`.gitignore`の対象です。
`piper-plus-release.aar.sha256`は配置したバイナリの整合性確認に使います。
アプリは`com.piperplus.PiperPlus`をリフレクションで読み込むため、AARがなくてもコンパイルできますが、日本語TTSは利用できません。
