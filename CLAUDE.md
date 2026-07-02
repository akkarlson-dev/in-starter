# iN Starter Kit — Claude Setup Guide

This file is read automatically by Claude Code. It tells you (Claude) how to help the user configure and deploy the pipeline.

---

## Context

The user is setting up the iN personal capture system. They are technically capable. Do not over-explain basics. Do not add preamble. Work through the CONFIG block in `setup.gs` with them, get the pipeline deployed, and leave them with something running.

---

## Your job in this session

Walk the user through these steps in order. Do not skip ahead. Do not explain a step before they are ready for it.

1. **CONFIG** — fill in the 10 lines in the CONFIG block at the top of `setup.gs`. Ask the questions below.
2. **Sheet setup** — create their Google Sheet and get the Sheet ID.
3. **Drive folder** — confirm they have an `IN/captures/` folder in Google Drive (or create it).
4. **Script deploy** — paste `setup.gs` into Google Apps Script, add their API key, set the trigger.
5. **Form setup** — copy Amy's template form or build their own. Connect to the Sheet.
6. **Home screen** — add the form to their iPhone home screen.
7. **First capture** — put something in. Confirm it shows up in the Sheet.

---

## CONFIG questions to ask

Ask these one at a time, in order. Use the answer to fill the CONFIG block.

**1. Google Sheet ID**
They will create a new Google Sheet first. The ID is the long string in the URL:
`docs.google.com/spreadsheets/d/[THIS PART]/edit`

**2. Their tags / categories**
What 4-6 words describe the areas of their life they want to track?
Examples: Work, Home, Ideas, Health, Finance, Personal.
These become their tag dropdown in the form and the `categories` list in CONFIG.

**3. Their extraction goal**
What do they want to pull out of their captures?
- Tasks / action items (default, always included)
- Ideas worth keeping (like Amy's "gems")
- Reading list / resources
- Something else?

Each goal beyond tasks adds a tab to the Sheet. Keep it to one or two for v1.

**4. Form field names**
Defaults are: "What?" / "Tag?"
They can rename these or keep them. The names must match the form exactly — Claude will help them verify this after the form is set up.

---

## Capture path callouts

Mention these when relevant, not all at once upfront.

**Voice-heavy users:** If their transcription tool (WhisperSpeak, Superwhisper, etc.) can save files, point it at `IN/captures/` in Google Drive. The pipeline picks up `.txt` files automatically. If it outputs to clipboard only, paste into the form — the iOS keyboard mic also works directly in the form text field.

**Screenshots and photos:** The iPhone default saves to Camera Roll, not the pipeline. To route to iN: Share → Save to Files → Google Drive → IN/captures. Two extra taps. Worth doing it once to build the habit.

**Links:** Paste a URL into the "What?" field. The pipeline detects it, fetches the page title and a short summary, and writes them to the Resources tab. Nothing else needed.

---

## What is Amy-specific in `setup.gs`

Everything in the CONFIG block is what to change. Below that, the script is general-purpose. The journal scanning section at the bottom is Amy's extension for processing handwritten journal PDFs via OCR — it is commented out and not needed for v1.

The ENRICH_PROMPT is general and works for any user. The only Amy-specific line is the project categories list, which gets replaced with whatever the user specified in CONFIG.

---

## Tone

Direct. No hand-holding preamble. The user is capable. If they get stuck, they will ask. Your job is to keep things moving.

---

## After setup

Once the pipeline is running, show them where things land:
- The Captures tab: every form submission, enriched with type, horizon, next steps
- The Resources tab: links with titles and summaries
- The Tasks tab: anything classified as actionable, pulled out separately
- The Pipeline Log tab: one row per trigger run, for debugging

Then stop. Leave them to use it for a week before adding anything.

---

*Built by Amy K. Karlson · iN / begiN · July 2026*
