# stack-chan-dock

stack-chan-dockは、ｽﾀｯｸﾁｬﾝをUSBでPCやスマートフォンへ接続し、それらの計算能力やサービスで能力を拡張する実験リポジトリです。
`contracts/usb-cdc-v2`をｽﾀｯｸﾁｬﾝとの境界に置き、ｽﾀｯｸﾁｬﾝ側のFirmwareは身体とUSBデバイス、PCまたはスマートフォン上のdock appは音声処理や対話処理を担当します。

```text
Android local voice dock app ─┐
                              ├── USB CDC v2 contract ── Stack-chan Firmware
PC Codex voice dock app ──────┘                           （外部リポジトリ）
```

## 用語

- **dock**：ｽﾀｯｸﾁｬﾝをUSB経由で外部の計算環境へ接続し、能力を拡張する構成。
- **dock app**：PCまたはスマートフォン上で動作し、USB CDC contractを実装するアプリ。
- **USBホスト**：USB接続における役割名。
- **Moddable host**：Moddable SDK側のhost applicationを指す用語であり、dock appの分類名には使用しない。

## ディレクトリ

| パス | 役割 |
|---|---|
| [`contracts/usb-cdc-v2`](contracts/usb-cdc-v2/README.md) | USB framing、音声制御、application eventの正本 |
| [`apps/android-local-voice`](apps/android-local-voice/README.md) | Android端末上でASR、LLM、TTSをローカル実行するdock app |
| [`apps/codex-voice`](apps/codex-voice/README.md) | PC上のCodex app-serverとｽﾀｯｸﾁｬﾝを接続するdock app |

各dock appは、build設定、依存関係、開発スクリプトを自身のディレクトリ内に持ちます。
USB wire形式はdock appごとに定義せず、`contracts/usb-cdc-v2`を参照します。

## Android local voice dock app

```bash
cd apps/android-local-voice
./scripts/bootstrap-dev.sh
./scripts/dev.sh ./gradlew :app:assembleDebug
```

モデルの準備、Android端末への導入、実機検証は[Android dock appのREADME](apps/android-local-voice/README.md)を参照してください。

## Codex voice dock app

```bash
cd apps/codex-voice
npm ci
npm test
npm run build
```

Codex app-serverへの接続とsystemd user serviceの導入は[Codex dock appのREADME](apps/codex-voice/README.md)を参照してください。

## リポジトリ全体の検証

各dock appの依存関係を準備した後、次のコマンドでcontract適合試験と両dock appのテストを実行できます。

```bash
./scripts/verify.sh
```

このスクリプトは依存関係をインストールしません。
AndroidのJDKとSDKがない場合はAndroid dock appで`./scripts/bootstrap-dev.sh`を実行し、Codex dock appの`node_modules`がない場合は同じディレクトリで`npm ci`を実行してください。

## リポジトリの境界

このリポジトリは、複数のdock app構成を比較する実験場所です。
Firmwareのsourceやdock app間で共有するruntime libraryは含めません。
USB contractの変更時はversionを明示し、各dock appと外部Firmwareの適合試験を同じwire vectorで更新します。
