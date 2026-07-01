"""Claude API access with retry logic, plus a mock backend for dry runs."""

import json
import logging
import re
import time

logger = logging.getLogger("proposalshredder")

MODEL = "claude-sonnet-4-6"
MAX_RETRIES = 3
BACKOFF_SECONDS = 5


def make_llm(mock=False):
    """Return a callable (system, user, max_tokens) -> str."""
    if mock:
        return _mock_call
    import anthropic

    client = anthropic.Anthropic()

    def call(system, user, max_tokens=4096):
        last_error = None
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                response = client.messages.create(
                    model=MODEL,
                    max_tokens=max_tokens,
                    system=system,
                    messages=[{"role": "user", "content": user}],
                )
                return "".join(
                    block.text for block in response.content
                    if block.type == "text"
                )
            except anthropic.APIError as exc:
                last_error = exc
                logger.warning(
                    "Claude API call failed (attempt %d/%d): %s",
                    attempt, MAX_RETRIES, exc,
                )
                if attempt < MAX_RETRIES:
                    time.sleep(BACKOFF_SECONDS)
        raise RuntimeError(
            f"Claude API call failed after {MAX_RETRIES} attempts: {last_error}"
        )

    return call


def extract_json(text):
    """Pull the first JSON object out of a model response.

    Tolerates markdown code fences and prose before/after the JSON.
    """
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fenced:
        return json.loads(fenced.group(1))
    start = text.find("{")
    if start == -1:
        raise ValueError(f"No JSON object found in model response: {text[:200]}")
    decoder = json.JSONDecoder()
    obj, _ = decoder.raw_decode(text[start:])
    return obj


# --- Mock backend -----------------------------------------------------------
#
# Used by the --mock flag so the full pipeline can be verified without an
# API key. Responses are keyed off distinctive phrases in each agent's
# system prompt.

_REQUIREMENT_PATTERN = re.compile(
    r"[^.\n]*\b(?:shall|must|is required to|are required to)\b[^.\n]*\.",
    re.IGNORECASE,
)
_SECTION_PATTERN = re.compile(r"^(SECTION [A-Z][^\n]*|ATTACHMENT [^\n]*)", re.MULTILINE)


def _mock_call(system, user, max_tokens=4096):
    if "compliance expert" in system:
        return _mock_shred(user)
    if "proposal writer" in system:
        return _mock_draft(user)
    if "red team" in system:
        return _mock_check(user)
    return "Mock response."


def _mock_shred(user):
    requirements = []
    # Split into (section title, body) blocks, then normalize whitespace
    # inside each block so PDF line wraps don't break sentence matching.
    parts = _SECTION_PATTERN.split(user)
    blocks = [("General", parts[0])]
    for i in range(1, len(parts) - 1, 2):
        blocks.append((parts[i].strip()[:60], parts[i + 1]))
    for current_section, body in blocks:
        flattened = " ".join(body.split())
        for match in _REQUIREMENT_PATTERN.finditer(flattened):
            if len(requirements) >= 40:
                break
            text = match.group(0).strip()
            page_limit = None
            limit_match = re.search(r"not exceed (\d+) pages", text,
                                    re.IGNORECASE)
            if limit_match:
                page_limit = int(limit_match.group(1))
            requirements.append({
                "source_section": current_section,
                "requirement_text": text,
                "response_required": "yes",
                "page_limit": page_limit,
                "evaluation_factor": (
                    "Factor 1 - Technical Approach"
                    if "technical" in text.lower()
                    else "Factor 2 - Past Performance"
                    if "past performance" in text.lower()
                    else "Unmapped"
                ),
            })
    return json.dumps({"requirements": requirements})


def _mock_draft(user):
    requirement_id = "this requirement"
    id_match = re.search(r"Requirement ID: (\S+)", user)
    if id_match:
        requirement_id = id_match.group(1)
    has_evidence = "EVIDENCE CHUNK" in user
    evidence_line = (
        "Our team delivered comparable results on prior contracts, as "
        "documented in our past performance library."
        if has_evidence
        else "Past performance evidence was not available in the capability "
        "library for this requirement; this section requires SME input."
    )
    return (
        f"Our team fully complies with {requirement_id}. We will meet this "
        "requirement through our established, ISO-aligned delivery "
        f"methodology. {evidence_line} Our differentiator is a proven, "
        "low-risk transition approach refined across similar federal "
        "engagements.\n\n"
        "- Direct, solution-first response to the stated requirement\n"
        "- Specific past performance evidence cited where available\n"
        "- Clear differentiators for the evaluator\n"
    )


def _mock_check(user):
    return (
        "### Red Team Review (mock)\n\n"
        "- Draft sections were compared against the compliance matrix.\n"
        "- No additional gaps identified by the mock reviewer. Run without "
        "--mock for a real red-team pass.\n"
    )
