# ProposalShredder

A multi-agent GovCon proposal response tool. Give it a government RFP (PDF)
and your capability library, and it produces a compliance matrix, a
first-pass draft proposal narrative, and a red-team compliance check —
all from one CLI command.

## Architecture

Three agents run in sequence, all powered by Claude (`claude-sonnet-4-6`):

1. **Shredder Agent** — reads the full RFP and extracts *every* requirement,
   not just Sections L and M: it hunts through the SOW, Section C, Section H,
   and attachments. Output: a structured compliance matrix (CSV + JSON) with
   requirement ID, source section, requirement text, response required,
   page limit, and the evaluation factor it maps to.
2. **Drafter Agent** — for each requirement, retrieves the top 5 most
   relevant chunks from your capability library (ChromaDB RAG) and drafts a
   direct, solution-first, evaluator-friendly response section. Output: a
   full draft mapped to compliance matrix IDs, delivered as `.docx` (plus
   the markdown source).
3. **Compliance Checker Agent** — red-teams the finished draft against the
   original RFP: unaddressed requirements, page/word limit risks,
   undersupported evaluation criteria, and formatting requirements (font,
   margins, file type) to note for final delivery. Output: a checklist
   report in markdown. Programmatic checks (missing section IDs, estimated
   page counts) run alongside the LLM review.

## Installation

Requires Python 3.9+.

```bash
cd proposalshredder
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
```

## Structuring the capability library

The library is a single folder of PDFs — flat, no subdirectories:

```
capability_library/
├── past_performance_dhs_cloud.pdf
├── capability_statement_helpdesk.pdf
├── contract_summary_soc.pdf
└── ...
```

Good candidates: past proposals, capability statements, contract summaries,
CPARS narratives. On first run, every PDF is chunked (800 characters,
100 overlap) and embedded into a local ChromaDB store saved in
`<library>/.proposalshredder/`. Re-runs reuse the stored embeddings unless
any file in the folder has been added, removed, or modified (checked by
filename + modification time).

If the folder is empty, the tool warns you and drafts from RFP context
only, marking unsupported claims with `[SME INPUT NEEDED]`.

## Running a job

```bash
python shredder.py \
  --rfp path/to/rfp.pdf \
  --library path/to/capability_library/ \
  --output path/to/output_folder/
```

Progress for each agent prints to the terminal. Scanned (image-only) RFP
pages that yield no text are skipped with a warning and flagged in the
final report; OCR those pages separately if they matter.

All Claude API calls retry up to 3 times with a 5-second backoff on API
errors.

## Output files

| File | What it is |
|---|---|
| `compliance_matrix.csv` | One row per extracted requirement: ID, source section, text, response required, page limit, evaluation factor. |
| `compliance_matrix.json` | Same matrix as JSON, for downstream tooling. |
| `proposal_draft.docx` | First-pass draft narrative; one section per response-required requirement, headed by its matrix ID. |
| `proposal_draft.md` | Markdown source of the draft (handy for diffing/editing). |
| `compliance_check_report.md` | Checklist report: automated checks, red-team review, and any pipeline warnings (skipped pages, empty library). |

## Sample test run (no real RFP needed)

Generate a placeholder RFP and a three-document capability library, then
run the full pipeline:

```bash
python samples/generate_sample_data.py

python shredder.py \
  --rfp samples/sample_rfp.pdf \
  --library samples/capability_library/ \
  --output samples/output/
```

The sample RFP contains Sections C, H, L, M and an attachment with ~20
"shall/must" requirements, including page limits and formatting rules, so
you can verify the matrix, draft, and checker outputs end to end before
loading a real solicitation.

### Verifying without an API key

Add `--mock` to run the identical pipeline with canned agent responses and
a local hash-based embedder — no API calls, no model downloads:

```bash
python shredder.py --rfp samples/sample_rfp.pdf \
  --library samples/capability_library/ --output samples/output/ --mock
```

This exercises PDF extraction, requirement shredding, ChromaDB ingestion
and retrieval, docx generation, and the compliance report. Drop `--mock`
once your `ANTHROPIC_API_KEY` is set to get real agent output.

## Notes and limits

- Page-limit checks estimate ~500 words per page; treat them as an early
  warning, not a substitute for formatting the final volume.
- Very large RFPs are shredded in overlapping windows; duplicate
  requirements across windows are de-duplicated by text.
- The draft is a *first pass*: every claim should be reviewed by your
  capture team, especially anything marked `[SME INPUT NEEDED]`.
