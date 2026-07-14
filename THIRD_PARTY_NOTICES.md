# Third-party components

このリポジトリ自身のコードは`LICENSE`のMIT Licenseです。以下は別ライセンスです。
実際に使用・配布する版のライセンスとモデルカードを必ず確認してください。

- LiteRT-LM 0.14.0（Apache License 2.0）
- Gemma 4 E2B IT model（Gemma Terms of Use）
- Gemma 4 E4B IT model（Gemma Terms of Use）
- RunAnywhere Kotlin SDK and ONNX backend
- ONNX Runtime
- sherpa-onnx v1.12.20（Apache License 2.0。Kotlin API定義の一部を変更して使用）
- Whisper Small ONNX model
- android-vad WebRTC 2.0.10
- Piper Plus Android AAR
- Piper Plusつくよみちゃん6言語FP16音声モデル（つくよみちゃんコーパス利用条件）
- OpenJTalk dictionary from the Piper Plus v1.13.0 release archive
- 利用者が選択した任意のPiper Plus日本語音声モデル
- AndroidX, Jetpack Compose, Kotlin coroutines

Gemmaの利用条件は、アプリ内の「Gemma利用条件」から確認できます。

このPoCにはPiper音声モデル、OpenJTalk辞書、LLM／STTモデル本体を同梱していません。
推奨Piper音声と辞書は、利用条件の確認後に各配布元から端末へ直接取得します。
ローカル開発用のPiper Plus AARは作業用ZIPへ含める場合がありますが、再配布時はPiper Plusと同梱物のライセンスを別途確認してください。
