"""The three ProposalShredder agents: Shredder, Drafter, Compliance Checker."""

import json
import logging
import re

from llm import extract_json

logger = logging.getLogger("proposalshredder")

# Characters of RFP text sent to the Shredder agent per call. Large RFPs
# are processed in windows so no section is silently truncated.
SHRED_WINDOW = 40000
SHRED_WINDOW_OVERLAP = 2000

# Rough conversion used for page-limit checks (single-spaced, 12pt).
WORDS_PER_PAGE = 500

SHREDDER_SYSTEM = (
    "You are a federal proposal compliance expert. Read this RFP section by "
    "section. Extract every requirement the offeror must address. Be "
    "exhaustive - include requirements hidden in the SOW, Section C, Section "
    "H, and attachments, not just L and M. Flag which evaluation factor each "
    "requirement maps to.\n\n"
    "Respond ONLY with a JSON object of the form:\n"
    '{"requirements": [{"source_section": "...", "requirement_text": "...", '
    '"response_required": "yes"|"no", "page_limit": <int or null>, '
    '"evaluation_factor": "..."}]}\n\n'
    "Rules:\n"
    "- requirement_text must quote or closely paraphrase the RFP language.\n"
    "- source_section is the RFP section/attachment where it appears "
    "(e.g. 'Section L.4.2', 'SOW 3.1', 'Attachment 2').\n"
    "- response_required is 'yes' if the offeror must write to it in the "
    "proposal, 'no' if it is a contract-performance or administrative "
    "obligation only.\n"
    "- page_limit is the stated page limit for the response, if any.\n"
    "- evaluation_factor names the Section M factor it maps to, or "
    "'Unmapped' if none applies."
)

DRAFTER_SYSTEM = (
    "You are an experienced GovCon proposal writer. Using the provided past "
    "performance evidence, write a compliant, evaluator-friendly response to "
    "this requirement. Lead with capability, support with specific past "
    "performance examples, and close with differentiators. Do not pad. Be "
    "direct.\n\n"
    "Follow the one-question rule: answer exactly what the requirement asks, "
    "solution-first, in the format government evaluators prefer. Write in "
    "markdown body text (no top-level heading - the section heading is added "
    "for you). If the evidence does not support a claim, do not invent past "
    "performance; instead note '[SME INPUT NEEDED]' where a citation is "
    "missing."
)

CHECKER_SYSTEM = (
    "You are a proposal red team reviewer. Compare this draft section by "
    "section against the original RFP. Identify every gap - missing "
    "requirements, unsupported claims, page limit violations, and formatting "
    "issues. Be specific about line numbers and section references.\n\n"
    "Output a markdown checklist report with these headings: 'Unaddressed "
    "Requirements', 'Undersupported Evaluation Criteria', 'Page and Word "
    "Limit Risks', 'Formatting Requirements for Final Delivery'. Under each "
    "heading use '- [ ]' checklist items naming the requirement ID and RFP "
    "section involved. If a category has no findings, write 'No findings.'"
)


# --- Shredder Agent ---------------------------------------------------------

def run_shredder(llm, rfp_text, progress=None):
    """Extract every requirement from the RFP into a compliance matrix.

    Returns a list of requirement dicts with assigned requirement IDs.
    """
    windows = _split_windows(rfp_text, SHRED_WINDOW, SHRED_WINDOW_OVERLAP)
    raw_requirements = []
    for index, window in enumerate(windows, start=1):
        if progress:
            progress(f"  Shredding RFP window {index}/{len(windows)}...")
        user = (
            f"RFP text (window {index} of {len(windows)}; page markers "
            f"like [PAGE n] show source pages):\n\n{window}"
        )
        response = llm(SHREDDER_SYSTEM, user, max_tokens=8192)
        try:
            parsed = extract_json(response)
        except (ValueError, json.JSONDecodeError) as exc:
            logger.warning("Could not parse shredder output for window %d: %s",
                           index, exc)
            continue
        for item in parsed.get("requirements", []):
            if item.get("requirement_text"):
                raw_requirements.append(item)

    matrix = []
    seen = set()
    for item in raw_requirements:
        # Overlapping windows can extract the same requirement twice.
        key = " ".join(str(item["requirement_text"]).lower().split())[:200]
        if key in seen:
            continue
        seen.add(key)
        page_limit = item.get("page_limit")
        if isinstance(page_limit, str):
            digits = re.search(r"\d+", page_limit)
            page_limit = int(digits.group(0)) if digits else None
        matrix.append({
            "requirement_id": f"R-{len(matrix) + 1:03d}",
            "source_section": str(item.get("source_section") or "Unknown"),
            "requirement_text": str(item["requirement_text"]),
            "response_required":
                "yes" if str(item.get("response_required", "yes")).lower()
                in ("yes", "true", "y") else "no",
            "page_limit": page_limit,
            "evaluation_factor": str(item.get("evaluation_factor") or "Unmapped"),
        })
    return matrix


def _split_windows(text, size, overlap):
    if len(text) <= size:
        return [text]
    windows = []
    start = 0
    while start < len(text):
        windows.append(text[start:start + size])
        if start + size >= len(text):
            break
        start += size - overlap
    return windows


# --- Drafter Agent ----------------------------------------------------------

