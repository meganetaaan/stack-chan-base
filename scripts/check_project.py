#!/usr/bin/env python3
from pathlib import Path
import hashlib
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

root = Path(__file__).resolve().parents[1]
required = [
    "settings.gradle.kts",
    "gradle/libs.versions.toml",
    "app/build.gradle.kts",
    "app/src/main/AndroidManifest.xml",
    "app/src/main/java/jp/stackchan/localvoicepoc/MainActivity.kt",
    "app/src/main/java/jp/stackchan/localvoicepoc/MainViewModel.kt",
    "app/src/main/java/jp/stackchan/localvoicepoc/conversation/ConversationEngine.kt",
    "app/src/main/java/jp/stackchan/localvoicepoc/conversation/EndpointDetector.kt",
    "app/src/main/java/jp/stackchan/localvoicepoc/conversation/TranscriptionSanitizer.kt",
    "app/src/main/java/jp/stackchan/localvoicepoc/model/GemmaModelManifest.kt",
    "app/src/main/java/jp/stackchan/localvoicepoc/model/GemmaModelPreferences.kt",
    "app/src/main/java/jp/stackchan/localvoicepoc/model/GemmaModelStore.kt",
    "app/src/main/java/jp/stackchan/localvoicepoc/model/LegacyModelCleaner.kt",
    "app/src/main/java/jp/stackchan/localvoicepoc/model/LiteRtGemmaLanguageModel.kt",
    "app/src/main/java/jp/stackchan/localvoicepoc/model/LocalLanguageModel.kt",
    "app/src/main/java/jp/stackchan/localvoicepoc/model/ModelCatalog.kt",
    "app/src/main/java/jp/stackchan/localvoicepoc/model/ModelSetupManager.kt",
    "app/src/main/java/jp/stackchan/localvoicepoc/model/RunAnywhereSpeechModelManager.kt",
    "app/src/main/java/jp/stackchan/localvoicepoc/piper/PiperAssetDownloader.kt",
    "app/src/main/java/jp/stackchan/localvoicepoc/piper/PiperDictionaryExtractor.kt",
    "app/src/main/java/jp/stackchan/localvoicepoc/piper/PiperAssetLinks.kt",
    "app/src/main/java/jp/stackchan/localvoicepoc/piper/PiperPlusReflectionSynthesizer.kt",
    "app/src/main/java/jp/stackchan/localvoicepoc/serial/StackChanFrame.kt",
    "app/src/main/java/jp/stackchan/localvoicepoc/speech/LocalSpeechRecognizer.kt",
    "app/src/main/java/jp/stackchan/localvoicepoc/speech/SherpaWhisperRecognizer.kt",
    "app/src/main/java/com/k2fsa/sherpa/onnx/SherpaOfflineApi.kt",
    "README.md",
    "VALIDATION.md",
    "THIRD_PARTY_NOTICES.md",
    "gradle/wrapper/gradle-wrapper.jar",
    "scripts/bootstrap-dev.sh",
    "scripts/dev.sh",
    "scripts/install_piper_aar.sh",
    "scripts/isolate_piper_onnx.py",
]
missing = [path for path in required if not (root / path).is_file()]
if missing:
    print("Missing required files:")
    for path in missing:
        print(f"  - {path}")
    sys.exit(1)

manifest_path = root / "app/src/main/AndroidManifest.xml"
manifest = manifest_path.read_text(encoding="utf-8")
ET.parse(manifest_path)
assert "android.permission.RECORD_AUDIO" in manifest
assert "StackChanApplication" in manifest
assert "libOpenCL.so" in manifest
assert "libvndksupport.so" in manifest

app_gradle = (root / "app/build.gradle.kts").read_text(encoding="utf-8")
versions = (root / "gradle/libs.versions.toml").read_text(encoding="utf-8")
assert "runanywhere" in app_gradle.lower()
assert "litert" in app_gradle.lower()
assert "piper-plus-release.aar" in app_gradle
assert re.search(r'runanywhere\s*=\s*"0\.20\.6"', versions)
assert re.search(r'litertLm\s*=\s*"0\.14\.0"', versions)
assert re.search(r'webrtcVad\s*=\s*"2\.0\.10"', versions)
assert 'abiFilters += "arm64-v8a"' in app_gradle
assert "runanywhere.llamacpp" not in app_gradle

