# iN Starter Kit

A personal capture pipeline. Built by Amy Karlson.

You get a Google Form on your iPhone home screen, a Drive folder for screenshots and voice transcripts, and a script that reads everything with Claude Haiku every 15 minutes, sorts it (task, idea, gem, question, resource), and writes it to a Google Sheet.

---

## Architecture

```
CAPTURE
  iPhone home screen
    └─ iN Form (2 fields)  ──┐
  Photos / screenshots       │
    └─ IN/captures/  ────────┤
  Voice transcript (file)    │
    └─ IN/captures/  ────────┤
                             ▼
                    Google Sheets
                    (your data, your account)
                             │
                    Apps Script trigger
                    (every 15 min, runs in your account)
                             │
                    Claude Haiku API
                    (~$0.002 per capture)
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
         Captures         Resources       Tasks
           tab              tab            tab
        (all entries)    (links +        (actionable
                         summaries)       items)
```

Your data never leaves your Google account. The only external call is to the Anthropic API, which reads and classifies each capture.

## How captures get classified

Every capture gets read by Claude Haiku once, and sorted into a type: task, thought, gem (an insight worth keeping), question, or resource (a link or reference). Tasks also get a size, a rough horizon, and a note on whether it's something you'd do yourself, hand off, or automate.

These categories are Amy's starting point, not a rule. They live in one place: the `buildEnrichPrompt` function in `setup.gs`, in plain English, not code. If your captures are mostly journal entries, or "gem" doesn't mean what you'd call it, or you want photos handled differently than links, edit that prompt. The defaults work out of the box. Change them once you know what you're actually capturing.

---

## What you need

**Google account — free**
A standard Google account is all you need. The pipeline runs on Google Forms, Sheets, Drive, and Apps Script — all free. You do not need Google One AI Premium or any paid Google tier for this.

**Anthropic account — ~$5 to start, ~$1-5/month**
Go to [platform.anthropic.com](https://platform.anthropic.com), create an account, add a credit card, and buy a small credit top-up ($5 covers months of light pipeline use). Then, in the Console, go to **API Keys** in the left sidebar and click **Create Key**. Copy it somewhere for a minute, you'll paste it into Google Apps Script during setup. This account covers two things: the pipeline script (Claude Haiku classifies your captures) and Claude Code in VS Code (which walks you through setup).

**VS Code — free**
Download at [code.visualstudio.com](https://code.visualstudio.com). Install the Claude Code extension from the VS Code marketplace. Sign in with your Anthropic account.

---

## If it's been a while since you've had an AI agent touch actual files

This moves fast enough that even recent hands-on experience goes stale in months, so a quick orientation regardless of your background. Claude Code, running inside VS Code, is not a chat window: it reads your files directly, edits them, and runs commands on your machine, with you watching and approving each step. You're not prompting it from a blank slate, either. The moment you open this folder, it reads `CLAUDE.md` and already knows the job: get your pipeline running. It will ask you the setup questions below and do the actual typing into `setup.gs` and Google Apps Script for you.

One thing to expect: it will pause and ask permission before changing a file or running a command, especially the first few times. That's normal. Approve it and it keeps going.

Nothing here is a hidden model behavior. Every session, Claude's sense of "who you are and what this workspace is" comes directly from `CLAUDE.md`, a plain human-readable file it reads fresh each time and keeps updating as things change. Open it any time and you'll see exactly what it knows.

---

## Getting your form

The fastest path: copy Amy's template. This gives you the two default fields already wired to match `setup.gs`.

[Copy Amy's iN Form →](https://docs.google.com/forms/u/0/d/1yaV5d6cMUVsQKQ-dk3PVlK-oy1wxQ7NmiVzrKzqmHc8/copy)

Click **Make a copy**, rename the form, swap out the tag options for your own categories. That's it.

**Important:** if you rename any field labels, update `CONFIG.formFields` in `setup.gs` to match exactly. The pipeline finds your columns by name.

Want to build your own form from scratch instead? The CLAUDE.md setup conversation will walk you through it.

**Saving it to your home screen:** don't tap the link directly from wherever you copied it (Mail, Notes, Messages, the form's own confirmation page) — Google's mobile auth blocks those in-app browsers and the link just fails to load or spins, without looking like an obvious error. Instead: copy the URL, open Safari in a **Private** window, paste it into the address bar there, and once it loads correctly, Share → Add to Home Screen. A few extra taps, but it's the version that works reliably. The same trick applies to your Calendar dashboard link below — you'll end up with two icons on your home screen.

---

## Your dashboard

Setup deploys a second link alongside the form: a Calendar page showing the real last 5 weeks, darker on days you captured more, with a tap on any day to see exactly what you captured then (task/thought/gem/question/resource, color-coded).

It's a Web App deployment of `setup.gs` itself (the `doGet()` function at the bottom) — the CLAUDE.md setup conversation walks you through deploying it, no separate account or service involved.

**Finding and constructing your dashboard link:** in Apps Script, go to Deploy → Manage deployments and copy the Web app URL — that's your base link, something like `https://script.google.com/macros/s/AKfyc.../exec`. Append `?view=calendar` to it (e.g. `...exec?view=calendar`) to link directly to the Calendar view. Right now that's the only view and it's also the default, so the bare URL and the `?view=calendar` version show the same thing — but if a future Claude session adds another view (Grouped, Word Cloud, whatever you ask for), it'll follow the same `?view=name` pattern, and you'll construct that link the same way to give it its own home screen icon. Save it to your home screen the same way as the form (see above).

---

## Three steps

1. Clone this repo and open the folder in VS Code
2. Claude Code reads `CLAUDE.md` automatically and starts the setup conversation
3. Follow along. You'll have something running in under an hour.

---

## Three ways to capture

**Form** — the main path. Tap the iN icon on your home screen, fill two fields, submit. Works anywhere, no app install required.

**Drive drop** — for screenshots, photos, PDFs, and voice transcripts. On iPhone: Share → Save to Files → Google Drive → IN/captures. The pipeline picks up anything dropped here.

**Links** — paste a URL into the form's "What?" field. The pipeline fetches the page title and a short summary automatically and writes it to the Resources tab.

---

## Voice users

If you dictate long captures using WhisperSpeak, Superwhisper, or a similar tool:
- If your tool saves transcripts as files: point it at `IN/captures/` in Google Drive. Fully hands-free.
- If your tool outputs to clipboard: paste into the form. The native iOS keyboard mic also works directly in the form for shorter captures.

---

## Want more than v1?

This kit is deliberately minimal — a form, a Drive folder, and one classification pass. Journal scanning, forwarding email into the pipeline, and better handling for long dictation are all real patterns Amy already uses, documented at the bottom of `setup.gs` under **OPTIONAL EXTENSIONS**. Ask Claude to build one in once the basics are working for a week or two — don't add anything before then.

---


*iN / begiN · Amy K. Karlson · July 2026*
*[beginin.substack.com](https://beginin.substack.com)*
