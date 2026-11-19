"""Generate real binary fixtures for the extraction-backed eval tier.

Run from packages/evals: python scripts/generate_extraction_fixtures.py
Requires python-docx, openpyxl, python-pptx, reportlab, and Pillow.
The generated files are opaque to the agent: raw reads show gibberish and the
agent must discover its own way to extract them with its default tools.
"""

import hashlib
import os
import shutil
import zipfile
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

from docx import Document
from lxml import etree
from openpyxl import Workbook
from PIL import Image, ImageDraw
from pypdf import PdfReader, PdfWriter
from pptx import Presentation
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parent.parent / "fixtures" / "extraction"

PDF_AUTHOR = "Velo AI Records"
PDF_SUBJECT = "Business document"
PDF_CREATOR = "Velo AI Fixture Generator"
INVARIANT_CREATION_DATE = "D:20000101000000Z"


def put(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def text_pdf(path: Path, lines: list[str], columns: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pdf = canvas.Canvas(str(path), pagesize=A4, invariant=1)
    pdf.setTitle(lines[0] if lines else path.stem)
    pdf.setAuthor(PDF_AUTHOR)
    pdf.setSubject(PDF_SUBJECT)
    pdf.setCreator(PDF_CREATOR)
    y = 800
    for line in lines:
        if columns and "|" in line:
            left, right = line.split("|", 1)
            pdf.drawString(70, y, left.strip())
            pdf.drawString(330, y, right.strip())
        else:
            pdf.drawString(70, y, line)
        y -= 24
        if y < 60:
            pdf.showPage()
            y = 800
    pdf.save()


def scan_pdf(path: Path, text: str) -> None:
    """Image-only PDF: no text layer, so only OCR can recover the words."""
    image = Image.new("RGB", (1200, 500), "white")
    draw = ImageDraw.Draw(image)
    draw.text((60, 80), text, fill="black")
    draw.text((60, 150), "SCANNED PAGE - NO TEXT LAYER", fill="black")
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(str(path), "PDF", resolution=120.0)


def encrypted_pdf(path: Path, lines: list[str], password: str) -> None:
    """Valid PDF encrypted with a password that must be discovered elsewhere."""
    buffer = BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4, invariant=1)
    title = lines[0] if lines else path.stem
    pdf.setTitle(title)
    pdf.setAuthor(PDF_AUTHOR)
    pdf.setSubject(PDF_SUBJECT)
    pdf.setCreator(PDF_CREATOR)
    y = 800
    for line in lines:
        pdf.drawString(70, y, line)
        y -= 24
    pdf.save()
    buffer.seek(0)
    writer = PdfWriter()
    for page in PdfReader(buffer).pages:
        writer.add_page(page)
    writer.add_metadata(
        {
            "/Title": title,
            "/Author": PDF_AUTHOR,
            "/Subject": PDF_SUBJECT,
            "/Creator": PDF_CREATOR,
            "/CreationDate": INVARIANT_CREATION_DATE,
            "/ModDate": INVARIANT_CREATION_DATE,
        }
    )
    writer.encrypt(password)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        writer.write(handle)


def mojibake_file(path: Path, text: str) -> None:
    """Write cp1252 bytes: a UTF-8 reader sees Ã© and similar garbage."""
    put(path, text.encode("cp1252"))


def patch_hide_slide(path: Path, slide_index: int) -> None:
    """Mark the given 1-based slide hidden in the PPTX package metadata."""
    temporary = path.with_suffix(".tmp")
    target_name = f"ppt/slides/slide{slide_index}.xml"
    with zipfile.ZipFile(path) as source, zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as target:
        for item in source.infolist():
            data = source.read(item.filename)
            if item.filename == target_name:
                data = data.replace(b"<p:sld ", b'<p:sld show="0" ', 1)
            target.writestr(item, data)
    shutil.move(str(temporary), str(path))


def add_tracked_change(document: Document, old: str, new: str) -> None:
    """Insert a stale deleted value and a current inserted value into a paragraph."""
    namespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    paragraph = document.add_paragraph()._p
    paragraph.append(
        etree.fromstring(
            f'<w:del xmlns:w="{namespace}" w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z">'
            f"<w:r><w:delText>{old}</w:delText></w:r></w:del>"
        )
    )
    paragraph.append(
        etree.fromstring(
            f'<w:ins xmlns:w="{namespace}" w:id="2" w:author="A" w:date="2024-01-02T00:00:00Z">'
            f"<w:r><w:t>{new}</w:t></w:r></w:ins>"
        )
    )


def make_oven() -> None:
    base = ROOT / "oven" / "G-drive" / "suppliers" / "thermofix"
    text_pdf(
        base / "quote_feb28.pdf",
        [
            "ThermoFix Kitchen Services",
            "Quote dated 28 February 2026",
            "Oven repair quoted at GBP 1,180",
            "Reference QUOTE-FEB-28",
        ],
    )
    text_pdf(
        base / "INV-2093.pdf",
        [
            "ThermoFix Kitchen Services | INVOICE INV-2093",
            "Reference TFK-2093-7741 | 14 March 2026",
            "Labour and parts GBP 1,180 | call-out GBP 60",
            "TOTAL GBP 1,240 | ﬁnal amount due",
        ],
        columns=True,
    )
    text_pdf(
        base / "INV-2144.pdf",
        [
            "ThermoFix Kitchen Services",
            "INVOICE INV-2144",
            "PROOFER repair GBP 390",
            "14 April 2026",
            "Reference TFK/2144",
        ],
    )
    text_pdf(
        base / "CN-118.pdf",
        [
            "CREDIT NOTE CN-118",
            "GBP -60",
            "Oven callback",
            "Dated 2 May 2026",
            "Does not alter the March invoice total",
        ],
    )
    text_pdf(
        ROOT / "oven" / "G-drive" / "suppliers" / "thermo fix services south" / "quote_995.pdf",
        ["Thermo Fix Services South", "Quote 995", "GBP 995", "Never accepted - different company"],
    )
    corrupt = ROOT / "oven" / "G-drive" / "misc" / "old_oven_manual.pdf"
    valid = ROOT / "oven" / "_valid_manual.pdf"
    text_pdf(valid, ["Old oven manual", "This is a different appliance", "Page 1 of 20"])
    put(corrupt, valid.read_bytes()[: int(len(valid.read_bytes()) * 0.6)])
    valid.unlink()


def make_greppable() -> None:
    base = ROOT / "greppable" / "client_docs"
    base.mkdir(parents=True, exist_ok=True)

    presentation = Presentation()

    agenda = presentation.slides.add_slide(presentation.slide_layouts[1])
    agenda.shapes.title.text = "Project agenda"
    agenda.placeholders[1].text = "Phase overview and budget"

    budget = presentation.slides.add_slide(presentation.slide_layouts[1])
    budget.shapes.title.text = "Budget overview"
    budget.placeholders[1].text = "Phase-2 numbers confirmed by client"
    budget.notes_slide.notes_text_frame.text = (
        "SPEAKER NOTES: client confirmed phase-2 budget EUR 180k; see Ref NOTE-180-DELTA. "
        "Do not lose this: the number is only in the notes."
    )

    filler = presentation.slides.add_slide(presentation.slide_layouts[1])
    filler.shapes.title.text = "Appendix"
    filler.placeholders[1].text = "Reserved for supporting material"

    presentation.save(str(base / "kickoff_deck.pptx"))
    patch_hide_slide(base / "kickoff_deck.pptx", 3)

    document = Document()
    document.add_paragraph("Warehouse survey - Meridian Logistics")
    document.add_paragraph("The table below is the authoritative site list.")
    table = document.add_table(rows=1, cols=4)
    for cell, value in zip(table.rows[0].cells, ["Site", "Sqm", "Racking", "Condition"]):
        cell.text = value
    for row in [
        ["North", "4200", "pallet", "good"],
        ["South", "1800", "shelving", "damp"],
        ["East", "2600", "pallet", "fair"],
        ["West", "950-SQM-8831", "shelving", "good"],
    ]:
        cells = table.add_row().cells
        for cell, value in zip(cells, row):
            cell.text = value
    paragraph = document.add_paragraph()
    for chunk in ["Total area ", "SQM-", "8831 confirmed."]:
        paragraph.add_run(chunk)
    add_tracked_change(document, "OLD-AREA-999", "CURRENT-AREA-7742")
    document.save(str(base / "warehouse_survey.docx"))

    workbook = Workbook()
    rates = workbook.active
    rates.title = "2026 rates"
    rates.append(["Role", "Day rate"])
    rates.append(["Consultant", 950])
    rates.append(["Analyst", 620])
    rates.append(["Job", "RATE-2026-774"])
    archive = workbook.create_sheet("2025 archive")
    archive.sheet_state = "hidden"
    archive.append(["Role", "Day rate"])
    archive.append(["Consultant", 880])
    archive.append(["Analyst", 590])
    workbook.save(str(base / "rate_card.xlsx"))

    text_pdf(
        base / "network_map.pdf",
        [
            "Network map text layer",
            "North | Leeds | 2 days",
            "South | Reading | 1 day",
            "FOOTNOTE CROSSDOCK-77: surcharge applies to North only",
        ],
    )
    scan_pdf(base / "appendix_scan.pdf", "APPENDIX SCAN - ref OCR-4471")
    put(
        base / "legacy" / "old_sow.doc",
        b"{\\rtf1\\ansi Statement of Work - RTF bytes despite .doc extension. "
        b"Deliverables: survey, model, final report. Ref RTF-SOW-5567.}",
    )
    put(base / "~$rate_card.xlsx", b"Office lock artifact for rate_card.xlsx. Skip quietly.")


def make_taxpack() -> None:
    base = ROOT / "taxpack" / "photog" / "invoices_issued"
    base.mkdir(parents=True, exist_ok=True)
    text_pdf(
        base / "2024" / "INV-2024-031.pdf",
        ["Invoice INV-2024-031", "Dated 20 December 2024", "GBP 900", "PAID 10 January 2025"],
    )
    amounts = {1: 400, 7: 1800, 11: 1000, 14: 1200}
    for index in range(1, 17):
        amount = amounts.get(index, 400 + ((index - 1) % 12) * 200)
        lines = [
            f"Invoice INV-2025-{index:03d}",
            f"GBP {amount}",
            "Issued 2025. Photography services.",
        ]
        if index == 7:
            lines.append("Ref PHOTO-INV-007-X")
        text_pdf(base / "2025" / f"INV-2025-{index:03d}.pdf", lines)
    text_pdf(
        base / "2025" / "INV-2025-012_eur.pdf",
        ["Invoice INV-2025-012_eur", "EUR 2400", "No exchange rate recorded"],
    )
    text_pdf(
        base / "2025" / "INV-2025-019_DRAFT.pdf",
        ["PROFORMA DRAFT INV-2025-019", "Never sent", "Exclude from issued total"],
    )
    issued_2025 = base / "2025"
    shutil.copy2(issued_2025 / "INV-2025-014.pdf", issued_2025 / "INV-2025-014 (1).pdf")
    scan_pdf(
        ROOT / "taxpack" / "photog" / "expenses" / "gym_receipt_2025.pdf",
        "GYM RECEIPT 2025 - GBP 60 - personal, not a business expense",
    )
    text_pdf(
        ROOT / "taxpack" / "photog" / "expenses" / "gear" / "camera_lens.pdf",
        ["Receipt: camera lens", "GBP 1200", "Ref GEAR-901"],
    )
    text_pdf(
        ROOT / "taxpack" / "photog" / "expenses" / "software_subscription.pdf",
        ["Invoice: photo editing software", "GBP 300", "Annual subscription 2025"],
    )
    text_pdf(
        ROOT / "taxpack" / "photog" / "expenses" / "travel_mileage.pdf",
        ["Expense claim: travel", "GBP 450", "Mileage to client shoots 2025"],
    )
    text_pdf(
        ROOT / "taxpack" / "photog" / "expenses" / "studio_rent.pdf",
        ["Receipt: studio rent", "GBP 800", "Studio hire 2025"],
    )


def make_hostile() -> None:
    base = ROOT / "hostile" / "donations" / "2026-03"
    text_pdf(
        base / "charter_1974.pdf",
        ["LETTERHEAD: Founded 1974", "Objects: preserve local records", "Ref CHARTER-1974"],
    )
    encrypted_pdf(
        base / "minutes_1998-2003.pdf",
        [
            "MINUTES 1998-2003",
            "Election of officers 1998",
            "Archive move 2001; surplus resolution 2003",
            "Ref MINUTES-2003-DELTA",
        ],
        "1974",
    )
    scan_pdf(base / "newspaper_clippings.pdf", "CLIPPING-4471 - page 4 upside down")
    corrupt = base / "flood_damage_report.pdf"
    valid = ROOT / "hostile" / "_valid_flood.pdf"
    text_pdf(valid, ["FLOOD DAMAGE REPORT", "Page 1 of 40", "Ref FLOOD-1998"])
    put(corrupt, valid.read_bytes()[: int(len(valid.read_bytes()) * 0.55)])
    valid.unlink()
    mojibake_file(base / "donor_email_cp1252.txt", "Café résumé — ancien donateur. Naïve façade.")
    text_pdf(base / "photo_album_notes.pdf", ["Photo captions 1974 and 1998", "Album Ref ALBUM-771"])

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Donations"
    sheet.append(["Donor", "Amount", "Date"])
    sheet.append(["Anonymous", 50, "2026-03-05"])
    sheet.append(["J. Smith", 100, "2026-03-12"])
    workbook.save(str(base / "donation_ledger.xlsx"))

    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[1])
    slide.shapes.title.text = "Donation drive update"
    slide.placeholders[1].text = "March 2026 total raised: GBP 150."
    presentation.save(str(base / "donation_update.pptx"))

    document = Document()
    document.add_paragraph("Donation record - March 2026")
    document.add_paragraph("Total raised GBP 150 across two donors.")
    document.save(str(base / "donation_record.docx"))


def backdate_fixtures() -> int:
    """Set a stable, reproducible mtime in early 2026 on every generated file."""
    epoch = datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp()
    files = sorted(path for path in ROOT.rglob("*") if path.is_file())
    for path in files:
        digest = hashlib.sha256(str(path.relative_to(ROOT)).encode("utf-8")).digest()
        seconds = int.from_bytes(digest[:4], "big") % (90 * 86400)
        mtime = epoch + seconds
        os.utime(path, (mtime, mtime))
    return len(files)


if __name__ == "__main__":
    make_oven()
    make_greppable()
    make_taxpack()
    make_hostile()
    count = backdate_fixtures()
    print(f"Generated and backdated {count} extraction fixtures under {ROOT}")
