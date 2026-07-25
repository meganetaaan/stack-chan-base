# 会話セッション状態機械の検査記録

更新日: 2026-07-25

## 対象と問い

対象は、USBの`conversation.start`と`conversation.stop`をRealtimeAudioBridgeの開始、停止、再試行へ変換する状態機械である。

検査した性質は次の三つである。

- 同じ`requestId`を再受信しても、論理操作を二重に適用しない。
- stopまたはblockedの後に、古い音声状態が会話を復活させない。
- 一時的な状態表示の送信失敗後も、同じ要求の再送で処理結果を返せる。

異なる論理操作は異なる`requestId`を持つと仮定した。
Firmwareは起動ごとの乱数tokenと単調増加番号からIDを生成する。

## 実装から抽出した仕様

宣言された仕様は、standbyでRealtimeを開始しないこと、startとstopをtoggleにしないこと、利用上限をblockedへラッチすること、USB切断でdesired stateを解除することである。
これらは会話セッションの単体テストとUSB contractに記載されている。

暗黙の挙動として、処理結果cacheは`requestId`だけをkeyにし、直近64件を保持する。
app-server切断ではcontrollerを破棄しないためdesired stateを維持するが、USB切断ではcontrollerを破棄する。

## 検査方法

有限で決定的な操作列には、実装を直接呼び出す全列挙を使用した。
alphabetをstart、stop、同一要求のrepeat、blockedとし、長さ0から4までの341列を検査した。

各操作後に、次の不変条件を確認した。

- **DesiredMatchesLastEffectiveOperation**：最後の新規操作がstartならdesiredはtrue、stopまたはblockedならfalseである。
- **StateMatchesDesired**：app-serverを接続しない範囲では、desiredがtrueならconnecting、stop後はstandby、blocked後はblockedである。
- **DuplicateIsIdempotent**：repeatは以前の結果を返し、desiredとstateを変更しない。

negative controlはrepeatをtoggleとして適用する故障版である。
列挙器は`start, repeat`を最小反例として検出した。

実行コマンドは次のとおりである。

```bash
npm run test:vitest -- test/conversation-session.spec.ts
```

## 発見した反例と修正

初期実装では、状態表示のUSB writeが一度失敗すると、そのreject済みPromiseを結果cacheへ残していた。
同じ`requestId`を再送しても同じrejectを返すため、Firmwareは結果を受信できなかった。

さらに、送信成功前に最後のwire stateを更新していたため、再送時に状態表示を送信済みと誤認した。

結果cacheは失敗時に該当entryを削除し、最後のwire stateはUSB write成功後だけ更新するよう修正した。
この反例は`reapplies a request after a transient status write failure`で回帰検査する。

## 検査結果と限界

341列の範囲では、三つの不変条件に反例はなかった。
故障版では最小反例を検出したため、列挙器は重複要求によるtoggleを観測できる。

この結果は長さ4までのUSB操作列に対する検査であり、無界な実行の数学的証明ではない。
app-server切断、利用上限、古い音声callback、同時Realtime数は、同じテストファイルの個別非同期テストで補っている。
USB driver、WebRTCライブラリ、実時間の音声品質はこの有限モデルの対象外である。
