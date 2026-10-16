---
name: office-docx
description: Create, read, edit, and validate Word documents (.docx).
---

# Word documents

Use `python-docx` for DOCX creation and ordinary edits. Follow an explicit user or applicable AGENTS.md requirement for a project environment or another library. Otherwise call `load_workspace_dependencies` and execute the returned Python path with its bundled libraries. Do not install packages or discover a system Python for the default workflow. If the tool is unavailable, use an already configured environment and report a missing dependency only when it prevents the requested operation.

Keep source scripts, intermediate files, and final documents in the task workspace; the runtime and this skill directory are read-only resources. Use the user's requested language and preserve an existing document's design unless a redesign is requested.

## Create and edit

For existing files, inspect paragraphs, runs, tables, sections, headers, and footers before changing the affected content. Save to a new file unless the user requests an in-place edit. Replacing a paragraph's `.text` destroys its run formatting; change the relevant runs when formatting must survive. Reconstructing the whole document can lose features outside python-docx's supported editing API.

Use paragraph styles for headings and body text. Size tables for the section that contains them, and account for merged cells and nested tables. Chinese, Japanese, and Korean text may need an explicit `w:eastAsia` font assignment in addition to `run.font.name`; font names alone do not establish glyph availability or rendered appearance.

For a new document, use the selected Python executable:

```python
from docx import Document

document = Document()
document.add_heading("Project report", level=0)
document.add_paragraph("Summary", style="Heading 1")
document.add_paragraph("The requested findings go here.")
document.save("report.docx")
```

python-docx does not paginate or render documents. Do not represent ordinary replacement, colored text, or comments as tracked changes. When real revisions or unsupported OOXML features matter, preserve their package parts and verify the requested operation rather than silently discarding them.

## Check and deliver

Run the shared structural checker when `office-check` is available:

In PowerShell, prefix the quoted Python executable with `&`. Resolve the checker path relative to this skill directory.

```text
"<python>" "<skill-directory>/../scripts/check_office.py" <document.docx> --out <checks.json>
```

It checks ZIP/XML integrity and internal relationships, and reports paragraphs, logical table dimensions, and sections. Optional `--contains TEXT` arguments assert required text. A successful structural check does not verify pagination, clipping, fonts, or visual appearance. Compare the summary and reopened document with the user's request, including unchanged content that matters to an edit.

If the Python checker cannot run, use an already configured environment to check the ZIP/XML package and internal relationships. Report the missing environment if those checks cannot run; do not claim structural validation.

Deliver after the requested content and structural checks pass. Creating a file or changing content with incidental basic formatting does not require additional operations. Load `office-render` for requested images or visual inspection. When styling, font color, spacing, sizing, or text alignment is the requested edit, load `office-render` and inspect the changed page even without a separate visual-check request, unless the user explicitly skips rendering. For PDF output load `office-export-pdf`.

Call `present({"files":[{"path":"report.docx"}]})` with the actual final DOCX path. It exposes the current source file without copying or preserving its bytes, so keep that file in place and do not present temporary QA reports unless requested. If `present` is unavailable, provide the final workspace path using the session's supported file delivery method.