catalog = (root / "app/src/main/java/jp/stackchan/localvoicepoc/model/ModelCatalog.kt").read_text(
    encoding="utf-8"
)
for expected in [
    "small-encoder.int8.onnx",
    "small-decoder.int8.onnx",
    "small-tokens.txt",
]:
    assert expected in catalog, f"Model catalog is missing {expected}"

piper_assets = (
    root / "app/src/main/java/jp/stackchan/localvoicepoc/piper/PiperAssetLinks.kt"
).read_text(encoding="utf-8")
for expected in [
    "39_652_717L",
    "5289e9b6eaf21080803b7fe1c4dc85b5491d4c216121207a41df18dd5f68e5d7",
    "6_901L",
    "516058f405ec914140f34832a9d8bb5d8272ba62af9bc7ffb29349715a539780",
    "32_461_242L",
    "d8b6237a546d996a65009bd88f2eb845fad876505952cce98eb3fedaf99fa3d7",
]:
    assert expected in piper_assets, f"Piper asset manifest is missing {expected}"

gemma_manifest = (
    root / "app/src/main/java/jp/stackchan/localvoicepoc/model/GemmaModelManifest.kt"
).read_text(encoding="utf-8")
for expected in [
    "gemma-4-E2B-it.litertlm",
    "2_588_147_712L",
    "181938105e0eefd105961417e8da75903eacda102c4fce9ce90f50b97139a63c",
    "a4a831c060880f3733135ad22f10e0e9f758f45d",
    "gemma-4-E4B-it.litertlm",
    "3_659_530_240L",
    "0b2a8980ce155fd97673d8e820b4d29d9c7d99b8fa6806f425d969b145bd52e0",
    "f7ad3343bd6ebc9607f4dc3bc4f2398bd5749bc5",
]:
    assert expected in gemma_manifest, f"Gemma manifest is missing {expected}"

conversation_engine = (
    root / "app/src/main/java/jp/stackchan/localvoicepoc/conversation/ConversationEngine.kt"
).read_text(encoding="utf-8")
assert "LocalLanguageModel" in conversation_engine
assert "com.runanywhere" not in conversation_engine

kotlin_files = list((root / "app/src").rglob("*.kt"))
assert len(kotlin_files) >= 25
for source in kotlin_files:
    text = source.read_text(encoding="utf-8")
    if "TODO(" in text or "NotImplementedError" in text:
        raise AssertionError(f"Unimplemented code remains in {source.relative_to(root)}")

aar_path = root / "app/libs/piper-plus-release.aar"
aar_checksum_path = root / "app/libs/piper-plus-release.aar.sha256"
if aar_path.is_file():
    if not aar_checksum_path.is_file():
        raise AssertionError("Piper AAR is present but its SHA-256 record is missing")
    expected_sha256, recorded_path = aar_checksum_path.read_text(encoding="utf-8").split()
    if recorded_path != "app/libs/piper-plus-release.aar":
        raise AssertionError(f"Unexpected Piper AAR checksum path: {recorded_path}")
    actual_sha256 = hashlib.sha256(aar_path.read_bytes()).hexdigest()
    if actual_sha256 != expected_sha256:
        raise AssertionError("Piper AAR SHA-256 does not match its recorded value")
    with zipfile.ZipFile(aar_path) as aar:
        aar_entries = set(aar.namelist())
    isolated_runtime = "jni/arm64-v8a/libonnxrtpiper.so"
    conflicting_runtime = "jni/arm64-v8a/libonnxruntime.so"
    if isolated_runtime not in aar_entries or conflicting_runtime in aar_entries:
        raise AssertionError("Piper AAR ONNX Runtime is not isolated from RunAnywhere")

print("Project structure check: OK")
print(f"Kotlin sources: {len(kotlin_files)}")
print(
    "Piper AAR:",
    "present (SHA-256 verified)" if aar_path.is_file()
    else "not installed (expected before TTS build)",
)
