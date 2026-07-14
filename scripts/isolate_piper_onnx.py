#!/usr/bin/env python3
"""Give Piper Plus its own ONNX Runtime SONAME inside an Android AAR."""

from __future__ import annotations

import os
from pathlib import Path
import sys
import tempfile
import zipfile


ABI_DIRECTORY = "jni/arm64-v8a"
PIPER_LIBRARY = f"{ABI_DIRECTORY}/libpiper_plus.so"
ORIGINAL_RUNTIME = f"{ABI_DIRECTORY}/libonnxruntime.so"
ISOLATED_RUNTIME = f"{ABI_DIRECTORY}/libonnxrtpiper.so"
ORIGINAL_SONAME = b"libonnxruntime.so"
ISOLATED_SONAME = b"libonnxrtpiper.so"
FIXED_ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


def fail(message: str) -> None:
    raise RuntimeError(message)


def replace_once(payload: bytes, old: bytes, new: bytes, entry: str) -> bytes:
    count = payload.count(old)
    if count != 1:
        fail(f"Expected one {old.decode()} reference in {entry}, found {count}")
    return payload.replace(old, new)


def validate_isolated(payload: bytes, entry: str) -> None:
    original_count = payload.count(ORIGINAL_SONAME)
    isolated_count = payload.count(ISOLATED_SONAME)
    if original_count != 0 or isolated_count != 1:
        fail(
            f"Unexpected ONNX SONAME references in {entry}: "
            f"original={original_count}, isolated={isolated_count}",
        )


def cloned_info(source: zipfile.ZipInfo, filename: str) -> zipfile.ZipInfo:
    result = zipfile.ZipInfo(filename=filename, date_time=FIXED_ZIP_TIMESTAMP)
    result.compress_type = source.compress_type
    result.comment = source.comment
    result.internal_attr = source.internal_attr
    result.external_attr = source.external_attr
    result.create_system = source.create_system
    result.flag_bits = source.flag_bits & 0x800
    return result


def transform(source: Path, destination: Path) -> None:
    if len(ORIGINAL_SONAME) != len(ISOLATED_SONAME):
        fail("The replacement SONAME must have exactly the same byte length")

    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with zipfile.ZipFile(source) as input_archive:
            entries = {entry.filename for entry in input_archive.infolist()}
            raw_input = ORIGINAL_RUNTIME in entries and ISOLATED_RUNTIME not in entries
            isolated_input = ISOLATED_RUNTIME in entries and ORIGINAL_RUNTIME not in entries
            if not raw_input and not isolated_input:
                fail("AAR must contain exactly one supported Piper ONNX Runtime entry")
            if PIPER_LIBRARY not in entries or "classes.jar" not in entries:
                fail("AAR is missing Piper Plus classes or its native library")

            with tempfile.NamedTemporaryFile(
                prefix=f".{destination.name}.",
                suffix=".tmp",
                dir=destination.parent,
                delete=False,
            ) as temporary_file:
                temporary_path = Path(temporary_file.name)

            with zipfile.ZipFile(temporary_path, mode="w") as output_archive:
                for source_info in input_archive.infolist():
                    source_name = source_info.filename
                    target_name = (
                        ISOLATED_RUNTIME if raw_input and source_name == ORIGINAL_RUNTIME else source_name
                    )
                    payload = input_archive.read(source_info)
                    if raw_input and source_name in {PIPER_LIBRARY, ORIGINAL_RUNTIME}:
                        payload = replace_once(
                            payload,
                            ORIGINAL_SONAME,
                            ISOLATED_SONAME,
                            source_name,
                        )
                    if target_name in {PIPER_LIBRARY, ISOLATED_RUNTIME}:
                        validate_isolated(payload, target_name)
                    output_archive.writestr(cloned_info(source_info, target_name), payload)

        with zipfile.ZipFile(temporary_path) as output_archive:
            corrupt_entry = output_archive.testzip()
            if corrupt_entry is not None:
                fail(f"Generated AAR contains a corrupt entry: {corrupt_entry}")
        os.replace(temporary_path, destination)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def main() -> int:
    if len(sys.argv) != 3:
        print(f"usage: {sys.argv[0]} SOURCE_AAR DESTINATION_AAR", file=sys.stderr)
        return 2
    source = Path(sys.argv[1]).resolve()
    destination = Path(sys.argv[2]).resolve()
    if not source.is_file():
        print(f"AAR not found: {source}", file=sys.stderr)
        return 1
    try:
        transform(source, destination)
    except (OSError, RuntimeError, zipfile.BadZipFile) as error:
        print(f"Failed to isolate Piper ONNX Runtime: {error}", file=sys.stderr)
        return 1
    print(f"Isolated Piper ONNX Runtime: {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
