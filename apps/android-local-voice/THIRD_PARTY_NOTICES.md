# Third-party components

このリポジトリ自身のコードは`LICENSE`のMIT Licenseです。以下は別ライセンスです。
実際に使用・配布する版のライセンスとモデルカードを必ず確認してください。

- LiteRT-LM 0.14.0（Apache License 2.0）
- Gemma 4 E2B IT model（Gemma Terms of Use）
- Gemma 4 E4B IT model（Gemma Terms of Use）
- Agents A1 4B Q4_K_M GGUF model（Apache License 2.0）
- RunAnywhere Kotlin SDK 0.20.10、ONNX backend、llama.cpp backend（Apache License 2.0）
- ONNX Runtime（MIT License。[LICENSE](https://github.com/microsoft/onnxruntime/blob/main/LICENSE)および[ThirdPartyNotices.txt](https://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt)）
- sherpa-onnx v1.12.20（Apache License 2.0。Kotlin API定義の一部を変更して使用）
- Whisper Small ONNX model（コードとモデルweightはMIT License。[OpenAI Whisper LICENSE](https://github.com/openai/whisper/blob/main/LICENSE)）
- android-vad WebRTC 2.0.10（MIT License。[LICENSE](https://github.com/gkonovalov/android-vad/blob/main/LICENSE.md)）
- usb-serial-for-android 3.10.0（MIT License）
- Piper Plus Android AAR（MIT License。[Piper Plus LICENSE](https://github.com/ayutaz/piper-plus/blob/v1.13.0/LICENSE.md)。AARへ取り込まれる第三者コンポーネントのnoticeも配布前に確認する）
- Piper Plusつくよみちゃん6言語FP16音声モデル（つくよみちゃんコーパス利用条件）
- OpenJTalk dictionary from the Piper Plus v1.13.0 release archive（辞書アーカイブに同梱されたライセンスおよび[Piper Plus v1.13.0 release](https://github.com/ayutaz/piper-plus/releases/tag/v1.13.0)のnoticeに従う）
- 利用者が選択した任意のPiper Plus日本語音声モデル（モデルごとに条件が異なるため、配布元のモデルカードとデータセット利用条件を個別確認する。アプリは任意モデルを同梱しない）
- AndroidX / Jetpack Compose（Apache License 2.0。[Android Open Source Project license information](https://source.android.com/docs/setup/about/licenses)）
- Kotlin coroutines（Apache License 2.0。[kotlinx.coroutines LICENSE](https://github.com/Kotlin/kotlinx.coroutines/blob/master/LICENSE.txt)）
- Model Context Protocol Kotlin SDK 0.14.0（Apache License 2.0）
- Ktor 3.4.3（Apache License 2.0）
- kotlinx.serialization 1.11.0（Apache License 2.0）

各LLMのモデルカードと利用条件は、アプリ内のモデル設定から確認できます。

このPoCにはPiper音声モデル、OpenJTalk辞書、LLM／STTモデル本体を同梱していません。
推奨Piper音声と辞書は、利用条件の確認後に各配布元から端末へ直接取得します。
ローカル開発用のPiper Plus AARは作業用ZIPへ含める場合がありますが、再配布時はPiper Plusと同梱物のライセンスを別途確認してください。
