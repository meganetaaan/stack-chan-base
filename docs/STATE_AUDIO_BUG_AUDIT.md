# 状態管理と音声処理の不具合監査

更新日：2026年7月22日

対象はAndroidアプリの会話制御、USB接続、マイク入力、TTS出力、VAD、LLMとPiperの取消し、およびCoreS3 FirmwareのUSB音声セッションである。

調査は[実装コードから仕様を吸い出してZ3またはTLA+でバグを払い出す実践プレイブック](https://gist.github.com/mizchi/db7817e6fc077d567c41cd9d41bb1c53)に従う。
今回の状態空間は有限なので、純粋な決定関数とイベント列の全列挙を優先し、実機traceを同じ不変条件へ再生する。

## 監査開始点

監査前の実装は、次のコミットと注釈付きタグで固定した。

| 対象 | コミット | タグ |
|---|---|---|
| Android | `1f22bc9` | `checkpoint/usb-audio-before-state-audit-20260721` |
| Firmware | `0131e826` | `checkpoint/usb-audio-before-state-audit-20260721` |

## 実機で得た反例

AndroidとCoreS3を直結した試験では、Piperが9.066秒分のPCMを生成した後、CoreS3が再生開始から3.927秒で`ERROR`を2回返した。
Androidが送信できたPCMは184,320 bytesであり、24 kHz、16-bit、monoでは3.84秒に相当する。
この時点で`SPEAKER_END`は送信されていない。

AndroidはFirmwareの`ERROR`を受信していたが、会話処理へ直ちに失敗を伝えなかった。
利用者が停止操作を行った32.944秒時点で、初めて`SPEAKER_ABORT`を送った。

USB接続時のAndroidログには、同じtask内に`MainActivity`が2個存在した記録がある。
各ActivityはActivity単位の`MainViewModel`を作り、各ViewModelが同じUSB CDC interfaceを独立して開く。
二つのwriterは共通mutexを持たないため、CDC frameを相互に壊せる。

PCから同じCoreS3へ4個の字幕を挟みながら12秒分の無音PCMを送った試験では、150 frame、576,000 bytesを送信し、`SPEAKER_DONE`まで到達した。
この結果は、複数字幕または12秒のPCM長だけではFirmwareの早期終了が起きないことを示す。

Activityとstream IDの修正後にAndroidとCoreS3を直結した試験では、4.582秒分の応答に対し、再生開始から1.559秒で`code=3, stream=2`を受信した。
Androidはこの時点までに22 frame、84,480 bytesのPCMを連番で送信し、Firmwareから85,248 bytesのcreditを受信していた。
字幕は3件であり、`SPEAKER_END`は未送信だった。
旧Firmwareのcode 3はsequence欠落、PCM queue超過、字幕queue超過を区別しないが、字幕件数から原因候補をUSB受信時のsequence欠落またはPCM queue超過へ限定できる。

## 名前付き不変条件

- **SingleUsbOwner**：一つのAndroid process内では、一つのUSB deviceを一つのconnection ownerだけが開く。
- **CurrentConnectionOnly**：古い接続のcallback、timeout、受信byte列は、新しい接続の状態を変更しない。
- **CurrentStreamOnly**：古いマイクまたはスピーカーsessionのframeは、現在のsessionのcredit、終了、取消し、PCMへ影響しない。
- **LosslessAcceptedPcm**：sequence欠落を補う場合を除き、受理したマイクPCMと送信待ちTTS PCMを通知なしに捨てない。
- **OrderedLifecycle**：旧sessionの`STOP`または`ABORT`は、新sessionの`START`より前に確定する。
- **PromptTerminalFailure**：Firmwareの再生エラーは、次のPCM生成または利用者操作を待たず、会話sessionを失敗させる。
- **NoPcmAfterAbort**：`SPEAKER_ABORT`の後に、同じsessionのPCMを送らない。
- **NegotiatedFrameSize**：送信payloadは、HELLOで合意した最大payload長を超えない。
- **FullResponseOrAbort**：LLM生成またはPiper合成が失敗した応答を、正常な`SPEAKER_END`で確定しない。
- **ExclusiveModelMutation**：認識、生成、合成中に、使用中のモデルを閉じる操作を開始しない。
- **AmbientNoiseIsNotSpeech**：校正済みの定常雑音は、雑音床を少し上回っただけで発話開始にならない。
- **CorrelatedTerminalEvent**：`CREDIT`、`DONE`、`ERROR`、Worker応答は、発生元sessionだけへ適用する。
- **BoundedUsbRxBurst**：native USB受信ringの未読領域と、新たに許可したPCMのwire bytesを合計しても、ring容量を超えない。

## TODO台帳

状態は`RED未作成`、`RED確認`、`GREEN確認`の三段階で管理する。
`GREEN確認`へ進めるには、回帰テストが監査前実装で失敗し、修正後実装で成功した記録を残す。

| ID | 状態 | 不具合と最小反例 | REDテスト | GREEN条件 |
|---|---|---|---|---|
| A-01 | GREEN確認 | USB attachが既存Activityの上へ新しいActivityを作り、二つのUSB ownerが同居する。 | Manifestのlaunch policyとowner数を検査する。 | USB attachを何回受けてもActivityとUSB ownerが一つである。 |
| A-02 | GREEN確認 | Sink内部のsenderが独立した`SupervisorJob`配下にあり、Firmware `ERROR`が会話Jobを直ちに失敗させない。 | `ERROR`後に追加writeやfinishを行わなくても、親Jobが短時間で失敗することを検査する。 | 実機traceのようなcredit待ちでも、エラー受信直後に会話Jobが終了する。 |
| A-03 | GREEN確認 | AndroidがFirmwareの4-byte error codeとstreamを捨て、すべて同じ例外へ畳む。 | error codeとstreamの保持を検査する。 | traceとUI errorがFirmware codeおよび対象streamを示す。 |
| A-04 | GREEN確認 | マイクflow終了時の`MIC_STOP`が非同期であり、`START(old), START(new), STOP(old)`の順序を許す。 | `MIC_STOPPED`前に次の`MIC_START`を送らないことを検査する。 | stop確定後だけ次sessionを開始する。 |
| A-05 | GREEN確認 | `MIC_STARTED`前の遅延PCMを新しい録音へ入れる。 | start応答前のPCMを流してもcollectorへ届かないことを検査する。 | 現sessionのstart応答とstream IDが一致したPCMだけを受理する。 |
| A-06 | GREEN確認 | マイクの`trySend`結果を無視し、channel満杯時にPCMを通知なしで捨てる。 | consumerを停止してbuffer上限を越えたとき、明示的に失敗することを検査する。 | PCMをbackpressureするか、overflowをsession errorとして通知する。 |
| A-07 | GREEN確認 | 古い`SerialInputOutputManager`のerrorまたはHELLO応答が新接続を閉じたりREADYへ変えたりできる。 | 接続世代を全列挙し、旧世代eventが新世代を変えないことを検査する。 | callbackとtimeoutを接続世代で照合する。 |
| A-08 | GREEN確認 | portをfieldへ設定した後にHELLO送信が失敗すると、閉じたportがfieldに残り、retryが早期returnする。 | 接続途中の送信失敗後に再接続できることを検査する。 | 失敗経路が現在世代の全resourceを一度だけ解放する。 |
| A-09 | GREEN確認 | SinkはHELLOの`maxPayload`を参照せず、常に3,840-byte frameを送る。 | `maxPayload=640`のpeerへ送るframe長を検査する。 | 合意値以下の偶数payloadへ分割する。 |
| A-10 | GREEN確認 | `abort()`がsender停止前に`SPEAKER_ABORT`を送り、競合するとabort後のPCM送信を許す。 | writeをblockした状態でabortし、wire順序を検査する。 | senderを停止してからabortを送り、以後のPCMを0件にする。 |
| A-11 | GREEN確認 | LLM callbackの`trySend`がbuffer満杯時にtokenを捨て、応答文とTTSを欠落させる。 | 64件を超える同期callbackを流し、全deltaを保持することを検査する。 | callback列と生成文字列が一致する。 |
| A-12 | GREEN確認 | LLM例外時にsentence channelを正常closeし、部分応答を正常な`SPEAKER_END`へ進める順序がある。 | 一文生成後にLLMを失敗させ、sinkのterminal controlを検査する。 | 生成失敗は必ず`SPEAKER_ABORT`になる。 |
| A-13 | GREEN確認 | `stop()`が会話Jobをcancelする前にsinkとmodelの停止を待ち、待機中に次のPiper合成を始められる。 | stop中に次文を供給し、追加合成が始まらないことを検査する。 | Jobを先にcancelし、その後resourceを停止してjoinする。 |
| A-14 | GREEN確認 | モデル準備、手動Piper取込、Piper loadを会話中に直接呼べる。 | 各操作を非IDLE状態で呼び、model closeや書換えが起きないことを検査する。 | ViewModel境界でも会話中のmodel mutationを拒否する。 |
| A-15 | GREEN確認 | 雑音床校正が最小RMSを採るため、定常雑音を過小評価する。 | 高めの一定雑音で校正し、近いRMSを非発話と判定する。 | 校正値が定常雑音へ収束し、閾値が雑音を上回る。 |
| F-01 | GREEN確認 | Firmwareのspeaker controlとPCMにsession識別子がなく、`START(1), START(2), ABORT(1)`がsession 2を止める。 | 二sessionのevent列を全列挙する。 | 異なるstream IDのeventがcurrent sessionを変更しない。 |
| F-02 | GREEN確認 | `SPEAKER_END`と`SPEAKER_ABORT`がsample rate、payload、再生終了状態を検証しない。 | rate不一致、payloadあり、END後TEXTの境界を列挙する。 | 不正controlはERRORになり、現session状態を壊さない。 |
| F-03 | GREEN確認 | Workerとmain VM間の`audio-drained`、`audio-failed`にsession IDがなく、遅延応答を新出力へ適用できる。 | 旧session応答を新session開始後に配送する。 | 旧streamのWorker応答を無視する。 |
| F-04 | GREEN確認 | Firmwareの送信queueに旧sessionのcreditとterminal controlが残り、新sessionへ配送され得る。 | stopとrestartの間へ送信遅延を挟む。 | controlへstream IDを付け、旧eventを受信側と送信側の双方で除外する。 |
| F-05 | GREEN確認 | speaker busy中の新しい`SPEAKER_START`が旧sessionを通知なしで破棄する。 | active中に二つ目のstartを送る。 | 同一streamの冪等retry以外はbusy errorになり、旧sessionを維持する。 |
| F-06 | GREEN確認 | 16 KiBのnative USB受信ringに対し12 KiBのcreditを許可し、未読データが残る場合の余裕が小さい。code 3が三原因を兼ねるため再発時に切り分けられない。 | ring残量とPCM wire burstの合計を検査し、sequence、PCM queue、字幕queueのerror codeを個別に検査する。 | 32 KiB ring、16 KiB read、8 KiB creditで不変条件を満たし、三原因をcode 6、7、8で識別する。 |
| F-07 | GREEN確認 | `MIC_STOPPED`が一度欠落すると、Firmwareは停止済みstreamを忘れて再送`MIC_STOP`を無視し、hostが5秒後にsession全体を再接続する。 | 最初のACKを欠落させ、hostが同じstreamの`MIC_STOP`を再送することと、Firmwareが再送へ冪等に応答することを検査する。 | hostは500ミリ秒間隔で停止要求を再送する。Firmwareは直前の停止streamをHELLOまで記憶してACKを再送し、旧streamの停止要求を新sessionへ適用しない。 |

## プロトコル互換性

監査修正ではUSB音声プロトコルをversion 2へ上げ、20 bytesのheader内で旧`reserved`領域を16-bitの`streamId`へ変更した。
AndroidとFirmwareはcapability bit 9の`STREAM_ID`を必須とし、version 1との後方互換性は持たない。
双方を同時に更新する前提で、旧Androidまたは旧Firmwareとの組合せはhandshakeで拒否する。

## REDからGREENへの検証記録

AndroidではActivityの単一性、接続世代、マイク順序とoverflow、スピーカーerror伝播とabort順序、最大payload、LLM callback欠落、部分応答失敗、停止順序、モデル変更排他、VAD雑音床を個別の回帰テストへ固定した。
Firmwareではspeaker session、Worker応答、送信queue、wire codecを純粋関数として検査した。
状態照合を除いたbroken variantでは有限列挙が反例を検出し、修正版では同じ反例が成立しないことを確認した。
`MIC_STOPPED`欠落の実機反例に対しては、host側テストで最初のACKだけを捨て、同一streamの再送で停止が確定することをRED-GREENで確認した。
Firmware側では停止済みstreamへの重複停止、強制停止後の再送、HELLOによる履歴破棄を検査した。
さらに三つのstream IDから異なる旧・現IDを選ぶ6通りを全列挙し、旧streamの停止要求が現sessionを変更しないことを確認した。

## 最終検証記録

Firmwareの修正は、2026年7月22日時点の`origin/develop`、コミット`4ae98b20`の上へリベースした。
Androidでは`test`、`lint`、`assembleDebug`が成功し、接続中のMotorola端末へのAPK上書きに成功した。
同じ端末へ`MainActivity`の起動要求を2回送る試験では、2回目が既存instanceへ配送され、task内のinstanceは1個だった。
Firmwareではunit test、architecture test、6 targetのmanifest検査が成功した。
CoreS3 release buildは成功し、`xs_esp32.bin`は`0x5bfbb0` bytes、最小app partitionの空きは63%だった。

許可対象MAC`44:1B:F6:E2:82:B0`のCoreS3を全消去してからFirmwareを書き込み、USB protocol version 2のhandshakeが成功した。
音量0の診断Firmwareへ24 kHz、16-bit、monoのPCMを30秒送った結果、送信量、Firmware受信量、AudioOut書込量はすべて1,440,000 bytesで一致した。
この試験は`SPEAKER_DONE`まで到達し、starvationは0回だった。
診断CSVは`firmware/dist/usb-audio-diagnostics/v2-burst-30s-20260722.csv`へ保存し、SHA-256は`165d4d0ea652052ca625a5b0323a6570e675eeedb946fc748c5bd392aa2b2539`である。
USB受信ring、read量、credit上限の修正後には、同じ形式のPCMをburst modeで60秒送った。
送信量、Firmware受信量、AudioOut書込量はすべて2,880,000 bytesで一致し、`SPEAKER_DONE`まで到達してstarvationは0回だった。
最大受信間隔は329 ms、最大書込可能量通知間隔は196 msだった。
診断CSVは`firmware/dist/usb-audio-diagnostics/v2-rx-headroom-60s-20260722.csv`へ保存し、SHA-256は`57da4aad92d27c24c16952b4d2eb2030665861195148b23f7be4f9d194a3c4c2`である。
試験後は音量0.25の通常Firmwareへ戻し、書込hashとversion 2 handshakeを再確認した。
通常Firmwareは最大payload 4,096 bytes、capability `0x0000037f`を返している。

今回更新したAndroid APKについても`test`、`lint`、`assembleDebug`は成功した。
ただし、PCからAndroid端末が認識されなくなったため、このAPKの上書きとUSB受信余裕修正後の直結再試験は実施していない。
Android端末をPCへ接続し直してAPKを上書きした後、同じ応答またはそれ以上の長さを使う直結再試験が必要である。

## 検査の自己確認

状態遷移の全列挙テストには、stream照合を意図的に外したbroken variantを含める。
broken variantで反例が出ない検査は、回帰ガードとして採用しない。

実機traceは個人音声を含むWAVのままリポジトリへ保存しない。
テストfixtureには時刻、byte数、control列だけを匿名化して残す。
