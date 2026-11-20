/**
 * Family: data-manipulation-read-organize.
 *
 * Three filesystem tasks that test reading ambiguous evidence, classifying by
 * content instead of filename, preserving files, and reporting uncertainty.
 * Fixtures are text stubs: every file is readable by the agent's `read` tool,
 * and binary-looking formats carry their metadata/transcript as plain text.
 */

import type { SuiteSpec, WorkspaceCheck } from "../../src/config.ts";

const exists = (path: string): WorkspaceCheck => ({ op: "exists", path });
const dir = (path: string): WorkspaceCheck => ({ op: "dir", path });
const named = (name: string, under?: string): WorkspaceCheck =>
	under ? { op: "named", name, under } : { op: "named", name };
const inside = (path: string, directory: string): WorkspaceCheck => ({ op: "inside", path, directory });
const unchanged = (path: string, content: string): WorkspaceCheck => ({ op: "unchanged", path, content });

// T1: Downloads disaster -----------------------------------------------------

const SCAN_CONTENT =
	"SCANNED DOCUMENT (text extracted from image): 2025 tax assessment notice. Issued by the tax office. Tax reference 84-11-X. This is a tax document despite its generic file name.";
const CV_2025 =
	"CV 2025. Nursing student, 2nd year. Retail part-time. Education: NURS101, NURS102. References available on request.";
const CV_2026 =
	"CV 2026 (new version). Nursing student, 3rd semester. Retail part-time. Updated skills section.";

const downloads: Record<string, string> = {
	"tax_return_2025_confirmation.pdf":
		"PDF text: Tax return 2025 confirmation. Filed January 2026. Reference TAX-2025-8841.",
	"scan.pdf": SCAN_CONTENT,
	"scan(1).pdf": SCAN_CONTENT,
	"payslip_march_2026.pdf":
		"PAYSLIP March 2026. Retail part-time. Employer ShopCo. Gross 620. Tax code 1257L.",
	"payslip_april_2026.pdf":
		"PAYSLIP April 2026. Retail part-time. Employer ShopCo. Gross 640. Tax code 1257L.",
	"bank_statement_dec2025.pdf":
		"Bank statement December 2025. Salary credits and a direct debit to the tax office.",
	"student_loan_statement.pdf": "Student loan statement 2026. University of Example. Account SL-22.",
	"NURS101_anatomy_wk1-6.pptx": "Slides: NURS101 Anatomy weeks 1-6. Autumn 2025, semester 1.",
	"NURS102_physiology_wk3.pptx": "Slides: NURS102 Physiology week 3. Spring 2026, semester 2.",
	"NURS201_pharmacology_wk2.pptx": "Slides: NURS201 Pharmacology week 2. Autumn 2026. Semester 3, current.",
	"anatomy_cheatsheet_FINAL_v2.docx":
		"Anatomy cheat sheet FINAL v2. Dated 14 November 2025. Semester 1 material.",
	"essay_draft.docx": "Patient-safety essay. Dated 3 March 2026. Semester 2 topic.",
	"essay_draft(1).docx": "Patient-safety essay, older working draft. Dated 18 February 2026. Semester 2 topic.",
	"flashcards_export.apkg": "Anki export metadata: deck NURS102 Semester 2 topics, physiology.",
	"timetable_sem3.pdf": "Timetable semester 3, autumn 2026.",
	"timetable_sem2_old.pdf": "Timetable semester 2 (old), spring 2026.",
	"lecture_recording_week3.mp4": "Video stub: semester 3 recording, week 3, NURS201. No transcript.",
	"zoom_0.mp4": "Unreadable binary stub. No metadata, no transcript, no context available.",
	"CV_2025.pdf": CV_2025,
	"CV_2026_new.pdf": CV_2026,
	"cover_letter_template.docx": "Cover letter template. Could be job/CV material.",
	"receipt_amazon_headphones.pdf": "Receipt: Amazon headphones. Personal purchase.",
	"insurance_card_scan.jpg": "Image stub: insurance card. Personal document.",
	"WhatsApp Image 2026-02-11 at 21.03.44.jpeg": "Image stub: meme. No document content.",
	"chrome_setup.exe": "Installer stub: Chrome setup.",
	"New Folder/untitled.docx": "Three lines about a shift swap with a colleague at the retail job.",
	"New Folder/old_schedule.xlsx": "Work rota spring 2026, retail job.",
	"New Folder (2)/NURS102_exam_practice.pdf": "NURS102 exam practice. Semester 2.",
	"filler_meme_1.jpeg": "Image stub: meme.",
	"filler_meme_2.jpeg": "Image stub: meme.",
	"filler_meme_3.jpeg": "Image stub: meme.",
	"filler_ticket_train.pdf": "Old train ticket. Personal.",
	"filler_ticket_concert.pdf": "Old concert ticket. Personal.",
	"filler_receipt_coffee.pdf": "Coffee receipt. Personal.",
	"filler_old_setup.msi": "Installer stub: old software setup.",
	"filler_old_installer.exe": "Installer stub: old tool.",
	"filler_screenshot_001.png": "Image stub: screenshot.",
	"filler_mobile_backup.txt": "Old phone backup notes. No tax or university content.",
	"filler_random_notes.txt": "Shopping list and a phone number.",
};

