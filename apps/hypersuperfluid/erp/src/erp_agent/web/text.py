"""Conversion of fetched documents into readable text and outgoing links."""

from __future__ import annotations

import io
import re
from dataclasses import dataclass
from typing import cast

import lxml.html
import trafilatura
from lxml.etree import ParserError

from erp_agent.errors import ExtractionError

_WHITESPACE = re.compile(r"[ \t]+")
_BLANK_LINES = re.compile(r"\n{3,}")


@dataclass(frozen=True)
class PageText:
    """Text, title and absolute outgoing links of one document."""

    title: str | None
    text: str
    links: tuple[str, ...]


def _fallback_text(tree: lxml.html.HtmlElement) -> str:
    for element in tree.xpath("//script|//style|//noscript"):
        element.drop_tree()
    text = tree.text_content()
    lines = (_WHITESPACE.sub(" ", line).strip() for line in text.splitlines())
    return _BLANK_LINES.sub("\n\n", "\n".join(lines)).strip()


def html_to_text(html: str, url: str) -> PageText:
    """Extract the main content of an HTML page as Markdown, plus its title and links.

    Falls back to the full visible text when no main content is detected.

    @param html: Page source.
    @param url: Final page URL, used to make links absolute.
    @returns: Page text, title and links.
    @raises ExtractionError: When the HTML cannot be parsed at all.
    """
    try:
        tree = cast(lxml.html.HtmlElement, lxml.html.document_fromstring(html))
    except (ParserError, ValueError) as exc:
        raise ExtractionError(f"cannot parse HTML from {url}: {exc}") from exc
    tree.make_links_absolute(url, resolve_base_href=True)
    links = tuple(
        dict.fromkeys(
            link.split("#", 1)[0]
            for element, attribute, link, _ in tree.iterlinks()
            if element.tag == "a" and attribute == "href" and link.startswith(("http://", "https://"))
        )
    )
    title = (tree.findtext(".//title") or "").strip()
    main = trafilatura.extract(html, url=url, output_format="markdown", include_tables=True, include_links=False)
    text = main if main else _fallback_text(tree)
    return PageText(title=title or None, text=text, links=links)


def pdf_to_text(body: bytes) -> PageText:
    """Extract the text of every page of a PDF.

    @param body: PDF bytes.
    @returns: Page text separated by blank lines; PDFs carry no links here.
    @raises ExtractionError: When the PDF extra is missing or the file cannot be read.
    """
    try:
        import pdfplumber
    except ImportError as exc:
        raise ExtractionError("PDF support needs the 'pdf' extra: uv sync --extra pdf") from exc
    try:
        with pdfplumber.open(io.BytesIO(body)) as pdf:
            text = "\n\n".join(page.extract_text() or "" for page in pdf.pages)
    except Exception as exc:  # pdfminer raises many unrelated types for malformed input
        raise ExtractionError(f"cannot read PDF: {exc}") from exc
    return PageText(title=None, text=text.strip(), links=())


def clip(text: str, max_chars: int) -> tuple[str, bool]:
    """@param text: Page text.
    @param max_chars: Maximum characters to keep.
    @returns: (text cut to `max_chars`, whether it was cut)."""
    if len(text) <= max_chars:
        return text, False
    return text[:max_chars], True
