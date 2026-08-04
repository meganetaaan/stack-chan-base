# Stack-chan Codex Voice Dock App

CoreS3のUSBマイク、スピーカー、状態表示、承認UIを、ローカルで動作中のCodex app-server daemonへ接続するTypeScript製CLIです。

Codex SDKは使用しません。daemonのUnix socketへ標準WebSocketで接続し、app-server JSON-RPCのexperimentalな`thread/realtime/*` APIとapproval server requestを扱います。Realtime v3のセッション確立、マイク入力、スピーカー出力にはWebRTCを使います。

## 必要なもの

- Node.js 22以上
- `codex-cli` 0.145.0相当のRealtime API
- ChatGPTへログイン済みのCodex app-server
- USB v2 contractとEVENT capabilityに対応したM5Stack CoreS3 firmware
- メニューバーアプレットを使う場合は、systemd user service、GJS、GTK 3、AyatanaAppIndicator3、StatusNotifier対応パネル

WebSocket音声transportはAPIキー認証を要求しますが、このブリッジはWebRTC transportを使います。ChatGPTログインで接続でき、`OPENAI_API_KEY`は不要です。app-serverのWebRTC仕様は[Codex app-server README](https://github.com/openai/codex/blob/25af12f7e61572b0bc18ddb1008be543b91519b0/codex-rs/app-server/README.md#L898-L943)を参照してください。

## セットアップ

```bash
cd apps/codex-voice
npm ci
npm test
npm run build
```

`npm ci`の`postinstall`は、固定した`werift` 0.24.1へICE consent freshness修正を適用します。
`--ignore-scripts`を付けると修正されないため、このブリッジでは使用しません。
パッチは対象バージョンと変更前コードを検査し、未知の`werift`へ誤適用せず停止します。

### app-serverの確認

```bash
codex login status
```

`Logged in using ChatGPT`と表示されることを確認します。Codex appなどがremote-control daemonを起動済みなら、そのまま既定socketへ接続します。手動で別socketを使う場合:

```bash
codex app-server --listen unix:///tmp/stackchan-codex.sock
```

app-serverのTypeScript schemaを確認・更新する場合は、インストール済みCodex CLIから生成します。

```bash
npm run generate:codex-types
```

生成物は`generated/codex`へ出力されます。Codexバージョン固有の検査用データなのでリポジトリにはコミットせず、通常ビルドにも含めません。ブリッジは利用するwire shapeをruntimeでも検証します。

## 実行

会話用workspaceを初期化します。

```bash
node dist/src/cli.js \
  config init /absolute/path/to/conversation-workspace

node dist/src/cli.js \
  config set voice spruce \
  --workspace /absolute/path/to/conversation-workspace

node dist/src/cli.js \
  workspace use /absolute/path/to/conversation-workspace
```

workspaceには`.stackchan/session.toml`、`.stackchan/realtime-prompt.md`、
`AGENTS.md`、`.agents/skills/stackchan/SKILL.md`を作成します。
workspaceルートをCodex threadの作業ディレクトリとし、プロセス起動時は常に新しいthreadを開始します。
voiceを省略するとapp-serverの既定値を使用します。

利用可能なvoiceはUSB接続なしで確認できます。

```bash
node dist/src/cli.js voice list
```

Codex app-serverのRealtime v3が現在返すvoiceは次の9種類です。

| 設定値 |
| --- |
| `juniper` |
| `maple` |
| `spruce` |
| `ember` |
| `vale` |
| `breeze` |
| `arbor` |
| `sol` |
| `cove` |

app-serverの既定値は`cove`です。
この一覧はGPT-Liveを使う[ChatGPT Voice](https://learn.chatgpt.com/docs/features/voice)の選択肢と同じ系列です。
公開Realtime APIを直接利用する場合の[voice options](https://developers.openai.com/api/docs/guides/realtime-conversations#voice-options)とは別系列なので、設定可能な値を混同しないでください。
提供側の変更に追従する必要があるため、実行環境での正本は常に`voice list`の出力です。

音声ブリッジを起動します。

```bash
node dist/src/cli.js run --port /dev/ttyACM0
```

起動後はstandbyで待機します。
Codex専用MODを導入したStack-chanの頭上を前方へスワイプすると会話を開始し、後方へスワイプすると停止します。
単純なタッチでは開始しません。

会話開始時は660 Hzを90ミリ秒、25ミリ秒の無音、990 Hzを150ミリ秒の順で鳴らします。
会話終了時は990 Hzを90ミリ秒、25ミリ秒の無音、660 Hzを150ミリ秒の順で鳴らします。
開始音はRealtimeとマイクを開始する前に再生し、終了音はRealtime音声がスピーカーを解放してから再生します。
ToneはブリッジがPCMとして生成し、応答音声と同じUSBスピーカー経路へ直列化します。
MOD側で別のAudioOutを開かないため、応答再生中の後方スワイプでもスピーカーを競合させません。

従来どおり起動直後にRealtimeを開始する診断では、`--start-immediately`を追加します。

daemon socketも明示する場合:

```bash
node dist/src/cli.js \
  run \
  --port /dev/ttyACM0 \
  --socket /tmp/stackchan-codex.sock
```

複数のCoreS3を接続する手動運用では、列挙順の変わるdevice pathではなくUSB serial numberを使います。

```bash
node dist/src/cli.js \
  run \
  --device-id USB_SERIAL_NUMBER
```

`--device-id`と`--port`と`--device-selection`は同時に指定できません。
指定したIDが見つからなくても、別のCoreS3へ自動接続しません。
`--device-selection`はsystemd user serviceが選択ファイルを読むための引数です。
通常の手動実行では指定しません。
`--cwd`、`--voice`、`--thread`は受け付けません。
会話設定を変更した場合は`workspace apply`で常駐serviceへ反映します。

`You have reached your usage limit.`が表示された場合、WebRTC接続自体ではなくChatGPT側のVoice利用枠に達しています。
このエラーにはapp-serverからリセット時刻が付かないため、ブリッジはRealtimeの自動再接続を停止してエラー表示を出します。
プロセスはstandbyのまま常駐し、利用枠の回復後に次の前方スワイプで明示的に再試行できます。

`stream disconnected before completion`や`Connection reset without closing handshake`が表示された場合は、app-serverからOpenAIへ張られたsideband WebSocketが切断されています。
ブリッジは受信済み音声を再生してから、CoreS3とのUSB接続を維持したままRealtimeセッションだけを500msから30秒までの指数バックオフで再接続します。
USB自体が切断された場合に限り、別の指数バックオフでUSBを開き直します。
各接続が30秒以上安定した後は、対応する次の待機時間を500msへ戻します。
daemon側の記録は通常`~/.codex/app-server-daemon/app-server.stderr.log`で確認できます。

## 常駐サービス

先にbuildを実行し、`/dev/ttyACM0`へ最初に使うStack-chanを接続します。
インストーラはこのポートのUSB serial numberを取得し、`~/.config/stackchan-codex-voice/selected-device`へ保存します。
systemd user unitは起動時にこの選択ファイルを読みます。

```bash
npm run build
node dist/src/cli.js workspace use /absolute/path/to/conversation-workspace
npm run install:user-service -- --port /dev/ttyACM0
```

生成内容だけを確認する場合は`--dry-run`を追加します。
unitは既存のCodex Desktop管理app-serverへ接続し、音声ブリッジだけをforegroundで常駐させます。

```bash
systemctl --user status stackchan-codex-voice.service
journalctl --user -u stackchan-codex-voice.service -f
```

同名unitがこのインストーラの生成物でない場合は上書きしません。
インストーラはunitを有効化した後に`is-active`を検査し、起動できないunitを成功として報告しません。
生成unitは設定不備を示す終了コード78を自動再起動しません。
既存unitへこの設定を反映する場合は、build後に`npm run install:user-service -- --port /dev/ttyACM0`を再実行してください。

旧`bridge/codex-stackchan-voice`、`hosts/codex-voice`、または旧CLIから移行する場合、
既存unitには移動前のCLI絶対パスや`--cwd`、`--voice`が残っています。
先に`workspace use`を実行し、新しいディレクトリでインストーラを再実行してください。

```bash
systemctl --user restart stackchan-codex-voice.service
```

## メニューバーアプレット

アプレットはCodex voice serviceのONとOFF、接続中のCoreS3一覧、選択中の接続先を表示します。
接続先はUSB serial numberで保存するため、再接続によって`/dev/ttyACM*`の番号が変わっても同じCoreS3を選びます。

Ubuntuでは次のruntime packageを導入します。

```bash
sudo apt install gjs gir1.2-gtk-3.0 gir1.2-ayatanaappindicator3-0.1
```

音声serviceを新しい選択ファイル方式で再導入してから、アプレットを導入します。

```bash
npm run build
npm run install:user-service -- --port /dev/ttyACM0
npm run install:applet
```

アプレットは`stackchan-codex-voice-applet.service`として現在のuser sessionへ起動し、次回ログイン時にも起動します。
Waybarでは設定の`modules-left`、`modules-center`、`modules-right`のいずれかに`tray`が必要です。
GNOME ShellではStatusNotifierまたはAppIndicatorに対応するextensionが必要です。

サービスがONの状態で接続先を選ぶと、アプレットは選択を保存して音声serviceを再起動します。
サービスがOFFの状態で選んだ場合はOFFを維持し、次回ONにした時点で選択したCoreS3へ接続します。
選択したCoreS3が未接続でも、別のCoreS3へ自動接続しません。

同じ操作はCLIからも実行できます。

```bash
node dist/src/cli.js status
node dist/src/cli.js service stop
node dist/src/cli.js device list
node dist/src/cli.js device use USB_SERIAL_NUMBER
node dist/src/cli.js service start
```

「アプレットを終了」は表示プロセスだけを終了し、音声serviceのONとOFFを変更しません。
自動起動も停止する場合は次のunitを無効化します。

```bash
systemctl --user disable --now stackchan-codex-voice-applet.service
```

## Firmware MOD

USB音声対応のModdable hostをCoreS3へ書き込んだ後、Stack-chan firmwareリポジトリからCodex専用MODを導入します。

```bash
cd firmware
npm run mod:m5stackchan_cores3 -- \
  mods/examples/codex_voice/manifest.json \
  --port /dev/ttyACM0
```

現在のfirmware wrapperは、接続中のModdable hostから`xs`パーティションとfirmware versionを検査し、MODをesptoolで直接書き込んでverifyします。
このMODは既定の`onContextCreated`を置き換えます。
前方スワイプを開始、後方スワイプを停止へ専有するため、既定の撫で動作とボタン操作は動作しません。

以前に再現した30秒前後の切断は、sideband heartbeat不足ではなく、`werift` 0.24.1のICE consent freshness処理が原因でした。
ブリッジは依存パッチによって定期STUN要求を維持し、app-serverへheartbeatを送らずに実接続を90秒以上維持します。
調査結果とネイティブWebRTCへ移行する条件は[`docs/WEBRTC_TRANSPORT.md`](docs/WEBRTC_TRANSPORT.md)を参照してください。

## テスト

```bash
npm test
```

既存のUSB、音声、app-server契約テストに加え、Vitestで会話Tone、セッション状態遷移、再試行スーパーバイザー、WebRTC transport、ICE consent freshnessを検査します。
Vitestだけを実行する場合:

```bash
npm run test:vitest
```

再試行判定は、利用上限、認証不整合、JSON-RPC契約エラー、一時的なWebSocketおよびUSB切断を有限列挙します。
バックオフ状態機械は短時間失敗と30秒以上の安定接続からなる長さ5までの全操作列を検査します。
会話Toneは音程順序、PCM形式、振幅、長さ、開始前の再生完了、終了前のスピーカー解放、重複要求、開始中断を検査します。
ICEテストは、単発のSTUN応答欠落後も監視を続けること、4秒と6秒の両方の監視周期で最後の有効応答から30秒後に失効すること、有効応答で期限を更新すること、応答待ちを含めても要求開始間隔を4秒から6秒に保つこと、再送せず遅延応答を待つこと、ICE-liteの選択済み経路を指名し続けることを検査します。

## 安全性

- CoreS3のOKは一回限りの`accept`、NGは`decline`として返します。
- `acceptForSession`やpolicy amendmentへ自動変換しません。
- コマンド実行とファイル変更以外のserver requestは明示的なunsupported errorで拒否します。
- `stackchan.get_status`だけを固定dynamic toolとして公開し、USB接続と会話状態を読み取り専用で返します。
- workspace skillはツールの利用方針だけを定義し、任意コードをdynamic toolとして登録しません。
- 承認中にUSBが切断されても要求を解決せず、再接続または別CLIからの解決を待ちます。
- シグナル終了時と再試行不能エラー時は、未解決の承認を拒否してからdaemonとのWebSocket接続を閉じます。
- PCM、コマンド全文、ファイル差分本文をログへ保存しません。

## 音声形式

- CoreS3入力: PCM16LE mono、16kHz、20ms
- WebRTC入力: PCM16LE monoを48kHzへ逐次変換し、実音声または無音を20ms単位で連続してOpus/RTP化
- WebRTC出力: remote Opus/RTPを48kHz mono PCMへデコード
- 出力prebuffer: 240ms
- CoreS3出力: PCM16LE mono、24kHz、80ms frame、speaker credit制御

実機検証では、WebRTCマイク入力から生成された応答に`thread/realtime/outputAudio/delta`が通知されず、応答音声はremote RTPだけに届きました。
ブリッジはremote RTPを再生の正本とし、app-serverの`thread/realtime/transcript/done`を終端の補助信号として使います。
終端通知より遅れて届いたRTPは新しい応答として再生せず、現在の再生を切断するエラーにも変換しません。

USB wire contractは[`contracts/usb-cdc-v2`](../../contracts/usb-cdc-v2/README.md)を参照してください。

## 今後の計画

常駐サービス、頭上スワイプ、状態表示は実装済みです。
表情およびモーションのツール化は[`docs/ROADMAP.md`](docs/ROADMAP.md)の未実装項目にまとめています。
