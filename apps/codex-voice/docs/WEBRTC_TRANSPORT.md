# WebRTC transportの採用判断

## 現在の判断

実装言語をTypeScriptに限定しなければ、Pionやlibwebrtcを利用できるため選択肢は増えます。
しかし、今回の30秒前後の切断はTypeScript自体の制約ではなく、`werift` 0.24.1のICE consent freshness実装にある五つの不整合で説明できました。
五点を修正した接続は音声応答の受信後もapp-serverへのheartbeatなしで90秒維持できたため、現時点ではUSBとapp-serverの処理を含むTypeScript実装を維持します。

## 切断に至った不整合

| 不整合 | 観測事実 | 修正 |
| --- | --- | --- |
| 最初のSTUN timeoutで監視ループを抜ける | 失効判定へ到達できず、最初の欠落後に要求が止まった | 単発欠落では監視を止めない |
| 再送0回を応答待ち50msとして扱う | 初期ICEの応答時間は約150から300msで、定期要求だけが応答前に破棄された | 送信は1回のまま、応答を1秒待つ |
| 応答待ちの後から次の監視間隔を測る | 1秒の応答待ちを含むと要求開始間隔が最大7秒になった | 要求開始時刻を基準に次の4秒から6秒の期限を計算する |
| 6回失敗という回数で失効を判定する | 4秒周期では24秒、6秒周期では36秒となり、最後の有効応答から30秒という境界を満たさない | 応答監視とは独立した30秒期限を持ち、有効応答のたびに更新する |
| ICE-liteの選択済み経路を再指名しない | STUN応答は届いたが、対照実験では約30秒後にsidebandがリセットされた | controlling側からの定期要求へ`USE-CANDIDATE`を付ける |

[RFC 7675](https://www.rfc-editor.org/rfc/rfc7675.html#section-5.1)は、consent要求を4秒から6秒の間隔で送り、各要求を一度だけ送信し、最後の有効な応答から30秒でconsentを失効させるよう定めています。
同じRFCは、要求ごとの応答を推定RTTと遅延変動を考慮した時間だけ待つよう求めています。
50msで破棄する元実装は、実測した応答時間を下回っていました。

Chromiumの[BasicIceController](https://webrtc.googlesource.com/src/+/refs/heads/main/p2p/base/basic_ice_controller.cc)は、相手がICE-liteの場合、選択済みでwritableな経路へ`USE-CANDIDATE`を付けます。
この挙動に合わせると90秒試験を通過し、属性だけを外した対照実験では約30秒後にsidebandがリセットされました。
後者はOpenAI側の内部実装を直接確認した結果ではなく、通信ログと対照実験から得た互換条件です。

## heartbeatと無音RTP

Codex app-serverはsideband WebSocketを所有し、このブリッジはWebRTC peerを所有します。
調査した公開app-server APIには、副作用のないsideband heartbeat操作はありません。
今回のsideband resetはICE consentの不成立に続いて起きており、アプリケーション層の空メッセージでは解消しませんでした。

一方、WebRTCの送信trackは20msごとにOpus/RTPを送ります。
CoreS3のマイク入力がない時間とCoreS3が応答を再生している時間には、無音フレームを送ります。
これは双方向のaudio trackを連続させるための処理ですが、ICE consentの代替ではありません。

## 応答音声の経路

WebRTCマイクから発話した実機試験では、ユーザー文字起こしとassistant transcriptはsidebandへ通知されましたが、`thread/realtime/outputAudio/delta`は通知されませんでした。
同じ応答のOpus/RTPはremote audio trackへ届いていたため、ブリッジはremote RTPを48kHz mono PCMへデコードし、24kHzへ変換してCoreS3へ送ります。
sideband PCMを再生元にした旧実装はassistant transcriptまで進んでも無音になったため、再生経路から削除しました。
remote RTPとsideband上のassistant transcript完了にはtransportをまたぐ順序保証がないため、遅延RTPを新しい応答として再生したりセッションエラーへ変換したりしません。

## ネイティブ実装の評価

`@roamhq/wrtc`を使ったlibwebrtc試験は90秒の接続を維持しました。
しかし、Node.js 20と22の両方でプロセス終了時にSIGSEGVを再現したため、同じNode.jsプロセスへは採用していません。
上流にも[RTCPeerConnection解放時の同種報告](https://github.com/WonderInventions/node-webrtc/issues/35)があります。

ローカルのLinux版Codex Desktop 26.623.31921も調査しましたが、Realtime voice contextは無効なstubであり、移植できる`RTCPeerConnection`実装は含まれていませんでした。
この確認結果は手元のLinuxパッケージだけを対象としており、macOS版など未調査の配布物には一般化できません。

ネイティブ化が必要になった場合は、USBとapp-serverの処理をTypeScriptに残し、WebRTCだけをPion製sidecarへ分離します。
C++のlibwebrtcを直接組み込む案は、SDP、ICE、DTLS、SRTP、Opus、ビルド配布の保守範囲が広いため、Pionで要件を満たせない場合の次候補です。

## 依存パッチの保守

`werift`は0.24.1へ固定し、`npm ci`の`postinstall`でパッチを適用します。
パッチ処理はバージョンと変更対象のコードを照合し、想定外の版では停止します。
`werift`を更新するときは、上流に同等修正が入ったかを確認し、ICE回帰テストと90秒以上の実接続試験を再実行します。

## 既知の依存監査警告

現行lockfileに対する`npm audit --omit=dev`は、high 9件とcritical 1件を報告します。
主な経路は`@discordjs/opus`からインストール補助用`@discordjs/node-pre-gyp`を経由する`tar`などと、`werift`から`werift-ice`を経由する`ip`です。
監査が提示する自動修正は直接依存の互換性を損なうdowngradeを含むため、適用していません。
`tar`系はネイティブOpusのインストール時にだけ到達し、dock appの実行時にarchiveを処理しません。
`ip`はICEのローカルアドレス分類に使われますが、修正版が公開されておらず、`werift`の互換性を保ったまま置換できません。
この判断は脆弱性の解消ではなく、2026-07-26時点の期限付きwaiverであり、Opus実装またはWebRTC実装の更新時に再評価します。

リリース検査は次を実行します。

```bash
npm run audit:release
```

既定では既知の警告を含めて失敗します。
リリース責任者が上記の到達可能性と配布対象を確認して例外を承認した場合だけ、`STACKCHAN_DEPENDENCY_WAIVER=codex-voice-2026-07-26`を設定して再実行します。
検査スクリプトは許可したpackage名とadvisory IDを固定しており、新しい警告またはadvisoryが加わった場合はwaiverを指定しても失敗します。
