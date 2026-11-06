"""PDF operations for Hypersuperfluid's office mode.

Run with the Python that `office_tools` reports:

    python pdf_tool.py info IN.pdf
    python pdf_tool.py text IN.pdf [--pages 1-3]
    python pdf_tool.py tables IN.pdf OUT_DIR [--pages 2]
    python pdf_tool.py merge OUT.pdf IN1.pdf IN2.pdf ...
    python pdf_tool.py split IN.pdf OUT_DIR
    python pdf_tool.py pages IN.pdf OUT.pdf 1-3,5          (extract and reorder)
    python pdf_tool.py rotate IN.pdf OUT.pdf 90 [--pages 2,4]
    python pdf_tool.py delete IN.pdf OUT.pdf 2,7
    python pdf_tool.py watermark IN.pdf OUT.pdf "DRAFT"
    python pdf_tool.py encrypt IN.pdf OUT.pdf --password-env PDF_PASSWORD
    python pdf_tool.py decrypt IN.pdf OUT.pdf --password-env PDF_PASSWORD
    python pdf_tool.py fields IN.pdf                       (list form fields)
    python pdf_tool.py fill IN.pdf OUT.pdf values.json     (fill form fields)
    python pdf_tool.py images OUT.pdf IMG1.png IMG2.jpg ...
    python pdf_tool.py compress IN.pdf OUT.pdf

Pages are 1-based. Passwords come from an environment variable, never the command line, so they stay out of logs.
Every command writes a new file and leaves its input untouched.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from pathlib import Path


def page_list(spec: str | None, count: int) -> list[int]:
    """Turn '1-3,5' into zero-based indexes; None means every page."""
    if not spec:
        return list(range(count))
    result: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            start, end = part.split("-", 1)
            first, last = int(start), int(end) if end else count
            result.extend(range(first - 1, last))
        elif part:
            result.append(int(part) - 1)
    bad = [index + 1 for index in result if index < 0 or index >= count]
    if bad:
        raise SystemExit(f"page {bad[0]} is outside 1-{count}")
    return result


def reader(path: str, password: str | None = None):
    from pypdf import PdfReader

    pdf = PdfReader(path)
    if pdf.is_encrypted:
        if password is None:
            raise SystemExit(f"{path} is encrypted: pass --password-env with the variable holding its password")
        if not pdf.decrypt(password):
            raise SystemExit(f"the password did not open {path}")
    return pdf


def password_from(args) -> str | None:
    name = getattr(args, "password_env", None)
    if not name:
        return None
    value = os.environ.get(name)
    if value is None:
        raise SystemExit(f"environment variable {name} is not set")
    return value


def write(writer, out: str) -> None:
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    with open(out, "wb") as handle:
        writer.write(handle)
    print(f"wrote {out}")


def cmd_info(args) -> None:
    pdf = reader(args.input, password_from(args))
    meta = {key.lstrip("/"): str(value) for key, value in (pdf.metadata or {}).items()}
    first = pdf.pages[0].mediabox if pdf.pages else None
    print(json.dumps({
        "pages": len(pdf.pages),
        "encrypted": pdf.is_encrypted,
        "metadata": meta,
        "first_page_points": [float(first.width), float(first.height)] if first else None,
        "form_fields": len(pdf.get_fields() or {}),
    }, indent=2))


def cmd_text(args) -> None:
    import pdfplumber

    with pdfplumber.open(args.input, password=password_from(args) or "") as pdf:
        for index in page_list(args.pages, len(pdf.pages)):
            print(f"--- page {index + 1} ---")
            print(pdf.pages[index].extract_text() or "")


def cmd_tables(args) -> None:
    import pdfplumber

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    written = 0
    with pdfplumber.open(args.input, password=password_from(args) or "") as pdf:
        for index in page_list(args.pages, len(pdf.pages)):
            for number, table in enumerate(pdf.pages[index].extract_tables(), start=1):
                target = out / f"page{index + 1}_table{number}.csv"
                with open(target, "w", newline="", encoding="utf-8") as handle:
                    csv.writer(handle).writerows(table)
                written += 1
                print(f"wrote {target}")
    if written == 0:
        print("no tables found; scanned pages need OCR, which this tool does not do")


def cmd_merge(args) -> None:
    from pypdf import PdfWriter

    writer = PdfWriter()
    for path in args.inputs:
        writer.append(reader(path))
    write(writer, args.output)


def cmd_split(args) -> None:
    from pypdf import PdfWriter

    pdf = reader(args.input, password_from(args))
    out = Path(args.out_dir)
    for index, page in enumerate(pdf.pages, start=1):
        writer = PdfWriter()
        writer.add_page(page)
        write(writer, str(out / f"{Path(args.input).stem}_p{index}.pdf"))


def cmd_pages(args) -> None:
    from pypdf import PdfWriter

    pdf = reader(args.input, password_from(args))
    writer = PdfWriter()
    for index in page_list(args.spec, len(pdf.pages)):
        writer.add_page(pdf.pages[index])
    write(writer, args.output)


def cmd_rotate(args) -> None:
    from pypdf import PdfWriter

    pdf = reader(args.input, password_from(args))
    chosen = set(page_list(args.pages, len(pdf.pages)))
    writer = PdfWriter()
    for index, page in enumerate(pdf.pages):
        writer.add_page(page)
        if index in chosen:
            writer.pages[-1].rotate(args.degrees)
    write(writer, args.output)


def cmd_delete(args) -> None:
    from pypdf import PdfWriter

    pdf = reader(args.input, password_from(args))
    drop = set(page_list(args.spec, len(pdf.pages)))
    writer = PdfWriter()
    for index, page in enumerate(pdf.pages):
        if index not in drop:
            writer.add_page(page)
    write(writer, args.output)


def cmd_watermark(args) -> None:
    import io

    from pypdf import PdfReader, PdfWriter
    from reportlab.lib.colors import Color
    from reportlab.pdfgen import canvas

    pdf = reader(args.input, password_from(args))
    writer = PdfWriter()
    for page in pdf.pages:
        width, height = float(page.mediabox.width), float(page.mediabox.height)
        buffer = io.BytesIO()
        sheet = canvas.Canvas(buffer, pagesize=(width, height))
        sheet.setFillColor(Color(0.5, 0.5, 0.5, alpha=args.opacity))
        sheet.setFont("Helvetica-Bold", max(24, min(width, height) / 8))
        sheet.translate(width / 2, height / 2)
        sheet.rotate(45)
        sheet.drawCentredString(0, 0, args.text)
        sheet.save()
        page.merge_page(PdfReader(io.BytesIO(buffer.getvalue())).pages[0])
        writer.add_page(page)
    write(writer, args.output)


def cmd_encrypt(args) -> None:
    from pypdf import PdfWriter

    secret = password_from(args)
    if secret is None:
        raise SystemExit("encrypt needs --password-env")
    writer = PdfWriter(clone_from=reader(args.input))
    writer.encrypt(user_password=secret, owner_password=secret, algorithm="AES-256")
    write(writer, args.output)


def cmd_decrypt(args) -> None:
    from pypdf import PdfWriter

    writer = PdfWriter(clone_from=reader(args.input, password_from(args)))
    write(writer, args.output)


def cmd_fields(args) -> None:
    pdf = reader(args.input, password_from(args))
    fields = pdf.get_fields() or {}
    print(json.dumps({name: {"type": str(field.get("/FT")), "value": str(field.get("/V"))} for name, field in fields.items()}, indent=2))


def cmd_fill(args) -> None:
    from pypdf import PdfWriter

    values = json.loads(Path(args.values).read_text(encoding="utf-8"))
    writer = PdfWriter(clone_from=reader(args.input, password_from(args)))
    known = set((writer.get_fields() or {}).keys()) if hasattr(writer, "get_fields") else set()
    unknown = [name for name in values if known and name not in known]
    if unknown:
        raise SystemExit(f"no such form fields: {', '.join(unknown)}")
    for page in writer.pages:
        writer.update_page_form_field_values(page, values, auto_regenerate=False)
    writer.set_need_appearances_writer(True)
    write(writer, args.output)


def cmd_images(args) -> None:
    from PIL import Image

    frames = [Image.open(path).convert("RGB") for path in args.inputs]
    if not frames:
        raise SystemExit("give at least one image")
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(args.output, save_all=True, append_images=frames[1:], resolution=150)
    print(f"wrote {args.output}")


def cmd_compress(args) -> None:
    from pypdf import PdfWriter

    writer = PdfWriter(clone_from=reader(args.input, password_from(args)))
    for page in writer.pages:
        page.compress_content_streams()
    writer.compress_identical_objects(remove_identicals=True, remove_orphans=True)
    write(writer, args.output)
    before, after = os.path.getsize(args.input), os.path.getsize(args.output)
    print(f"{before} -> {after} bytes")



def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    def add(name, handler, *positionals, pages=False, password=True, extra=None):
        command = sub.add_parser(name)
        for positional in positionals:
            if positional.endswith("..."):
                command.add_argument(positional[:-3], nargs="+")
            else:
                command.add_argument(positional)
        if pages:
            command.add_argument("--pages")
        if password:
            command.add_argument("--password-env")
        for flag, options in (extra or {}).items():
            command.add_argument(flag, **options)
        command.set_defaults(handler=handler)

    add("info", cmd_info, "input")
    add("text", cmd_text, "input", pages=True)
    add("tables", cmd_tables, "input", "out_dir", pages=True)
    add("merge", cmd_merge, "output", "inputs...", password=False)
    add("split", cmd_split, "input", "out_dir")
    add("pages", cmd_pages, "input", "output", "spec")
    add("rotate", cmd_rotate, "input", "output", pages=True, extra={"degrees": {"type": int, "choices": [90, 180, 270]}})
    add("delete", cmd_delete, "input", "output", "spec")
    add("watermark", cmd_watermark, "input", "output", "text", extra={"--opacity": {"type": float, "default": 0.25}})
    add("encrypt", cmd_encrypt, "input", "output")
    add("decrypt", cmd_decrypt, "input", "output")
    add("fields", cmd_fields, "input")
    add("fill", cmd_fill, "input", "output", "values")
    add("images", cmd_images, "output", "inputs...", password=False)
    add("compress", cmd_compress, "input", "output")

    args = parser.parse_args(argv)
    args.handler(args)


if __name__ == "__main__":
    main(sys.argv[1:])