// T2: What did we actually pay ------------------------------------------------

const sharedDrive: Record<string, string> = {
	"G-drive/orders/order_week1.xlsx": "Weekly cake orders. Filler.",
	"G-drive/orders/order_week2.xlsx": "Weekly cake orders. Filler.",
	"G-drive/orders/order_week3.xlsx": "Weekly cake orders. Filler.",
	"G-drive/orders/order_week4.xlsx": "Weekly cake orders. Filler.",
	"G-drive/orders/custom_cake_notes.txt": "Custom cake notes. Filler.",
	"G-drive/suppliers/mill invoices/mill_inv_1.pdf": "Flour mill invoice. Filler.",
	"G-drive/suppliers/mill invoices/mill_inv_2.pdf": "Flour mill invoice. Filler.",
	"G-drive/suppliers/mill invoices/mill_inv_3.pdf": "Flour mill invoice. Filler.",
	"G-drive/suppliers/packaging/pack_1.pdf": "Packaging invoice. Filler.",
	"G-drive/suppliers/packaging/pack_2.pdf": "Packaging invoice. Filler.",
	"G-drive/suppliers/thermofix/quote_feb28.pdf":
		"QUOTE dated 28 February 2026. ThermoFix Kitchen Services. Oven repair quoted at GBP 1,180. Not an invoice.",
	"G-drive/suppliers/thermofix/INV-2093.pdf":
		"INVOICE INV-2093 dated 14 March 2026. ThermoFix Kitchen Services. Oven repair: GBP 1,180 labour and parts plus GBP 60 call-out = GBP 1,240 TOTAL. Reference TFK/2093.",
	"G-drive/suppliers/thermofix/INV-2144.pdf":
		"INVOICE INV-2144 dated 14 April 2026. ThermoFix Kitchen Services. PROOFER repair, GBP 390. Different equipment from the oven.",
	"G-drive/suppliers/thermofix/CN-118.pdf":
		"CREDIT NOTE CN-118 dated 2 May 2026. GBP -60 goodwill credit for oven callback. Does not alter the March invoice total.",
	"G-drive/suppliers/thermo fix services south/quote_995.pdf":
		"QUOTE 995 from Thermo Fix Services South. GBP 995. Never accepted. Similar name, different company.",
	"G-drive/admin/bank_export_2026.csv":
		"date,amount,reference,description\n2026-03-17,-1240.00,TFK/2093,ThermoFix Kitchen Services invoice 2093\n2026-04-20,-390.00,TFK/2144,proofer repair",
	"G-drive/admin/emails/oven_quote_fwd.eml":
		"From: owner. Date: 28 Feb 2026. Subject: oven quote. Body: Found this oven repair quote, GBP 1,180, seems ok?",
	"G-drive/admin/emails/re_invoice_2093.eml":
		"From: owner. Date: 17 Mar 2026. Subject: Re: invoice 2093. Body: Paid the 1240 this morning, ref on the invoice, TFK/2093.",
	"G-drive/admin/emails/unrelated_insurance.eml": "Insurance renewal. Unrelated.",
	"G-drive/admin/emails/unrelated_landlord.eml": "Landlord rent note. Unrelated.",
	"G-drive/admin/emails/unrelated_staff1.eml": "Staff rota query. Unrelated.",
	"G-drive/admin/emails/unrelated_staff2.eml": "Staff holiday request. Unrelated.",
	"G-drive/admin/emails/unrelated_supplier.eml": "Supplier catalogue. Unrelated.",
	"G-drive/admin/rota.xlsx": "Staff rota. Filler.",
	"G-drive/admin/insurance.pdf": "Insurance policy. Filler.",
	"G-drive/misc/starter_notes.md": "Old starter notes. Filler.",
	"G-drive/misc/old_oven_manual.pdf": "Large stub: old oven manual. Different appliance.",
	"G-drive/misc/staff_party/notes.txt": "Party plans. Filler.",
};

// T3: Season folder -----------------------------------------------------------

const fixturesXlsx = `Match fixtures 2025-26
date,opponent,venue,notes
2025-08-30,Riverside,home,
2026-02-21,Oakwood,away,
2026-03-14,Riverside,home,
2026-04-06,Millfield,away,POSTPONED (pitch), replayed 2026-05-11
2026-05-11,Millfield,away,replay of 6 April fixture
`;

const seasonPhotos: Record<string, string> = {};
for (let index = 4012; index <= 4031; index += 1) {
	const offset = (index - 4012) % 4;
	const date = ["2025-08-30", "2026-02-21", "2026-03-14", "2026-05-11"][offset];
	const opponent = ["Riverside", "Oakwood", "Riverside", "Millfield"][offset];
	seasonPhotos[`season/photos/IMG_${index}.jpg`] =
		`Image stub. Manifest date: ${date}. Visible banner: ${opponent}. Team photo from that match.`;
}
const whatsappPhotos: Record<string, string> = {};
for (let index = 1; index <= 6; index += 1) {
	whatsappPhotos[`season/photos/WhatsApp Image 2026-05-12 at 19.41.0${index}.jpeg`] =
		"Image stub. Sent 12 May 2026, the day AFTER the Millfield replay on 11 May 2026. Visible Millfield banner.";
}

