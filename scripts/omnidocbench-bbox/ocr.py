"""Optional CPU OCR capture; emits observed text lines, never reads GT text."""

import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path

from rapidocr_onnxruntime import RapidOCR


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--images", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    output = Path(args.out)
    if output.exists():
        raise ValueError("OCR snapshot already exists; use a new output path")
    manifest_bytes = Path(args.manifest).read_bytes()
    manifest = json.loads(manifest_bytes)
    image_root = Path(args.images).resolve()
    engine = RapidOCR(intra_op_num_threads=2, inter_op_num_threads=1)
    pages = []
    for record in manifest["cases"]:
        image = (image_root / record["imagePath"]).resolve()
        if not image.is_relative_to(image_root):
            raise ValueError("Image path escapes dataset directory")
        result, _ = engine(str(image))
        pages.append(
            {
                "imagePath": record["imagePath"],
                "imageSha256": digest(image.read_bytes()),
                "lines": [
                    {
                        "poly": [[float(x), float(y)] for x, y in poly],
                        "text": text,
                        "score": float(score),
                    }
                    for poly, text, score in (result or [])
                ],
            }
        )
        print(f"OCR {record['imagePath']}: {len(result or [])} lines", flush=True)
    data = {
        "schemaVersion": 1,
        "engine": "rapidocr-onnxruntime",
        "engineVersion": importlib.metadata.version("rapidocr-onnxruntime"),
        "manifestSha256": digest(manifest_bytes),
        "pages": pages,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