def run_drafter(llm, matrix, search_library, progress=None):
    """Draft a response section for each requirement that needs one.

    ``search_library`` is a callable (query) -> list of evidence chunk
    dicts with ``source`` and ``text`` keys (empty list if no library).
    Returns the full draft as a markdown string.
    """
    sections = ["# Draft Proposal Narrative\n"]
    respond_to = [r for r in matrix if r["response_required"] == "yes"]
    for index, requirement in enumerate(respond_to, start=1):
        if progress:
            progress(
                f"  Drafting {requirement['requirement_id']} "
                f"({index}/{len(respond_to)})..."
            )
        evidence = search_library(requirement["requirement_text"])
        evidence_block = "\n\n".join(
            f"EVIDENCE CHUNK {i} (from {chunk['source']}):\n{chunk['text']}"
            for i, chunk in enumerate(evidence, start=1)
        ) or (
            "No past performance evidence available. Draft from the "
            "requirement alone and mark unsupported claims with "
            "[SME INPUT NEEDED]."
        )
        user = (
            f"Requirement ID: {requirement['requirement_id']}\n"
            f"RFP source section: {requirement['source_section']}\n"
            f"Evaluation factor: {requirement['evaluation_factor']}\n"
            f"Page limit: {requirement['page_limit'] or 'none stated'}\n\n"
            f"Requirement:\n{requirement['requirement_text']}\n\n"
            f"Past performance evidence:\n{evidence_block}"
        )
        body = llm(DRAFTER_SYSTEM, user, max_tokens=4096).strip()
        heading = (
            f"## {requirement['requirement_id']}: "
            f"{requirement['source_section']} - "
            f"{requirement['evaluation_factor']}"
        )
        quoted = _truncate(requirement["requirement_text"], 300)
        sections.append(f"{heading}\n\n> Requirement: {quoted}\n\n{body}\n")
    return "\n".join(sections)


def _truncate(text, limit):
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit - 3] + "..."


# --- Compliance Checker Agent -----------------------------------------------

def run_checker(llm, matrix, draft_markdown, rfp_text, skipped_pages,
                library_empty, progress=None):
    """Final compliance pass. Returns the checklist report as markdown."""
    if progress:
        progress("  Running programmatic checks...")
    programmatic = _programmatic_checks(matrix, draft_markdown)

    if progress:
        progress("  Running red team review...")
    formatting_excerpts = _formatting_excerpts(rfp_text)
    user = (
        "COMPLIANCE MATRIX (JSON):\n"
        f"{json.dumps(matrix, indent=1)[:30000]}\n\n"
        "RFP FORMATTING / SUBMISSION INSTRUCTIONS (excerpts):\n"
        f"{formatting_excerpts[:15000]}\n\n"
        "DRAFT PROPOSAL (markdown, with line numbers):\n"
        f"{_number_lines(draft_markdown)[:100000]}"
    )
    review = llm(CHECKER_SYSTEM, user, max_tokens=8192).strip()

    notes = []
    if skipped_pages:
        notes.append(
            f"- **RFP extraction gaps:** pages "
            f"{', '.join(map(str, skipped_pages))} of the RFP had no "
            "extractable text (scanned images?). Requirements on those "
            "pages are NOT in the matrix - review them manually."
        )
    if library_empty:
        notes.append(
            "- **Capability library was empty:** the draft was written "
            "from RFP context only, with no past performance evidence."
        )
    notes_block = ("\n## Pipeline Warnings\n\n" + "\n".join(notes) + "\n") \
        if notes else ""

    return (
        "# Compliance Check Report\n"
        f"{notes_block}\n"
        "## Automated Checks\n\n"
        f"{programmatic}\n\n"
        "## Red Team Review\n\n"
        f"{review}\n"
    )


def _programmatic_checks(matrix, draft_markdown):
    lines = []
    missing = [
        r for r in matrix
        if r["response_required"] == "yes"
        and r["requirement_id"] not in draft_markdown
    ]
    if missing:
        lines.append("**Requirements missing from the draft:**")
        lines.extend(
            f"- [ ] {r['requirement_id']} ({r['source_section']})"
            for r in missing
        )
    else:
        lines.append("- [x] Every response-required requirement in the "
                     "matrix has a matching section in the draft.")

    limit_findings = []
    for requirement in matrix:
        limit = requirement.get("page_limit")
        if not limit:
            continue
        section_text = _extract_section(draft_markdown,
                                        requirement["requirement_id"])
        if section_text is None:
            continue
        words = len(section_text.split())
        estimated_pages = words / WORDS_PER_PAGE
        if estimated_pages > limit:
            limit_findings.append(
                f"- [ ] {requirement['requirement_id']}: ~{words} words "
                f"(~{estimated_pages:.1f} pages at {WORDS_PER_PAGE} "
                f"words/page) vs. a {limit}-page limit."
            )
    if limit_findings:
        lines.append("")
        lines.append("**Estimated page limit risks** "
                     f"(assuming ~{WORDS_PER_PAGE} words/page):")
        lines.extend(limit_findings)
    else:
        lines.append("- [x] No draft section exceeds its stated page limit "
                     f"(estimated at ~{WORDS_PER_PAGE} words/page).")
    return "\n".join(lines)


def _extract_section(draft_markdown, requirement_id):
    pattern = re.compile(
        rf"^## {re.escape(requirement_id)}:.*?(?=^## |\Z)",
        re.MULTILINE | re.DOTALL,
    )
    match = pattern.search(draft_markdown)
    return match.group(0) if match else None


_FORMAT_KEYWORDS = re.compile(
    r"font|margin|page limit|pages|spacing|single-spaced|double-spaced|"
    r"file type|\.pdf|\.docx|format|volume|copies|submission",
    re.IGNORECASE,
)


def _formatting_excerpts(rfp_text):
    hits = [
        line.strip() for line in rfp_text.splitlines()
        if _FORMAT_KEYWORDS.search(line)
    ]
    return "\n".join(hits[:200]) or "(none found)"


def _number_lines(text):
    return "\n".join(
        f"{number:4d}| {line}"
        for number, line in enumerate(text.splitlines(), start=1)
    )