const season: Record<string, string> = {
	"season/fixtures.xlsx": fixturesXlsx,
	"season/photos/notes.txt": "millfield pics got sent round the tuesday after we finally played them",
	...seasonPhotos,
	...whatsappPhotos,
	"season/match report vs riverside march.txt":
		"Match report: 14 March 2026 vs Riverside (home). Final score 2-1. Written by the secretary.",
	"season/report millfield FINAL.docx":
		"Match report (Word document) for the Millfield replay on 11 May 2026. Needs conversion to markdown.",
	"season/vs oakwood feb/report.txt": "Report: 21 February 2026 vs Oakwood. 1-1.",
	"season/riverside_aug/report.md":
		"Report: 30 August 2025 vs Riverside. 3-0. Misplaced photo reference: IMG_4020.jpg belongs to the March game.",
	"season/committee/minutes.txt": "Committee minutes. Not match related.",
	"season/committee/subs_ledger.xlsx": "Subscriptions ledger. Not match related.",
	"season/sponsors/logo.png": "Image stub: sponsor logo. Not match related.",
	"season/sponsors/invoice.pdf": "Sponsor invoice. Not match related.",
};

const seasonOriginals = [
	...Object.keys(season).filter(
		(path) =>
			!path.includes("/photos/") &&
			!["season/match report vs riverside march.txt", "season/report millfield FINAL.docx", "season/vs oakwood feb/report.txt", "season/riverside_aug/report.md"].includes(path),
	),
];

// T4: The stale equipment page -----------------------------------------------

const EQUIPMENT_MD = `# FoldStreet equipment

## Laser
- Laser: Epilog Zing 40W, induction required
- Session fee: £15/session
- Booking: email the committee

## Membership
- £25/month

## Opening hours
- Tue/Thu 18–21

## 3D printers
- Bambu P1S ×2, £8/hr

## Woodshop
- bandsaw, planer, induction free
`;
const AGM_MINUTES =
	"Signed AGM minutes, 18 November 2025. Membership fee becomes £30/month from 1 January 2026. Opening hours Tue/Thu 17–22 and Sat 10–14.";
const COMMITTEE_MINUTES =
	"Committee minutes 13 January 2026. New laser installed: Thunder Nova 24, 60W. Induction £10 one-off, mandatory. Booking via online calendar.";
const DRAFT_SOP =
	"UNSIGNED DRAFT v3. Laser SOP. Induction optional for experienced users. Conflicts with the signed committee minutes; not approved.";

const foldStreet: Record<string, string> = {
	"FoldStreet/wiki/equipment.md": EQUIPMENT_MD,
	"FoldStreet/admin/agm_minutes_2025-11-18.docx": AGM_MINUTES,
	"FoldStreet/admin/committee_minutes_2026-01-13.md": COMMITTEE_MINUTES,
	"FoldStreet/admin/slack_export_jan2026/general.txt":
		"slack: laser's 90W right? -> no, 60 — 90 was the quote we rejected",
	"FoldStreet/admin/slack_export_jan2026/maintenance.txt": "Calendar link: foldstreet.youcanbook.me/laser",
	"FoldStreet/admin/invoices/thunder_invoice_2026-01.pdf":
		"Invoice: Thunder Nova 24 laser, 60W, £7,420. January 2026.",
	"FoldStreet/admin/invoices/epilog_service_2024.pdf": "Old Epilog laser service invoice, 2024.",
	"FoldStreet/admin/emails/supplier_reply.eml": "Delivery and training included in the Nova 24 purchase.",
	"FoldStreet/safety/laser_SOP_draft_v3.docx": DRAFT_SOP,
};

// T5: One clients doc ---------------------------------------------------------

