# Codex音声ブリッジの実装状況

更新日: 2026-07-25

状態: workspace設定、状態取得ツール、会話の常駐運用、開始終了Tone、MIC停止再送を実装済み、30分安定性評価と表情ツールは未実施

## 実装した利用方法

ブリッジはsystemd user serviceとして常駐し、起動直後は**standby**で待機する。
standbyではRealtime WebRTCセッションとCoreS3マイクを開始しない。

Codex専用MODは、頭上タッチセンサの前方スワイプを会話開始、後方スワイプを会話停止として扱う。
単純なタッチでは会話状態を変更しない。
このMODは既定の`onContextCreated`を置き換えるため、既定の撫で動作とボタン操作は同時に動作しない。

前方スワイプでは660 Hzから990 Hzへ上がる開始音を鳴らしてから、Realtimeとマイクを開始する。
後方スワイプではRealtimeを停止し、応答音声がスピーカーを解放してから990 Hzから660 Hzへ下がる終了音を鳴らす。
Toneはブリッジが24 kHzのPCMとして生成し、既存のUSBスピーカー経路へ直列化する。
MOD側のTone APIは使わず、USB音声と別のAudioOutが同時に物理スピーカーを所有する競合を避ける。

一つのサービスプロセス内では同じCodex threadを再利用する。
サービスを再起動すると新しいthreadを開始し、thread IDを設定やCLIから注入しない。

会話設定はアクティブworkspaceの`.stackchan/session.toml`と
`.stackchan/realtime-prompt.md`から読み込む。
workspaceルートの`AGENTS.md`と`.agents/skills`はCodex自身に発見させる。
`--cwd`、`--voice`、`--thread`による一時上書きは行わない。

## 会話状態

ブリッジは、ユーザーが会話を希望しているかを表すdesired stateと、実際のRealtime状態を分けて管理する。
これとは独立して、Codex app-serverのthread statusを`idle`または`running`へ正規化し、バックグラウンドtask状態として表示する。

| 内部状態 | Realtime | CoreS3マイク | 画面 |
| --- | --- | --- | --- |
| `standby` | 停止 | 停止 | なし |
| `connecting` | 開始前または接続中 | 停止 | 琥珀色の回転表示 |
| `listening` | 接続済み | 動作中 | 通常マイク |
| `recognizing` | 接続済み | 動作中 | 白色の回転表示 |
| `speaking` | 接続済み | 停止 | ミュートマイク |
| `blocked` | 停止 | 停止 | 赤色のエラー表示 |

`listening`への遷移は、WebRTC開始だけでは確定しない。
CoreS3が`MIC_STARTED`を返した後に限り、聞き取り中として表示する。

最初の可聴出力を再生する直前に`speaking`へ遷移する。
再生後にマイクを再開し、CoreS3が応答した時点で`listening`へ戻る。

一時的なRealtime切断ではdesired stateを維持し、500ミリ秒から30秒の指数バックオフでRealtimeだけを再接続する。
app-server切断ではUSBとdesired stateを維持し、app-serverだけを再接続する。
USB切断ではdesired stateを解除し、再接続後もstandbyから始める。

利用上限と認証不整合は`blocked`へ遷移させ、自動再試行しない。
サービスプロセスは終了せず、次の前方スワイプを明示的な再試行として扱う。

## USB application event

Firmwareは前方スワイプで`conversation.start`、後方スワイプで`conversation.stop`を送る。
開始と停止はtoggleではないため、再送で意味が反転しない。

Firmwareは結果を受信するまで、同じ`requestId`を2秒ごとに再送し、10秒で停止する。
ブリッジは直近64件の結果を保持し、同じ要求を二重に実行しない。

状態表示にはcapability bit 11の`STATUS_EXTENDED`を使用する。
未対応Firmwareでは`listening`、`connecting`、`error`を`IDLE`へ縮退させ、音声経路は継続する。

Codex threadの`active`は`task.status` application eventの`running`として通知する。
thread openの応答と`thread/status/changed`通知を同じ状態源として扱い、通知を先に購読してopen直後の競合を取りこぼさない。
task状態は会話用`STATUS`と独立しており、USB切断時はFirmware側で`idle`へ戻す。

wire形式は[`contracts/usb-cdc-v2`](../../../contracts/usb-cdc-v2/README.md)に定義する。

## 常駐サービス

