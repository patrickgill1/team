#!/usr/bin/env python3
"""
Strip alpha channel from PNG screenshots so App Store Connect accepts them.

App Store Connect rejects PNGs with an alpha channel (transparency) for app
screenshots. iPhone screenshots — especially with Dynamic Island or certain
status-bar effects — sometimes include alpha even though they look opaque.
This flattens each PNG onto a solid black background (matches the status bar
on most apps) and writes the cleaned files to ./flat/ next to the source.

Usage:
    python3 scripts/strip-alpha.py /path/to/screenshots
    # cleaned files end up in /path/to/screenshots/flat/

If you don't pass a path, defaults to the current directory.
"""

import os
import sys
from PIL import Image

src_dir = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
src_dir = os.path.expanduser(src_dir)
if not os.path.isdir(src_dir):
    print(f"❌ Not a directory: {src_dir}", file=sys.stderr)
    sys.exit(1)

out_dir = os.path.join(src_dir, 'flat')
os.makedirs(out_dir, exist_ok=True)

cleaned = 0
for name in sorted(os.listdir(src_dir)):
    if not name.lower().endswith('.png'):
        continue
    src_path = os.path.join(src_dir, name)
    if os.path.isdir(src_path):
        continue
    img = Image.open(src_path)
    if img.mode == 'RGB':
        # Already opaque — just copy through so the user has all files in one folder
        img.save(os.path.join(out_dir, name))
        continue
    img = img.convert('RGBA')
    bg = Image.new('RGB', img.size, (0, 0, 0))
    bg.paste(img, mask=img.split()[3])
    out_path = os.path.join(out_dir, name)
    bg.save(out_path, 'PNG')
    print(f'✓ {name}  →  flat/{name}')
    cleaned += 1

print(f'\nDone. {cleaned} file(s) flattened. Upload from {out_dir}/')