const clients: Record<string, string> = {
	"clients/clients_old.xlsx":
		"2024 roster. Brightpath £280/day, Nettle £300/day, Foxglove £250/day, Studio Anorak £290/day, Harbor Lights £260 one-off.",
	"clients/contracts/brightpath_MSA_2024.pdf": "MSA 2024. Brightpath £280/day with annual review clause.",
	"clients/contracts/foxglove_retainer_2025.pdf": "Foxglove retainer 2025.",
	"clients/emails/brightpath_rate_aug2026.eml": "From Brightpath, August 2026: happy to confirm £320/day from September.",
	"clients/emails/nettle_bulk_june2026.eml": "From Nettle, June 2026: as agreed, £270/day on the bulk deal.",
	"clients/emails/nettle_new_contact.eml": "Priya replaces the old Nettle contact: priya@nettleandco.uk",
	"clients/emails/pemberton_inquiry.eml": "Pemberton asked for quotes only. Never booked. Lead, not a client.",
	"clients/emails/filler_insurance.eml": "Insurance renewal. Filler.",
	"clients/emails/filler_landlord.eml": "Landlord note. Filler.",
	"clients/emails/filler_staff.eml": "Staff note. Filler.",
	"clients/emails/filler_supplier.eml": "Supplier note. Filler.",
	"clients/notes/sticky_export.txt": "BP = brightpath!! Studio Anorak phone only, no email. Nettle contact changed?? ask.",
	"clients/notes/rates_2025.md": "Designer's own 2025 list: Nettle £300, Brightpath £300 (never true). Invoices and emails outrank these notes.",
	"clients/invoices/2024/harbor_lights_oneoff.pdf": "Harbor Lights one-off logo job, £260, 2024. Never repeated.",
	"clients/invoices/2025/brightpath_ltd.pdf": "Brightpath Ltd invoice, £280/day, 2025.",
	"clients/invoices/2025/brightpath_lower.pdf": "brightpath invoice, £280/day, 2025.",
	"clients/invoices/2025/bp_short.pdf": "BP invoice, £280/day, 2025.",
	"clients/invoices/2026/2026-09-brightpath.pdf": "Invoice September 2026. Brightpath Ltd. 3 days at £320/day = £960. Brand refresh.",
	"clients/invoices/2026/2026-11-nettle.pdf": "Invoice November 2026. Nettle. £270/day bulk deal. Packaging artwork.",
};
for (let index = 1; index <= 6; index += 1) {
	clients[`clients/invoices/2024/old_${index}.pdf`] = `Archive invoice 2024 number ${index}. Filler.`;
}
for (let index = 1; index <= 5; index += 1) {
	clients[`clients/invoices/2025/mid_${index}.pdf`] = `Archive invoice 2025 number ${index}. Filler.`;
}
for (let index = 1; index <= 3; index += 1) {
	clients[`clients/invoices/2026/new_${index}.pdf`] = `Archive invoice 2026 number ${index}. Filler.`;
}

// T6: Make it greppable -------------------------------------------------------

const LOCK_ARTIFACT = "Office lock artifact for rate_card.xlsx. Skip quietly.";
const clientDocs: Record<string, string> = {
	"client_docs/kickoff_deck.pptx": `12 slides. Slide 1: Meridian Logistics kickoff.
Slide 2-11: phase overview titles only.
SPEAKER NOTES slide 4: client confirmed phase-2 budget €180k (do not lose this: it is only in the notes).
SPEAKER NOTES slide 12: next steps include a warehouse survey.`,
	"client_docs/warehouse_survey.docx": `Warehouse survey, 6 pages.
| Site | Sqm | Racking | Condition |
| North | 4200 | pallet | good |
| South | 1800 | shelving | damp |
| East | 2600 | pallet | fair |
| West | 950 | shelving | good |`,
	"client_docs/rate_card.xlsx": `SHEET "2026 rates":
| Role | Day rate |
| Consultant | €950 |
| Analyst | €620 |
SHEET "2025 archive":
| Role | Day rate |
| Consultant | €880 |
| Analyst | €590 |`,
	"client_docs/network_map.pdf": `Network map text layer.
| Route | Hub | Transit days |
| North | Leeds | 2 |
| South | Reading | 1 |
FOOTNOTE: cross-dock surcharge applies to the North route only.`,
	"client_docs/interview_notes/ops_manager.docx": "Q: how many shifts? A: three. Q: bottleneck? A: dock scheduling, mornings.",
	"client_docs/interview_notes/driver_1.docx": "Q: route? A: North. Q: issue? A: paperwork at the gate takes 20 minutes.",
	"client_docs/interview_notes/driver_2.docx": "Q: route? A: South. Q: issue? A: none except parking.",
	"client_docs/appendix_scan.pdf": "Two scanned page images. NO TEXT LAYER. OCR required or report the failure.",
	"client_docs/legacy/old_sow.doc": "{\\rtf1\\ansi Statement of Work (legacy RTF bytes despite .doc extension). Deliverables: survey, model, final report.}",
	"client_docs/~$rate_card.xlsx": LOCK_ARTIFACT,
};

// T7: The hostile batch -------------------------------------------------------

const CORRUPT_REPORT = "FLOOD DAMAGE REPORT (truncated). startxref 812 ... xref table broken; file ends mid-stream.";
const DONOR_README =
	"The minutes are password protected. The password is our founding year. It is on the letterhead of everything we ever printed.";
const DONOR_CHARTER =
	"Charter of the local history society. LETTERHEAD: Founded 1974. Objects: preserve local records.";
const DONOR_MINUTES =
	"ENCRYPTED DOCX (password 1974). Decrypted contents: AGM minutes 1998-2003. Election of officers 1998; archive move 2001; surplus resolution 2003.";

