"""Generate a placeholder RFP PDF and a small capability library.

Run from the proposalshredder directory:

    python samples/generate_sample_data.py

Creates:
    samples/sample_rfp.pdf
    samples/capability_library/*.pdf  (3 past-performance documents)
"""

from pathlib import Path

from fpdf import FPDF

SAMPLES_DIR = Path(__file__).parent

RFP_SECTIONS = [
    ("SECTION C - DESCRIPTION / SPECIFICATIONS / STATEMENT OF WORK", """
C.1 Background. The Agency requires enterprise IT modernization support
services including cloud migration, help desk operations, and
cybersecurity monitoring.

C.2 Scope. The Contractor shall provide all personnel, equipment, and
services necessary to migrate 40 legacy applications to a FedRAMP
Moderate cloud environment within 18 months of award. The Contractor
shall operate a Tier 1/Tier 2 help desk from 0600 to 1800 Eastern,
Monday through Friday. The Contractor shall maintain a Security
Operations Center providing continuous monitoring in accordance with
NIST SP 800-137.

C.3 Transition. The Contractor shall complete phase-in within 60 days
of award with no degradation of service. The Contractor shall submit a
Transition-In Plan no later than 10 days after award.
"""),
    ("SECTION H - SPECIAL CONTRACT REQUIREMENTS", """
H.1 Key Personnel. The Contractor shall provide a Program Manager with
PMP certification and at least 8 years of federal IT program experience.
The Contractor shall not replace key personnel without 30 days advance
written notice to the Contracting Officer.

H.2 Security. All contractor personnel are required to obtain a Public
Trust clearance prior to system access. The Contractor shall report
security incidents within 1 hour of discovery.
"""),
    ("SECTION L - INSTRUCTIONS TO OFFERORS", """
L.1 General. Proposals must be submitted electronically in PDF format
via SAM.gov no later than 30 days after solicitation release.

L.2 Volume I - Technical. The offeror shall describe its technical
approach to cloud migration, help desk operations, and security
monitoring. Volume I shall not exceed 15 pages. The offeror shall
describe its approach to transition-in, including a draft schedule.

L.3 Volume II - Past Performance. The offeror shall submit no more than
3 past performance references for contracts of similar size and scope
performed within the last 5 years. Volume II shall not exceed 6 pages.

L.4 Formatting. All volumes must use 12-point Times New Roman font with
1-inch margins on 8.5 x 11 inch pages, single-spaced.
"""),
    ("SECTION M - EVALUATION FACTORS FOR AWARD", """
M.1 Basis of Award. Award will be made on a best-value tradeoff basis.

M.2 Factor 1 - Technical Approach. The Government will evaluate the
offeror's approach to cloud migration, help desk operations, security
monitoring, and transition. The offeror must demonstrate a low-risk
migration methodology.

M.3 Factor 2 - Past Performance. The Government will evaluate the
recency and relevance of past performance. Offerors must demonstrate
successful performance on contracts of similar scope.
"""),
    ("ATTACHMENT 1 - PERFORMANCE WORK STATEMENT ADDENDUM", """
A1.1 Service Levels. The Contractor shall resolve 85 percent of help
desk tickets within 8 business hours. The Contractor shall achieve 99.9
percent availability for migrated applications, measured monthly.

A1.2 Reporting. The Contractor shall deliver a Monthly Status Report by
the 10th of each month summarizing migration progress, ticket metrics,
and security posture.
"""),
]

LIBRARY_DOCS = {
    "past_performance_dhs_cloud.pdf": """
PAST PERFORMANCE SUMMARY - DHS CLOUD MIGRATION SUPPORT

Contract: 70RDAD20C00000001, $24M, 2021-2024. Acme Federal migrated 55
legacy applications to a FedRAMP Moderate AWS GovCloud environment 2
months ahead of schedule using our phased Factory Migration methodology.
We sustained 99.95 percent availability across all migrated workloads
and received Exceptional CPARS ratings in all categories for all three
performance years. Our transition-in completed in 45 days with zero
service degradation, validated by the government QASP.
""",
    "capability_statement_helpdesk.pdf": """
CAPABILITY STATEMENT - ENTERPRISE SERVICE DESK OPERATIONS

Acme Federal operates HDI-certified Tier 1/Tier 2 service desks for
four federal agencies, handling 18,000 tickets monthly. Our desks
consistently resolve 90 percent of tickets within 8 business hours
using our KCS-aligned knowledge management program. All analysts hold
Public Trust or higher clearances. Staffing model provides 0600-1800
Eastern coverage with surge capability. ITIL 4 aligned processes;
average CSAT of 4.7/5.0 across all task orders.
""",
    "contract_summary_soc.pdf": """
CONTRACT SUMMARY - SECURITY OPERATIONS CENTER, FEDERAL CIVILIAN AGENCY

Acme Federal has operated a 24x7 Security Operations Center since 2019
providing continuous monitoring under NIST SP 800-137 for a cabinet
level agency. Mean time to detect: 11 minutes. Mean time to report
incidents: 42 minutes, well inside the contractual 1 hour requirement.
Our SOC integrates Splunk, Tenable, and CISA CDM dashboards, and our
PMP/CISSP certified program manager has led the effort for 5 years
with zero missed deliverables.
""",
}


def _write_pdf(path, title, blocks):
    pdf = FPDF(format="Letter")
    pdf.set_auto_page_break(auto=True, margin=25)
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 14)
    pdf.multi_cell(0, 8, title)
    pdf.ln(4)
    for heading, body in blocks:
        if heading:
            pdf.set_font("Helvetica", "B", 12)
            pdf.multi_cell(0, 7, heading)
            pdf.ln(1)
        pdf.set_font("Helvetica", "", 11)
        pdf.multi_cell(0, 6, body.strip())
        pdf.ln(4)
    pdf.output(str(path))
    print(f"Wrote {path}")


def main():
    _write_pdf(
        SAMPLES_DIR / "sample_rfp.pdf",
        "SOLICITATION NO. TEST-26-R-0001\n"
        "ENTERPRISE IT MODERNIZATION SUPPORT SERVICES (PLACEHOLDER RFP)",
        RFP_SECTIONS,
    )
    library_dir = SAMPLES_DIR / "capability_library"
    library_dir.mkdir(exist_ok=True)
    for name, body in LIBRARY_DOCS.items():
        title = body.strip().splitlines()[0]
        content = "\n".join(body.strip().splitlines()[1:])
        _write_pdf(library_dir / name, title, [("", content)])


if __name__ == "__main__":
    main()
