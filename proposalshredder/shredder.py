"""ProposalShredder: multi-agent GovCon RFP shred, draft, and compliance check.

Usage:
    python shredder.py --rfp path/to/rfp.pdf \
        --library path/to/capability_library/ \
        --output path/to/output_folder/
"""

import csv
import json
import logging
import sys
from pathlib import Path

import click

from agents import run_checker, run_drafter, run_shredder
from docx_writer import markdown_to_docx
from llm import make_llm
from pdf_utils import extract_pdf_text, pages_to_document_text
from rag import CapabilityLibrary

MATRIX_FIELDS = [
    "requirement_id", "source_section", "requirement_text",
    "response_required", "page_limit", "evaluation_factor",
]


@click.command()
@click.option("--rfp", "rfp_path", required=True,
              type=click.Path(exists=True, dir_okay=False),
              help="Path to the government RFP PDF.")
@click.option("--library", "library_dir", required=True,
              type=click.Path(exists=True, file_okay=False),
              help="Folder of past-performance / capability PDFs.")
@click.option("--output", "output_dir", required=True,
              type=click.Path(file_okay=False),
              help="Folder where output files are written.")
@click.option("--mock", is_flag=True,
              help="Run the full pipeline with canned agent responses and "
                   "no API calls (verifies the install end to end).")
def main(rfp_path, library_dir, output_dir, mock):
    """Run all three agents in sequence: Shredder, Drafter, Checker."""
    logging.basicConfig(
        level=logging.WARNING,
        format="%(levelname)s: %(message)s",
        stream=sys.stderr,
    )
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    llm = make_llm(mock=mock)
    if mock:
        click.echo("Running in --mock mode: no API calls will be made.")

    # --- Stage 0: extract the RFP -------------------------------------
    click.echo(f"[1/4] Extracting text from {rfp_path}...")
    pages, skipped_pages = extract_pdf_text(rfp_path)
    if not pages:
        raise click.ClickException(
            "No extractable text found anywhere in the RFP. If this is a "
            "scanned PDF, run it through OCR first."
        )
    if skipped_pages:
        click.echo(
            f"  Warning: {len(skipped_pages)} page(s) had no extractable "
            f"text and were skipped: {skipped_pages}"
        )
    rfp_text = pages_to_document_text(pages)
    click.echo(f"  Extracted {len(pages)} page(s).")

    # --- Stage 1: Shredder Agent --------------------------------------
    click.echo("[2/4] Shredder Agent: building the compliance matrix...")
    matrix = run_shredder(llm, rfp_text, progress=click.echo)
    if not matrix:
        raise click.ClickException(
            "The Shredder Agent found no requirements in the RFP text."
        )
    click.echo(f"  Extracted {len(matrix)} requirement(s).")
    _write_matrix(matrix, output)
    click.echo(f"  Wrote {output / 'compliance_matrix.csv'} and .json")

    # --- Stage 2: Drafter Agent ---------------------------------------
    click.echo("[3/4] Drafter Agent: drafting the proposal narrative...")
    library = CapabilityLibrary(library_dir, mock=mock)
    if library.is_empty:
        click.echo(
            "  Warning: capability library is empty. Drafting from RFP "
            "context only."
        )
    else:
        click.echo("  Preparing capability library (ChromaDB)...")
        library.ingest(progress=click.echo)
    draft_markdown = run_drafter(
        llm, matrix, library.search, progress=click.echo,
    )
    draft_path = output / "proposal_draft.docx"
    markdown_to_docx(draft_markdown, draft_path)
    (output / "proposal_draft.md").write_text(draft_markdown)
    click.echo(f"  Wrote {draft_path} (plus proposal_draft.md source)")

    # --- Stage 3: Compliance Checker Agent ----------------------------
    click.echo("[4/4] Compliance Checker Agent: red team review...")
    report = run_checker(
        llm, matrix, draft_markdown, rfp_text, skipped_pages,
        library.is_empty, progress=click.echo,
    )
    report_path = output / "compliance_check_report.md"
    report_path.write_text(report)
    click.echo(f"  Wrote {report_path}")

    click.echo("\nDone. Outputs:")
    for name in ("compliance_matrix.csv", "compliance_matrix.json",
                 "proposal_draft.docx", "proposal_draft.md",
                 "compliance_check_report.md"):
        click.echo(f"  {output / name}")


def _write_matrix(matrix, output):
    with open(output / "compliance_matrix.csv", "w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=MATRIX_FIELDS)
        writer.writeheader()
        writer.writerows(matrix)
    (output / "compliance_matrix.json").write_text(
        json.dumps(matrix, indent=2)
    )


if __name__ == "__main__":
    main()