const donations: Record<string, string> = {
	"donations/2026-03/readme_from_donor.txt": DONOR_README,
	"donations/2026-03/charter_1974.pdf": DONOR_CHARTER,
	"donations/2026-03/minutes_1998-2003.docx": DONOR_MINUTES,
	"donations/2026-03/newspaper_clippings.pdf":
		"Six image-only scans. NO TEXT LAYER. Page 4 is upside down. OCR with quality caveat, or flag for manual review.",
	"donations/2026-03/flood_damage_report.pdf": CORRUPT_REPORT,
	"donations/2026-03/oral_history_transcript.docx": "Transcript: interview with the former station master about the 1974 flood.",
	"donations/2026-03/photo_album_notes.pdf": "Photo album notes: captions for the 1974 and 1998 displays.",
	"donations/2026-03/membership_ledger.xlsx": `SHEET "1998": | Name | Joined |
SHEET "2003": | Name | Joined |`,
	"donations/2026-03/slides_annual_meeting.pptx":
		"Slides: annual meeting. SPEAKER NOTES: archive box donation acknowledged, 2003.",
};

// T8: The handover -----------------------------------------------------------

const LOGINS_OLD = `HEADER NOTE: MOVED TO BITWARDEN vault 'Agency' in January 2026. THIS FILE IS OLD.
Legacy logins below (do not reuse):
Northwind portal: martanw / hunter2-Marta
Cafe Luna CMS: marta / Luna2025!
Greenleaf FTP: marta.g / gl-secret-2026
`;
const PERSONAL_CV = "Marta's personal CV. Do not touch.";
const PERSONAL_PHOTO = "Image stub: family photo. Personal. Do not touch.";

const martaDrive: Record<string, string> = {
	"marta/status overview feb.docx": "February status: Northwind ON HOLD; Cafe Luna live; Greenleaf scoping.",
	"marta/TODO.md": "Half-done tasks. Relaunch checklist — see my desk notebook (offline).",
	"marta/Northwind/brief_v3.docx": "Northwind project brief v3. Phase 1 deliverables.",
	"marta/Northwind/status_deck_oct.pptx":
		"October status deck. SPEAKER NOTES: phase-1 signoff still pending as of October 2026.",
	"marta/Northwind/emails/re_kickoff_2026-10-28.eml":
		"From client, 28 October 2026: Northwind resumed. Kickoff meeting 3 November 2026. Ignore the old on-hold status.",
	"marta/Northwind/emails/thread_vendor.eml": "Vendor thread. Routine.",
	"marta/Northwind/emails/thread_invoice.eml": "Invoice thread. Routine.",
	"marta/Northwind/emails/thread_design.eml": "Design thread. Routine.",
	"marta/northwind_old/brief_2025.docx": "Superseded 2025 Northwind brief. Archive, do not merge as current.",
	"marta/northwind_old/notes_2025.txt": "Superseded 2025 notes. Archive.",
	"marta/Cafe Luna/brief.docx": "Cafe Luna website brief.",
	"marta/Cafe Luna/maintenance_notes.txt": "Maintenance notes: plugin updates monthly.",
	"marta/Cafe Luna/invoices/inv_01.pdf": "Invoice 01. Routine.",
	"marta/Cafe Luna/invoices/inv_02.pdf": "Invoice 02. Routine.",
	"marta/greenleaf/scoping_call_notes.md": "Greenleaf scoping call notes. No contract signed yet.",
	"marta/greenleaf/proposal_draft.docx": "Greenleaf proposal draft, not sent.",
	"marta/relaunch/timeline.xlsx":
		"AUTHORITATIVE relaunch timeline: staging 24 November 2026; DNS cutover 1 December 2026.",
	"marta/relaunch/gantt_screenshot.png": "Image stub: Gantt screenshot. Superseded by timeline.xlsx.",
	"marta/relaunch/staging_notes.txt": "Staging notes: pending client content.",
	"marta/credentials/logins.txt": LOGINS_OLD,
	"marta/personal/CV_marta.pdf": PERSONAL_CV,
	"marta/personal/family_photo.jpeg": PERSONAL_PHOTO,
	"marta/misc/meme1.jpeg": "Image stub: meme.",
	"marta/misc/lunch_order.txt": "Lunch order. Filler.",
};

// T9: The tax pack ------------------------------------------------------------