CLIはバックグラウンドへforkせず、foregroundのままsystemdに監視させる。
インストーラは指定した`/dev/ttyACM0`からUSB serial numberを取得し、unitの`--device-id`へ固定する。
unitへcwdやvoiceを埋め込まず、ユーザー領域で選択されたアクティブworkspaceを起動時に読む。
同型のCoreS3が複数あっても、指定IDが見つからない場合は別の機体へフォールバックしない。

unitは`Restart=on-failure`、`RestartSec=2`、`TimeoutStopSec=15`を設定する。
既存のCodex Desktop管理app-serverへ接続し、app-server自体のsystemd unitは作成しない。

## 検証

dock app側はNode testとVitestでUSB framing、event parser、状態遷移、再試行、WebRTC、systemd unit生成を検査する。
start、stop、重複要求、blockedの長さ4までの全341操作列を列挙し、desired stateと表示状態の不変条件を確認する。
開始終了Toneは音程順序とPCM境界に加え、開始音がRealtimeより先に終わること、終了音がRealtimeのスピーカー解放後に一度だけ鳴ること、後方スワイプが未完了の開始音を中断することを検査する。
生成したunitは文字列比較だけでなく、実行環境の`systemd-analyze verify`にも通す。

Firmware側はNode testでevent再送、10秒timeout、遅延result、状態表示の対応を検査する。
CoreS3向けrelease firmwareの実ビルドでも、TypeScript、Piu resource、ESP-IDF linkを確認する。

実機では、前方スワイプからの聞き取り、応答再生、後方スワイプ停止、USB再接続、app-server再接続を確認する。
長時間の安定性は30分のsoak testで評価する。

### 2026-07-25の実機結果

`/dev/ttyACM0`だけを明示し、`/dev/ttyACM1`には接続しなかった。
最新developを統合したUSB音声対応のModdable hostをrelease buildして書き込み、Codex専用MODは実機の`xs`パーティションを検出するesptool経路で書き込みとdigest検証を行った。

手動ブリッジでは、standbyから前方スワイプでRealtimeを開始し、複数回の応答音声を切断なく再生した。
後方スワイプでRealtimeを終了し、standbyへ戻ることを利用者と確認した。

systemd user serviceはUSB serial numberへ固定して導入し、USB、app-server、Codex threadへ接続した状態で`active`を維持している。
初回の実機導入では`WorkingDirectory`を引用符で囲んだunitがsystemdに拒否され、インストーラが成功表示する反例を検出した。
`WorkingDirectory`専用escapeと起動後の`is-active`検査を追加し、実unitの起動とparser testで回帰を防いだ。

常駐動作中、再生後の`MIC_STOPPED`が一度欠落すると5秒でtimeoutし、Realtimeを再接続する反例を検出した。
dock appは同一streamの`MIC_STOP`を500ミリ秒ごとに再送し、Firmwareは直前に停止したstreamをHELLOまで記憶して`MIC_STOPPED`を冪等に再送するよう修正した。
旧streamの遅延停止が新しいマイクを止めないことは、stream IDの有限全列挙でも検査した。

修正後の実機では、同じsystemdプロセスで約79秒間に6回の応答を連続再生した。
各応答前後のマイク停止と再開を通過し、`MIC_STOPPED` timeout、Realtime再接続、systemd再起動はいずれも発生しなかった。

開始終了Toneを含むbuildへサービスを更新した後、約6分間に17回の応答再生を通過した。
この間、USB音声競合、Realtime再接続、音声ブリッジエラー、systemd再起動は記録されなかった。
開始音と終了音の音程方向は自動テストで検査済みだが、実機での聴感確認は未実施である。

30分のsoak test、USB物理抜線後の再接続、app-server実プロセス再起動は未実施である。

## ツール

読み取り専用の`stackchan.get_status`をapp-server dynamic toolとして固定登録し、
USB接続、会話状態、desired state、task stateを返す。
workspaceローカルの`.agents/skills/stackchan/SKILL.md`は利用方針だけを保持し、
任意のツール定義や実行コードは読み込まない。

### 未実装の表情ツール

表情変更と安全なモーションのCodex tool化は、この実装範囲に含めていない。
次の段階では、app-serverのdynamic toolまたはRealtime data channelのfunction toolを使い、`robot.action.request`へ正規化する。

最初の操作は`set_emotion`に絞る。
続いて、生の角度やトルク値を公開しない`play_motion`を追加する。
USB切断、timeout、重複request ID、未知の引数を両端で検証してから実機へ導入する。
