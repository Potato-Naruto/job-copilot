# Job Copilot (Firefox)

## Install (temporary, for testing)
1. Firefox → `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `manifest.json`.
2. The Settings page opens from the toolbar icon → **Settings & profile**.
   - Pick Gemini (free key from aistudio.google.com/apikey) or Ollama (local; setup steps are on the page).
   - Paste your resume text → **Parse with AI** → review → **Save everything**.
3. Visit a job application. The panel pops up automatically (or press `Alt+Shift+J` / use the toolbar icon).

Temporary add-ons vanish when Firefox restarts. To keep it permanently: `npx web-ext sign` (free AMO unlisted signing), or use Firefox Developer Edition / Nightly with `xpinstall.signatures.required = false`.

## What it does
- **Autofill** – personal info, work preferences, education, EEO answers, resume file attach.
- **Remembers answers** – anything you answer that it didn't know is saved and reused (edit under Settings → Remembered answers).
- **Auto popup** – on applications it recognises (ATS domains + form heuristics).
- **Recruiter analysis + cover letter** – fit score, gaps, ATS keywords, paste-ready letter.
- **Tailored resume PDF** – employers/titles/dates/schools are locked to your profile; the AI only rewrites bullets, summary and skills ordering.

## Limits
- Custom dropdown widgets (react-select style comboboxes) can't be filled reliably; they show up in the "unknown" list for you to do once.
- Consent checkboxes are never auto-ticked.
- Review everything before you submit.