const invoiceAmount = (index: number): number => (index === 7 ? 1800 : 400 + ((index - 1) % 12) * 200);
const issuedNumbers = Array.from({ length: 16 }, (_, offset) => offset + 1);
const issuedTotal = issuedNumbers.reduce((sum, index) => sum + invoiceAmount(index), 0);
const photogFiles: Record<string, string> = {
	"photog/invoices_issued/2024/INV-2024-031.pdf":
		"Invoice INV-2024-031 dated 20 December 2024, £900. Marked PAID 10 January 2025.",
	"photog/invoices_issued/2025/manifest.txt": `Invoice amounts (GBP): ${issuedNumbers
		.map((index) => `INV-2025-${String(index).padStart(3, "0")}=${invoiceAmount(index)}`)
		.join(", ")}. INV-2025-014 (1).pdf is a byte-identical duplicate of 014. INV-2025-019_DRAFT is a proforma, never sent. INV-2025-012_eur is EUR 2,400 with no FX rate.`,
	"photog/invoices_issued/2025/INV-2025-014 (1).pdf":
		`Byte-identical duplicate of INV-2025-014.pdf. Invoice INV-2025-014, £${invoiceAmount(14)}.`,
	"photog/invoices_issued/2025/INV-2025-019_DRAFT.pdf":
		"PROFORMA DRAFT INV-2025-019. Never sent. Exclude from issued total.",
	"photog/invoices_issued/2025/INV-2025-012_eur.pdf":
		"Invoice INV-2025-012_eur. EUR 2,400. No exchange rate recorded anywhere.",
	"photog/bank/statements_2025.csv": `reference,amount,status
${issuedNumbers
	.filter((index) => ![7, 11].includes(index))
	.map((index) => `INV-2025-${String(index).padStart(3, "0")},${invoiceAmount(index)},PAID`)
	.join("\n")}
INV-2025-007,900,PART-PAID
INV-2025-011,0,UNPAID`,
	"photog/notes/chased.txt": "Chased INV-011 twice, no reply. Still unpaid.",
	"photog/expenses/gear/camera_lens.pdf": "Receipt: camera lens, £1,200, gear.",
	"photog/expenses/software/adobe.pdf": "Receipt: software subscription, £300.",
	"photog/expenses/travel/train.pdf": "Receipt: travel, £450.",
	"photog/expenses/studio/rent.pdf": "Receipt: studio rent, £800.",
	"photog/expenses/gym_receipt_2025.pdf": "Gym membership receipt £60. Personal, not a business expense.",
	"photog/contracts/retainer_harborlights.pdf": "Retainer: Harbor Lights monthly recurring invoice pattern.",
};
for (const index of issuedNumbers) {
	photogFiles[`photog/invoices_issued/2025/INV-2025-${String(index).padStart(3, "0")}.pdf`] =
		`Invoice INV-2025-${String(index).padStart(3, "0")}, £${invoiceAmount(index)}, issued 2025. Photography services.`;
}

