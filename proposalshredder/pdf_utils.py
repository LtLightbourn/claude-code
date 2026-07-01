"""PDF text extraction helpers built on pdfplumber."""

import logging

import pdfplumber

logger = logging.getLogger("proposalshredder")


def extract_pdf_text(path):
    """Extract text from a PDF, page by page.

    Returns a tuple of (pages, skipped_pages) where pages is a list of
    dicts with ``page_number`` and ``text`` keys, and skipped_pages is a
    list of page numbers that had no extractable text (likely scanned
    images).
    """
    pages = []
    skipped = []
    with pdfplumber.open(path) as pdf:
        for number, page in enumerate(pdf.pages, start=1):
            try:
                text = page.extract_text() or ""
            except Exception as exc:  # corrupt page, bad encoding, etc.
                logger.warning(
                    "Failed to extract text from page %d of %s: %s",
                    number, path, exc,
                )
                text = ""
            if not text.strip():
                logger.warning(
                    "No extractable text on page %d of %s "
                    "(scanned image?). Skipping page.",
                    number, path,
                )
                skipped.append(number)
                continue
            pages.append({"page_number": number, "text": text})
    return pages, skipped


def pages_to_document_text(pages):
    """Join extracted pages into one string with page markers."""
    parts = []
    for page in pages:
        parts.append(f"[PAGE {page['page_number']}]\n{page['text']}")
    return "\n\n".join(parts)
