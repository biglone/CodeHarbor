#!/usr/bin/env python3

import argparse
import sys


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Local audio transcription for CodeHarbor.")
    parser.add_argument("--input", required=True, help="Path to input audio file.")
    parser.add_argument("--model", default="small", help="Whisper model size/name.")
    parser.add_argument("--device", default="auto", help="Execution device (auto/cpu/cuda).")
    parser.add_argument(
        "--compute-type",
        default="int8",
        help="faster-whisper compute type (int8/float16/float32).",
    )
    parser.add_argument("--language", default=None, help="Optional language hint (for example: zh).")
    parser.add_argument("--beam-size", type=int, default=5, help="Beam size for decoding.")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except Exception as error:  # pragma: no cover - env dependent
        print(
            "faster_whisper is required for local transcription. Install with: python3 -m pip install faster-whisper",
            file=sys.stderr,
        )
        print(str(error), file=sys.stderr)
        return 2

    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    segments, _ = model.transcribe(
        args.input,
        language=args.language,
        vad_filter=True,
        beam_size=args.beam_size,
    )
    text = " ".join(segment.text.strip() for segment in segments if segment.text and segment.text.strip()).strip()
    if not text:
        return 3

    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