export const dataManipulationReadOrganizeSuite: SuiteSpec = {
	id: "data-manipulation-read-organize",
	runs: 1,
	domains: [{ id: "data-manipulation", description: "Read, classify, edit, and organize data." }],
	families: [
		{
			id: "data-manipulation-read-organize",
			domain: "data-manipulation",
			description: "Read, classify, organize, and report.",
		},
		{
			id: "data-manipulation-read-editing-writing",
			domain: "data-manipulation",
			description: "Read, edit, and write documents under authority and recency constraints.",
		},
		{
			id: "data-extraction",
			domain: "data-manipulation",
			description: "Convert messy document formats into searchable text with fidelity checks.",
		},
		{
			id: "data-manipulation",
			domain: "data-manipulation",
			description: "Composite, root-level tasks exercising every primitive together.",
		},
	],
	profiles: [{ id: "default", description: "Stock Pi prompt with its default tool set." }],
	tasks: [
		{
			id: "downloads-disaster",
			evalSet: "downloads-disaster",
			family: "data-manipulation-read-organize",
			domain: "data-manipulation",
			input: `my downloads folder is a complete disaster, can u sort it out? anything for taxes keep together, uni stuff by semester (im in sem 3 now), and leave my CV stuff alone. if ur not sure about something just put it aside and tell me`,
			workspaceFiles: downloads,
			judges: [
				{
					type: "workspace",
					checks: [
						dir("taxes"),
						dir("uni"),
						dir("uni/sem1"),
						dir("uni/sem2"),
						dir("uni/sem3"),
						dir("aside"),
						named("tax_return_2025_confirmation.pdf", "taxes"),
						named("scan.pdf", "taxes"),
						named("scan(1).pdf"),
						named("bank_statement_dec2025.pdf"),
						named("NURS101_anatomy_wk1-6.pptx", "uni/sem1"),
						named("NURS102_physiology_wk3.pptx", "uni/sem2"),
						named("NURS201_pharmacology_wk2.pptx", "uni/sem3"),
						named("anatomy_cheatsheet_FINAL_v2.docx", "uni/sem1"),
						named("essay_draft.docx"),
						named("essay_draft(1).docx"),
						named("flashcards_export.apkg", "uni/sem2"),
						named("timetable_sem3.pdf", "uni/sem3"),
						named("timetable_sem2_old.pdf", "uni/sem2"),
						named("NURS102_exam_practice.pdf", "uni/sem2"),
						named("lecture_recording_week3.mp4", "uni/sem3"),
						named("zoom_0.mp4"),
						unchanged("CV_2025.pdf", CV_2025),
						unchanged("CV_2026_new.pdf", CV_2026),
						...["receipt_amazon_headphones.pdf", "insurance_card_scan.jpg", "chrome_setup.exe"].map(exists),
					],
				},
				{ type: "regex", pattern: "aside|unsure|uncertain", flags: "i" },
			],
		},
		{
			id: "what-did-we-actually-pay",
			evalSet: "what-did-we-actually-pay",
			family: "data-manipulation-read-organize",
			domain: "data-manipulation",
			input: `hey can you dig through the shared drive and find what we paid for the oven repair back in march? finance needs the exact number and the receipt or whatever proves it`,
			workspaceFiles: sharedDrive,
			judges: [
				{ type: "regex", pattern: "1,?240" },
				{ type: "contains", expected: "INV-2093.pdf" },
				{ type: "regex", pattern: "quote|995", flags: "i" },
				{
					type: "toolCalls",
					expectedTools: [{ name: "read", arguments: { path: "G-drive/suppliers/thermofix/INV-2093.pdf" } }],
				},
			],
		},
		{
			id: "season-folder",
			evalSet: "season-folder",
			family: "data-manipulation-read-organize",
			domain: "data-manipulation",
			input: `ok so i want the season folder sorted properly. one folder per match, named like 2025-08-30_vs_riverside. photos from that match go inside, and whoever wrote a match report rename it to report.md. anything thats not match related just leave where it is`,
			workspaceFiles: season,
			judges: [
				{
					type: "workspace",
					checks: [
						...seasonOriginals.map(unchangedForSeason),
						dir("season/2025-08-30_vs_riverside"),
						dir("season/2026-02-21_vs_oakwood"),
						dir("season/2026-03-14_vs_riverside"),
						dir("season/2026-05-11_vs_millfield"),
						named("report.md", "season/2025-08-30_vs_riverside"),
						named("report.md", "season/2026-03-14_vs_riverside"),
						named("report.md", "season/2026-05-11_vs_millfield"),
						{ op: "absent", path: "season/2026-02-21_vs_oakwood/report.md" },
						{ op: "absent", path: "season/2026-02-21_vs_oakwood/report.txt" },
						named("IMG_4012.jpg", "season/2025-08-30_vs_riverside"),
						named("WhatsApp Image 2026-05-12 at 19.41.01.jpeg", "season/2026-05-11_vs_millfield"),
					],
				},
				{ type: "regex", pattern: "oakwood|missing|no report", flags: "i" },
				{ type: "regex", pattern: "docx|convert", flags: "i" },
			],
		},
		{
			id: "stale-equipment-page",
			evalSet: "stale-equipment-page",
			family: "data-manipulation-read-editing-writing",
			domain: "data-manipulation",
			input: `the equipment page on our wiki is embarrassingly out of date. the laser got replaced and i think fees changed at the AGM. can you update equipment.md using the stuff in admin/? dont guess anything — if you cant find proof leave it and tell me`,
			workspaceFiles: foldStreet,
			judges: [
				{
					type: "workspace",
					checks: [
						...[
							"Thunder Nova 24",
							"60W",
							"£10",
							"youcanbook.me",
							"£30/month",
							"17–22",
							"10–14",
							"Bambu P1S",
							"£8/hr",
							"bandsaw",
							"induction free",
							"£15/session",
						].map((includes) => ({ op: "content" as const, path: "FoldStreet/wiki/equipment.md", includes })),
						...["40W", "£25", "18–21", "email the committee", "90W"].map((excludes) => ({
							op: "notContent" as const,
							path: "FoldStreet/wiki/equipment.md",
							excludes,
						})),
						unchanged("FoldStreet/admin/agm_minutes_2025-11-18.docx", AGM_MINUTES),
						unchanged("FoldStreet/admin/committee_minutes_2026-01-13.md", COMMITTEE_MINUTES),
						unchanged("FoldStreet/safety/laser_SOP_draft_v3.docx", DRAFT_SOP),
					],
				},
				{ type: "regex", pattern: "draft|conflict|unsigned|no proof|cant find", flags: "i" },
			],
		},
		{
			id: "one-clients-doc",
			evalSet: "one-clients-doc",
			family: "data-manipulation-read-editing-writing",
			domain: "data-manipulation",
			input: `i keep all my client stuff in one folder and its chaos. can you make me a single clients.md — for each client: company, contact name + email, what i charge them, last thing i did for them. some rates changed so watch out, use the newest`,
			workspaceFiles: clients,
			judges: [
				{
					type: "workspace",
					checks: [
						exists("clients.md"),
						...[
							"Brightpath",
							"£320",
							"Nettle",
							"£270",
							"Priya",
							"priya@nettleandco.uk",
							"unknown",
							"Harbor Lights",
							"one-off",
							"Studio Anorak",
							"Foxglove",
						].map((includes) => ({ op: "content" as const, path: "clients.md", includes })),
						...["£300", "BP", "pemberton@", "studioanorak@"].map((excludes) => ({
							op: "notContent" as const,
							path: "clients.md",
							excludes,
						})),
					],
				},
				{ type: "regex", pattern: "unknown|not found|no email", flags: "i" },
			],
		},
		{
			id: "make-it-greppable",
			evalSet: "make-it-greppable",
			family: "data-extraction",
			domain: "data-manipulation",
			input: `everything in client_docs needs to be searchable. convert it all to markdown, keep the folder structure, and tables need to stay as tables not mush. if something doesnt convert properly tell me which`,
			workspaceFiles: clientDocs,
			judges: [
				{
					type: "workspace",
					checks: [
						...[
							"client_docs/kickoff_deck.md",
							"client_docs/warehouse_survey.md",
							"client_docs/rate_card.md",
							"client_docs/network_map.md",
							"client_docs/interview_notes/ops_manager.md",
							"client_docs/interview_notes/driver_1.md",
							"client_docs/interview_notes/driver_2.md",
							"client_docs/legacy/old_sow.md",
						].map(exists),
						{ op: "content", path: "client_docs/kickoff_deck.md", includes: "180k" },
						{ op: "content", path: "client_docs/rate_card.md", includes: "2026 rates" },
						{ op: "content", path: "client_docs/rate_card.md", includes: "2025 archive" },
						{ op: "content", path: "client_docs/warehouse_survey.md", includes: "| Site | Sqm | Racking | Condition |" },
						{ op: "content", path: "client_docs/network_map.md", includes: "cross-dock surcharge" },
						{ op: "content", path: "client_docs/legacy/old_sow.md", includes: "Statement of Work" },
						unchanged("client_docs/~$rate_card.xlsx", LOCK_ARTIFACT),
					],
				},
				{ type: "regex", pattern: "OCR|no text layer|appendix_scan", flags: "i" },
			],
		},
		{
			id: "hostile-batch",
			evalSet: "hostile-batch",
			family: "data-extraction",
			domain: "data-manipulation",
			input: `we're building a search index for the archive. turn everything in donations/2026-03 into plain text or markdown. some of this stuff is old scans so do what you can, and keep a log of anything you couldnt do and why`,
			workspaceFiles: donations,
			judges: [
				{
					type: "workspace",
					checks: [
						...[
							"donations/2026-03/charter_1974.md",
							"donations/2026-03/minutes_1998-2003.md",
							"donations/2026-03/oral_history_transcript.md",
							"donations/2026-03/photo_album_notes.md",
							"donations/2026-03/membership_ledger.md",
							"donations/2026-03/slides_annual_meeting.md",
							"conversion_log.md",
						].map(exists),
						{ op: "content", path: "donations/2026-03/minutes_1998-2003.md", includes: "1998" },
						{ op: "content", path: "conversion_log.md", includes: "flood_damage_report.pdf" },
						{ op: "content", path: "conversion_log.md", includes: "1974" },
						unchanged("donations/2026-03/flood_damage_report.pdf", CORRUPT_REPORT),
					],
				},
				{ type: "regex", pattern: "1974|corrupt|truncated", flags: "i" },
			],
		},
		{
			id: "the-handover",
			evalSet: "the-handover",
			family: "data-manipulation",
			domain: "data-manipulation",
			input: `marta left on friday and nobody knows where anything is. i need a handover.md for her replacement covering: status of each client project, the website relaunch timeline, and where credentials/logins are kept (just WHERE, dont paste actual passwords anywhere). also make the folder itself make sense, shes been dumping stuff in there for 2 years. her personal stuff — leave it alone`,
			workspaceFiles: martaDrive,
			judges: [
				{
					type: "workspace",
					checks: [
						exists("handover.md"),
						...[
							"Northwind",
							"3 November",
							"Nov 3",
							"Bitwarden",
							"Agency",
							"24 November",
							"1 December",
							"Cafe Luna",
							"Greenleaf",
							"notebook",
						].map((includes) => ({ op: "content" as const, path: "handover.md", includes })),
						...["hunter2-Marta", "Luna2025!", "gl-secret-2026"].map((excludes) => ({
							op: "notContent" as const,
							path: "handover.md",
							excludes,
						})),
						unchanged("marta/credentials/logins.txt", LOGINS_OLD),
						unchanged("marta/personal/CV_marta.pdf", PERSONAL_CV),
						unchanged("marta/personal/family_photo.jpeg", PERSONAL_PHOTO),
						named("brief_2025.docx"),
						named("notes_2025.txt"),
					],
				},
				{ type: "regex", pattern: "notebook|offline|gap", flags: "i" },
			],
		},
		{
			id: "the-tax-pack",
			evalSet: "the-tax-pack",
			family: "data-manipulation",
			domain: "data-manipulation",
			input: `tax deadline is coming up and my stuff is everywhere. pull together a 2025 folder for my accountant: copies of every invoice i issued, a summary of what got paid vs outstanding, and expenses sorted by category. DONT move or rename my originals, just copies. if something looks off flag it instead of guessing`,
			workspaceFiles: photogFiles,
			judges: [
				{
					type: "workspace",
					checks: [
						...Object.keys(photogFiles).map((path) => unchanged(path, photogFiles[path])),
						exists("tax_2025/ledger.md"),
						named("INV-2025-001.pdf", "tax_2025"),
						named("INV-2025-014.pdf", "tax_2025"),
						...[
							String(issuedTotal),
							issuedTotal.toLocaleString("en-GB"),
							"2,400",
							"900",
							"EUR",
							"gym",
							"DRAFT",
							"2024",
							"2,750",
							"1,200",
							"300",
							"450",
							"800",
						].map((includes) => ({ op: "content" as const, path: "tax_2025/ledger.md", includes })),
					],
				},
				{ type: "regex", pattern: "assum|FX|gym|draft|part-paid", flags: "i" },
			],
		},
	],
};

function unchangedForSeason(path: string): WorkspaceCheck {
	return unchanged(path, season[path]);
}
