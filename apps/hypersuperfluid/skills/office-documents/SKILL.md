---
name: office-documents
description: Creating and editing Word, Excel, PowerPoint and PDF files, and UML and other diagrams, then checking the result. Load before producing or changing any office document or diagram.
---

# Office documents

## Pick the right tool

| Work | Use |
|---|---|
| Word (.docx) | The `office-docx` skill when listed; otherwise python-docx |
| Excel (.xlsx) | The `office-xlsx` skill when listed; otherwise openpyxl, or XlsxWriter for new files with charts |
| PowerPoint (.pptx) | The `office-pptx` skill when listed; otherwise python-pptx |
| Export to PDF, recalculate formulas, render pages to images | `office-export-pdf`, `office-recalculate`, `office-render` when listed (LibreOffice) |
| PDF editing | `office_tools` action `setup`, then its `pdf_tool.py` |
| UML and other diagrams | Write Graphviz DOT or PlantUML, then `office_tools` action `render` |

When `load_workspace_dependencies` is listed, it returns a bundled Python with python-docx, python-pptx, openpyxl, XlsxWriter, pandas and Pillow: use that interpreter for Word, Excel and PowerPoint scripts instead of installing anything. `office_tools` `setup` returns a second interpreter, with pypdf, pdfplumber, reportlab and matplotlib, for PDFs and charts.

Name scripts for their job (`build_report.py`) and never `docx.py`, `inspect.py` or another name that shadows a library.

## Rules for every file

1. Work on a copy unless asked to change the file in place. Never overwrite the only copy of someone's document.
2. Keep what you were not asked to change: styles, headers, footers, numbering, named ranges, formulas, slide masters.
3. Spreadsheets hold formulas, not pasted results, wherever the person would expect a formula. Totals use `SUM`, not a number you computed.
4. After saving, check the file: reopen it with the library and assert the content, and when a render skill is listed, render a page or slide to an image and look at it.
5. Report every file you produced with its full path.

## Word

- Use real heading styles (`Heading 1`, `Heading 2`) so the navigation pane and a table of contents work.
- Tables: set a style and header row; keep column widths readable.
- A template from the person beats any default: open it and add content to it rather than building styling by hand.
- python-docx does not paginate. For page-exact output, export to PDF and render it.

## Excel

- One table per sheet with a header row; freeze the header pane; set number formats (dates, currency, percent) on the cells.
- Charts: XlsxWriter for new workbooks; openpyxl to add to existing ones.
- After writing formulas with openpyxl, values are not computed until a spreadsheet application recalculates: use `office-recalculate` when listed before reading values back.
- Large data: write with pandas `to_excel` and then format.

## PowerPoint

- Start from the person's template or the default layouts; use placeholders instead of free text boxes so layouts stay consistent.
- One idea per slide, a short title, at most six bullets; put detail in the notes.
- Images: keep aspect ratio; charts: native charts when the person may edit the data, images otherwise.

## PDF

`"<python>" "<pdf_tool.py>" --help` lists the commands. The common ones:

```text
info IN.pdf                          pages, metadata, form fields
text IN.pdf --pages 1-3              extract text
tables IN.pdf OUT_DIR                tables to CSV
merge OUT.pdf A.pdf B.pdf            combine
pages IN.pdf OUT.pdf 3,1-2           extract and reorder
rotate IN.pdf OUT.pdf 90 --pages 2   rotate
delete IN.pdf OUT.pdf 4              remove pages
watermark IN.pdf OUT.pdf "DRAFT"     stamp every page
fields IN.pdf / fill IN.pdf OUT.pdf values.json    forms
encrypt / decrypt IN.pdf OUT.pdf --password-env NAME
images OUT.pdf a.png b.jpg           images to one PDF
compress IN.pdf OUT.pdf
```

Passwords come from an environment variable, never the command line. Scanned PDFs have no text layer: say so rather than returning empty text; OCR is not available here. To create a PDF from Word, Excel or PowerPoint, export it with `office-export-pdf`; to create one from scratch, use reportlab.

## Diagrams and UML

1. Choose the notation. Graphviz DOT always works here; PlantUML needs Java and a PlantUML jar (`setup` says whether they are present; ask before installing either).
2. Write the source file next to the output, so the person can edit it later.
3. `office_tools` `render` with `input` and `output` (`.svg` or `.png`). PNG suits Word and PowerPoint.
4. Look at the result before inserting it.

DOT for UML:

- **Class diagram:** `node [shape=record]`, labels like `"{Order|+id: int\l+total: Money\l|+pay(): void\l}"`; inheritance `edge [arrowhead=empty]`, composition `arrowhead=diamond`, association plain arrows with labels for multiplicity.
- **Component and deployment:** `shape=component`, `shape=box3d`, `subgraph cluster_x { label="Server" ... }` for boundaries.
- **State machine:** `shape=circle` states, `shape=doublecircle` final, edge labels for events.
- **Activity and flowchart:** `shape=diamond` for decisions, `rankdir=TB`.
- **Sequence diagrams** are poor in DOT: use PlantUML when available; otherwise draw them with matplotlib (lifelines as vertical lines, messages as labelled arrows) and say why.
- Entity-relationship: `shape=plain` with an HTML table label per entity, edges between key ports.

## Pitfalls

- Corrupting a .docx or .xlsx by writing ZIP members directly: write a new archive, copying each unchanged member once.
- Reading formula results from a file nothing recalculated.
- Fonts: a font the machine lacks is substituted; check the render.
- Merged cells, data validation and conditional formatting are easy to lose when rewriting a sheet with pandas: edit with openpyxl instead.

## Verification

Name each file, what it contains, and how you checked it (reopened and asserted, rendered and looked, or recalculated). Say what you could not check.
