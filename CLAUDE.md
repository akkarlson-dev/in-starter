# iN Starter Kit — Claude Setup Guide

This file is read automatically by Claude Code. It tells you (Claude) how to help the user configure and deploy the pipeline.

---

## Context

The user is setting up the iN personal capture system. They are technically capable. Do not over-explain basics. Do not add preamble. Work through the CONFIG block in `setup.gs` with them, get the pipeline deployed, and leave them with something running.

---

## Your job in this session

Before step 1, confirm the user already has an Anthropic account and an API key with credit (platform.anthropic.com, ~$5 top-up). If they don't have one yet, send them there first and wait. Nothing after step 3 works without it, and there's no point filling in CONFIG only to stall at deploy.

Walk the user through these steps in order. Do not skip ahead. Do not explain a step before they are ready for it.

1. **CONFIG** — fill in the 10 lines in the CONFIG block at the top of `setup.gs`. Ask the questions below.
2. **Sheet setup** — create their Google Sheet and get the Sheet ID.
3. **Drive folder** — confirm they have an `IN/captures/` folder in Google Drive (or create it).
4. **Script deploy** — paste `setup.gs` into Google Apps Script, add their API key, set the trigger (`runPipeline`, every 15 minutes).
5. **Web app deploy** — Deploy → New deployment → type **Web app**. Execute as **Me**, who has access **Anyone** (the safer default, though see step 7 for the setting that actually matters). Copy the deployment URL from Manage deployments — that's the base link, something like `.../exec`. Append `?view=calendar` to it (`.../exec?view=calendar`) — that's their Calendar dashboard (`doGet()` in `setup.gs`). Right now Calendar is the only view and also the default, so the bare URL works too, but construct the `?view=` version anyway: if a later session adds another view, it follows the same pattern and gets its own home screen icon the same way.
6. **Form setup** — copy Amy's template form or build their own. Connect to the Sheet.
7. **Home screen** — add both links (the Form and the Calendar dashboard from step 5) to their iPhone home screen. Tapping a Google-hosted link from inside another app's embedded browser — Mail, Notes, Messages, a form's own confirmation page — often just fails to load or spins, without looking like an obvious error, because Google blocks interactive sign-in inside those "in-app browser" webviews. The setting that actually prevents this: **make sure Safari already has an active session for the Google account used to set this kit up** (open safari, confirm you're signed into that account at accounts.google.com) — with a live session already cached, the login step never has to happen, so nothing gets blocked, regardless of the deployment's access setting. Confirmed on Amy's own system: "Anyone" access alone did not fix it; an active Safari session did. Once that's confirmed, the reliable path for saving each link: copy the URL, open Safari in a **Private** window (tabs icon → Private), paste it into the address bar there and open it, then Share → Add to Home Screen once it's loaded correctly. A few extra taps, but it's the version that actually works every time — don't let them tap either link directly from wherever they copied it.
8. **First capture** — put something in. Confirm it shows up in the Sheet, then check the Calendar dashboard.

---

## CONFIG questions to ask

Ask these one at a time, in order. Use the answer to fill the CONFIG block.

**1. Google Sheet ID**
They will create a new Google Sheet first. The ID is the long string in the URL:
`docs.google.com/spreadsheets/d/[THIS PART]/edit`

**2. Their tags / categories**
What 4-6 words describe the areas of their life they want to track?
Examples: Work, Home, Ideas, Health, Finance, Personal.
These become their tag checkboxes in the form and the `categories` list in CONFIG. Checkboxes allow more than one tag per capture — the value that lands in the Sheet is a comma-separated string, which the pipeline passes straight to Claude as context.

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

The `buildEnrichPrompt` function is general and works for any user. The only Amy-specific line is the project categories list, which gets replaced with whatever the user specified in CONFIG.

The type classification (task / thought / gem / question / resource) inside that prompt is Amy's judgment call, not a fixed taxonomy. Mention this once, after first capture works: if their captures skew toward journal entries, or photos and links deserve different handling, or "gem" doesn't match how they think, the prompt is plain English and theirs to edit.

---

## Tone

Direct. No hand-holding preamble. The user is capable. If they get stuck, they will ask. Your job is to keep things moving.

---

## After setup

Once the pipeline is running, show them where things land:
- The Captures tab: every form submission, classified by type, horizon, next steps
- The Resources tab: links with titles and summaries
- The Tasks tab: anything classified as actionable, pulled out separately
- The Pipeline Log tab: one row per trigger run, for debugging
- The Calendar dashboard (the Web app URL from step 5): a real 5-week grid of actual dates, darker where more was captured, and tap-to-reveal on any day to see exactly what landed then

Then stop. Leave them to use it for a week before adding anything.

If they come back later asking for more (journal scanning, forwarding email into the pipeline, better handling for long voice dictation), each of those is sketched out in `setup.gs` under **OPTIONAL EXTENSIONS** at the bottom of the file — a real pattern from Amy's own pipeline to adapt, not a from-scratch design problem.

---

*Built by Amy K. Karlson · iN / begiN · July 2026*
