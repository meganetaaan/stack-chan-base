# Stack-chan Codex Voice Bridge

CoreS3のUSBマイク、スピーカー、状態表示、承認UIを、ローカルで動作中のCodex app-server daemonへ接続するTypeScript製CLIです。

Codex SDKは使用しません。daemonのUnix socketへ標準WebSocketで接続し、app-server JSON-RPCのexperimentalな`thread/realtime/*` APIとapproval server requestを扱います。Realtime v3へのマイク入力とセッション確立にはWebRTCを使い、スピーカー出力にはapp-serverが順序付きで通知するPCMを使います。

## 必要なもの

- Node.js 22以上
- `codex-cli` 0.145.0相当のRealtime API
- ChatGPTへログイン済みのCodex app-server
- USB v2 contractとEVENT capabilityに対応したM5Stack CoreS3 firmware

WebSocket音声transportはAPIキー認証を要求しますが、このブリッジはWebRTC transportを使います。ChatGPTログインで接続でき、`OPENAI_API_KEY`は不要です。app-serverのWebRTC仕様は[Codex app-server README](https://github.com/openai/codex/blob/25af12f7e61572b0bc18ddb1008be543b91519b0/codex-rs/app-server/README.md#L898-L943)を参照してください。

## セットアップ

```bash
cd bridge/codex-stackchan-voice
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

新しいthreadを開始します。

```bash
node dist/src/cli.js \
  --cwd /absolute/path/to/project \
  --port /dev/ttyACM0
```

既存threadを再開します。

```bash
node dist/src/cli.js \
  --cwd /absolute/path/to/project \
  --thread THREAD_ID \
  --port /dev/ttyACM0
```

daemon socketも明示する場合:

```bash
node dist/src/cli.js \
  --port /dev/ttyACM0 \
  --socket /tmp/stackchan-codex.sock
```

`You have reached your usage limit.`が表示された場合、WebRTC接続自体ではなくChatGPT側のVoice利用枠に達しています。このエラーにはapp-serverからリセット時刻が付かないため、ブリッジは再接続ループへ入らず終了コード1で停止します。利用枠が回復してから手動で再実行してください。

`stream disconnected before completion`や`Connection reset without closing handshake`が表示された場合は、app-serverからOpenAIへ張られたsideband WebSocketが切断されています。
ブリッジは受信済み音声を再生してから、CoreS3とのUSB接続を維持したままRealtimeセッションだけを500msから30秒までの指数バックオフで再接続します。
USB自体が切断された場合に限り、別の指数バックオフでUSBを開き直します。
各接続が30秒以上安定した後は、対応する次の待機時間を500msへ戻します。
daemon側の記録は通常`~/.codex/app-server-daemon/app-server.stderr.log`で確認できます。

以前に再現した30秒前後の切断は、sideband heartbeat不足ではなく、`werift` 0.24.1のICE consent freshness処理が原因でした。
ブリッジは依存パッチによって定期STUN要求を維持し、app-serverへheartbeatを送らずに実接続を90秒以上維持します。
調査結果とネイティブWebRTCへ移行する条件は[`docs/WEBRTC_TRANSPORT.md`](docs/WEBRTC_TRANSPORT.md)を参照してください。

## テスト

```bash
npm test
```

既存のUSB、音声、app-server契約テストに加え、Vitestで再試行スーパーバイザー、WebRTC transport、ICE consent freshnessを検査します。
Vitestだけを実行する場合:

```bash
npm run test:vitest
```

再試行判定は、利用上限、認証不整合、JSON-RPC契約エラー、一時的なWebSocketおよびUSB切断を有限列挙します。
バックオフ状態機械は短時間失敗と30秒以上の安定接続からなる長さ5までの全操作列を検査します。
ICEテストは、単発のSTUN応答欠落後も監視を続けること、4秒と6秒の両方の監視周期で最後の有効応答から30秒後に失効すること、有効応答で期限を更新すること、応答待ちを含めても要求開始間隔を4秒から6秒に保つこと、再送せず遅延応答を待つこと、ICE-liteの選択済み経路を指名し続けることを検査します。

## 安全性

- CoreS3のOKは一回限りの`accept`、NGは`decline`として返します。
- `acceptForSession`やpolicy amendmentへ自動変換しません。
- コマンド実行とファイル変更以外のserver requestは明示的なunsupported errorで拒否します。
- 承認中にUSBが切断されても要求を解決せず、再接続または別CLIからの解決を待ちます。
- シグナル終了時と再試行不能エラー時は、未解決の承認を拒否してからdaemonとのWebSocket接続を閉じます。
- PCM、コマンド全文、ファイル差分本文をログへ保存しません。

## 音声形式

- CoreS3入力: PCM16LE mono、16kHz、20ms
- WebRTC入力: PCM16LE monoを48kHzへ逐次変換し、実音声または無音を20ms単位で連続してOpus/RTP化
- app-server出力: `thread/realtime/outputAudio/delta`の順序付きPCM16LE mono
- 出力prebuffer: 240ms
- CoreS3出力: PCM16LE mono、24kHz、80ms frame、speaker credit制御

WebRTCのremote Opus/RTPとapp-serverのPCM通知には同じ応答音声が含まれますが、ブリッジはRTPを再生には使いません。RTPとsideband上の終了通知にはtransportをまたぐ順序保証がなく、遅延したRTPを再生終了後の新しい音声と誤認するためです。app-serverのPCM通知と`thread/realtime/transcript/done`は同じ順序付き通知経路にあるため、こちらを再生契約とします。

USB wire contractはリポジトリ直下の`docs/SERIAL_NEXT_STEP.md`を参照してください。
