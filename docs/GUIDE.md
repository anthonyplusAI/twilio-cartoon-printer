# Detailed Guide

This document covers all features and configuration in depth. For quick setup, see the [README](../README.md).

## Table of Contents

- [Environment Variables](#environment-variables)
- [Admin Authentication](#admin-authentication)
- [Template Frames](#template-frames)
- [Printer Setup](#printer-setup)
- [Web UI](#web-ui)
  - [Home Page](#home-page)
  - [Get Started Video](#get-started-video)
  - [Static Instruction Page](#static-instruction-page)
  - [Channel Selector](#channel-selector)
  - [Booth Display](#booth-display)
  - [Photo Book](#photo-book)
- [Admin Dashboard](#admin-dashboard)
  - [Event Report](#event-report)
- [Style Selection](#style-selection)
- [Adding or Changing Styles](#adding-or-changing-styles)
- [Multi-Subject Photos](#multi-subject-photos)
- [Branding](#branding)
  - [Single Brand Mode](#single-brand-mode)
  - [Multi-Brand Selection](#multi-brand-selection)
- [Background Selection](#background-selection)
- [Review Modes](#review-modes)
- [Delivery Mode](#delivery-mode)
  - [Immediate Digital Delivery](#immediate-digital-delivery)
- [Print Relay (Cloud Printing)](#print-relay-cloud-printing)
- [Cloud Deployment](#cloud-deployment)
- [Lead Capture](#lead-capture)
- [Outreach](#outreach)
- [Configurable SMS Messages](#configurable-sms-messages)
- [NPS Survey](#nps-survey)
- [Social Sharing](#social-sharing)
  - [Share Page](#share-page-sfileprefix)
  - [URL Shortening (dub.co)](#url-shortening-dubco)
  - [Share Page Only Mode](#share-page-only-mode)
  - [Configuration](#configuration)
- [BRB Screen](#brb-screen)
- [Promotional Messages](#promotional-messages)
- [Runtime Settings](#runtime-settings)
- [Import Style Prompts](#import-style-prompts)
- [Switching Events](#switching-events)
- [Job Queue](#job-queue)
  - [Crash Recovery](#crash-recovery)
  - [Permanent Failures](#permanent-failures)
  - [Retry Logic](#retry-logic)
  - [Printer Failure Resilience](#printer-failure-resilience)
  - [Reprints](#reprints)
- [Project Structure](#project-structure)

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | Yes | Your Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | Yes | Your Twilio Auth Token |
| `TWILIO_PHONE_NUMBER` | Conditional | SMS/MMS sender in E.164 format. Required unless you use `TWILIO_MESSAGING_SERVICE_SID` or WhatsApp-only sending. |
| `TWILIO_MESSAGING_SERVICE_SID` | Conditional | Messaging Service SID (starts with `MG`). When set, outbound SMS/MMS route through this service and Twilio picks a sender from the pool. |
| `TWILIO_WHATSAPP_NUMBER` | Conditional | WhatsApp sender in E.164 format. Required for direct WhatsApp sending unless you use `TWILIO_WHATSAPP_MESSAGING_SERVICE_SID`. |
| `TWILIO_WHATSAPP_MESSAGING_SERVICE_SID` | Conditional | Messaging Service SID for WhatsApp sending. Configure this or `TWILIO_WHATSAPP_NUMBER` for WhatsApp support. |
| `OPENAI_API_KEY` | Yes | Your OpenAI API key |
| `PRINTER_NAME` | Print only | CUPS printer name prefix for local printing (find with `lpstat -p`). The app matches any printer starting with this name, so `EPSON_ET_8550_Series` matches `EPSON_ET_8550_Series_2`, etc. |
| `EVENT_NAME` | Yes | Name of the current event (used for per-event print limits and download folders) |
| `ADMIN_PHONES` | No | Comma-separated phone numbers in E.164 format (e.g. `+14155551234`). Admins get unlimited prints and are excluded from dashboard metrics. |
| `MAX_PRINTS_PER_USER` | No | Max free prints per phone number per event. Defaults to `2`. |
| `MAX_CONCURRENT_GENERATION` | No | Max AI image generations running at the same time. Defaults to `15`. Increase for faster throughput, decrease if hitting OpenAI rate limits. Configurable at runtime under Event & Operations. |
| `TEMPLATE_FILE` | No | Filename of the template frame in the `templates/` folder (e.g. `signal_sf.png`). Leave blank to disable. |
| `VIDEO_FILE` | No | Filename of the Get Started video in `booth-uploads/`. Defaults to `get-started.mp4`. Upload videos from Settings so they persist across container restarts. |
| `TERMS_URL` | No | URL to your terms of service. Displayed on booth screens (video, combo, photo gallery). |
| `ENABLE_PRINTING` | No | Set to `false` to disable printing and run digital-only (MMS delivery). Defaults to `true`. |
| `BRAND_PROMPT` | No | Global branding prompt appended to every art style (e.g. clothing, logos). Leave blank to disable. |
| `PRINT_SIZE` | No | Output and print preset. Options: `4x6`, `6x4` (landscape 1800x1200 PNG), `5x7`, `8x10`. Defaults to `5x7`. Controls AI orientation, final pixel dimensions, and printer page orientation. |
| `PRINT_QUALITY` | No | Print resolution. Options: `standard` (360 DPI), `high` (720 DPI), `max` (1440 DPI). Defaults to `high`. |
| `PICKUP_LOCATION` | No | Name shown in physical print pickup messages. Runtime setting overrides this value; blank uses `Twilio booth` in English or `estande da Twilio` in Portuguese. |
| `CUSTOM_PRINT_FLAGS` | No | Additional raw flags appended to the `lp` command. For non-Epson printers or advanced CUPS options (e.g. `-o MediaType=Glossy`). |
| `PROMO_MESSAGE` | No | Optional replacement for the new-event promotional message. The promo can be disabled in Settings. |
| `PRINT_RELAY_KEY` | No | Shared secret for the print relay agent. Set it in deployment configuration (or local `.env`) to enable cloud-to-local printing; it cannot be entered in the Settings page. See [Print Relay](#print-relay-cloud-printing). |
| `PRINT_RELAY_URL` | No | Cloud app URL for the relay agent (used by the local script only, not the server). |
| `PRINT_RELAY_PRINTER` | No | Override printer name for the relay agent (default: auto-detect). |
| `PRINT_RELAY_PRINTERS` | No | Comma-separated list of printer names for multi-printer relay (e.g. `EPSON_1,EPSON_2`). Overrides `PRINT_RELAY_PRINTER`. |
| `PRINT_RELAY_INTERVAL` | No | Relay poll interval in seconds (default: `5`). |
| `PRINT_RELAY_DRY_RUN` | No | Set to `true` to download images without printing (for testing). |
| `BASE_URL` | No | Public app URL used in generated review/share links. Auto-detected from the first inbound request if not set, but should be set explicitly in production. |
| `DATA_MOUNT` | No | Persistent storage mount used by Docker/cloud startup. Defaults to `/app/appdata`. |
| `DUB_API_KEY` | No | dub.co API key for URL shortening. Leave blank to disable short links. |
| `DUB_DOMAIN` | No | Custom short domain on dub.co (default: `twil.io`). |
| `DUB_SLUG_PREFIX` | No | Default per-event short-link slug prefix. Defaults to `p`. |
| `DUB_FOLDER_ID` | No | Optional dub.co folder ID for organizing short links. |
| `GOOGLE_CLIENT_ID` | Admin UI | Google OAuth client ID. Required for login to protected admin routes unless a valid session already exists. |
| `GOOGLE_CLIENT_SECRET` | Admin UI | Google OAuth client secret. |
| `ADMIN_PIN` | Admin UI | Optional shared, case-sensitive admin PIN. Must be 8-64 ASCII letters or numbers; numeric-only values are allowed. Configure this, Google OAuth, or both. |
| `SESSION_SECRET` | Admin UI | Secret used to HMAC-sign admin sessions, OAuth state, and review tokens. Production requires at least 32 characters and fails startup if it is missing or weak. Local/test runs generate an ephemeral secret when omitted. |
| `ALLOWED_EMAILS` | No | Comma-separated non-`@twilio.com` emails allowed to sign in. Empty means verified `@twilio.com` accounts only. |
| `REVIEW_TOKEN_TTL` | No | Review token lifetime in seconds. Defaults to 7 days. |
| `MODEL_ORCHESTRATOR` | No | OpenAI model for orchestration, moderation-adjacent decisions, AI review, and prompt reasoning. Defaults to `gpt-5.5`. |
| `MODEL_VISION_LIGHT` | No | Lightweight vision model for face/scene checks. Defaults to `gpt-5.4-nano`. |
| `MODEL_IMAGE_GEN` | No | Image generation model. Defaults to `gpt-image-2-2026-04-21`; exact/transparent background mode can use `gpt-image-1.5`. |
| `MODEL_SMART_REPLY` | No | Model for conversational replies to text-only messages. Defaults to `gpt-5.4-nano`. |
| `MODEL_REF_ANALYSIS` | No | Model for analyzing brand/reference images. Defaults to `gpt-5.5`. |

At startup the app validates channel configuration and exits if no SMS or WhatsApp sender is configured.

## Admin Authentication

All non-public admin routes accept a Google OAuth or shared PIN session. Public routes include `/inbound`, `/healthz`, `/auth/*`, `/review/*`, `/s/*`, approved files under `/images/*`, `/assets/*`, `/booth-uploads/*`, `/api/print-relay/*`, and approved read-only `GET` routes under `/photogallery`.

Set a random `SESSION_SECRET` of at least 32 characters and configure Google OAuth, `ADMIN_PIN`, or both. Add these redirect URIs to the Google OAuth client as needed:

```text
http://localhost:3000/auth/callback
https://your-production-host/auth/callback
```

Verified `@twilio.com` Google accounts are allowed by default. Use `ALLOWED_EMAILS` for individual non-Twilio operators.

`ADMIN_PIN` accepts 8-64 characters from `[A-Za-z0-9]` and is case-sensitive; numeric-only values are allowed. Five failed attempts from one client block further attempts for 15 minutes. Rotating it invalidates existing PIN sessions only. Google OAuth callbacks use a signed, short-lived state token bound to an `HttpOnly`, `SameSite=Lax` nonce cookie.

Standalone review login accepts only the existing 4-6 character Review PIN and has its own five-attempt/15-minute client limit. `ADMIN_PIN` is accepted only at `/auth/pin`, where it creates a full admin session that also authorizes review pages and staged media. Review sessions are bound to the Review PIN, so rotating it invalidates existing review sessions. Approved images remain public; staged media under `/images/staging/*` and `/photogallery/staging/*` requires either a valid admin session or review session.

Security notes:

- `/inbound` is public so Twilio can call it. The current app does not validate `X-Twilio-Signature`.
- Relay endpoints are public but require the `x-relay-key` header to match `PRINT_RELAY_KEY`.
- Share pages and generated image routes are public by design.

## Template Frames

Place your template PNGs in the `templates/` folder. Set `TEMPLATE_FILE` in `.env` to the filename you want to use (e.g. `signal_sf.png`). You can also change the template at runtime from `/home/settings` under **Portrait** > **Styles & Art**, and upload new templates directly through the UI.

Templates should be PNGs with **transparent areas** where the generated portrait shows through. The opaque areas form the frame border (branding, logos, CTA, etc.). The template is composited on top of the portrait at the configured output dimensions.

The app automatically detects the template's transparent window and fits the portrait within it, so frame borders never clip the subject's head or body. A small inset padding keeps the portrait from touching the frame edge. If no transparent area is found, the portrait fills the entire print area as a fallback.

The template can be **any resolution**, but its orientation must match the selected output preset. Use a 3:2 landscape template for `6x4`; a portrait template is skipped rather than severely cropped. For best results, match the final output aspect ratio.

Leave `TEMPLATE_FILE` blank to disable the frame overlay.

## Printer Setup

### Compatible printers

The app includes print profiles for the **Epson EcoTank ET-8550** and **DNP DS-RX1**. Profiles are selected per CUPS queue, so local and multi-printer relay setups can use either model without changing global flags.

For a DNP queue whose name contains `DS-RX1`, app size **4x6** maps to the driver's required `300dnp6x4` page size. Standard quality maps to 300x300 DPI; High and Max map to 300x600 DPI. The profile also sends Glossy finish, normal cutter, RGB color, and print retry. Set Print Size to **4x6** when RX1 6x4 media is loaded. The DS-RX1 profile rejects 8x10 because the printer cannot produce it.

Other printer models require CUPS options that match their installed driver and may need a new profile or custom print flags.

### Connection methods

The app prints through **CUPS** (Common Unix Printing System), which is built into macOS and Linux. Any printer that appears in CUPS works, regardless of how it's connected:

- **USB** -- direct connection, most reliable
- **WiFi / Network** -- printer and server on the same network
- **Bonjour / AirPrint** -- automatic discovery on local networks (common for macOS)
- **IPP** (Internet Printing Protocol) -- standard network printing

All connection methods behave identically from the app's perspective. The `lp` command sends jobs to the CUPS daemon, which handles the connection details. A WiFi-connected Epson ET-8550 works the same as a USB-connected one.

### Find your printer name

```sh
lpstat -p
```

Copy the printer name (for example, `EPSON_ET_8550_Series` or `Dai_Nippon_Printing_DS_RX1`) into `PRINTER_NAME` in your `.env`. The app matches any printer starting with that prefix. If multiple printers match, it picks a healthy one over a disconnected or disabled one.

Print settings are translated by the detected printer profile in local server printing, the CLI relay, and the Print Station desktop app.

## Web UI

Current mounted routes:

| Route | Access | Purpose |
|---|---|---|
| `/` | Admin | Redirects to `/home` |
| `/home` | Admin | Operator home, event status, booth display launcher, and links to tools |
| `/home/settings` | Admin | Event, portrait, delivery, booth display, messaging, and advanced settings |
| `/start` | Public | Attendee start page opened by auto-generated booth QRs for one or both channels |
| `/start/notice` | Public | Full participation terms linked from the start page |
| `/dashboard` | Admin | Monitoring, review, retry/reprint, printer controls, reports |
| `/outreach` | Admin | Broadcasts, raffles, lead reports, drop-off nudges |
| `/photogallery` | Public GET, admin mutations | Public booth photo book and admin photo actions |
| `/s/:filePrefix` | Public | Share page for delivered portraits |
| `/review/*` | Public token/PIN flow | Mobile review flow for approved reviewers |
| `/review/settings` | Review or admin session | Review settings, including Review PIN replacement/removal |
| `/api/generate` | Admin/API | Programmatic generation endpoint used by kiosk/API clients |
| `/kiosk` | Admin/API | Browser kiosk submission UI with SMS/WhatsApp portrait delivery |
| `/eval` | Admin | Prompt experiments and evaluation tools |
| `/api/print-relay/*` | Relay key | Print Station and CLI relay API |
| `/auth/*` | Public | Google OAuth login, callback, and logout |
| `/healthz` | Public | Health check |

The kiosk offers the delivery channels enabled for the active event. WhatsApp appears only when its sender and locale-specific approved `delivery` Content SID are configured, and when the event is Digital Only or sends the digital copy immediately.

### Home Page

The home page at `/home` is the operator hub. It shows the current event and its queue, delivery, review, and guest-entry status. The booth display card launches `/home/combo` and links to QR instructions, video when configured, and the camera kiosk. Quick links open Dashboard, Gallery, Outreach, and the separate Settings page at `/home/settings`.

The **How this event runs** section summarizes the guest entry, review, and delivery flow for the active event. See [Runtime Settings](#runtime-settings) for configuration details.

### Get Started Video

The intro video at `/home/video` is a fullscreen looping video player designed to run on a booth display monitor to attract attendees and show them how the photobooth works.

- Upload your video from `/home/settings` > **Booth display**, which stores it in `booth-uploads/` so it persists across cloud restarts
- Set `VIDEO_FILE` in `.env` to the filename (defaults to `get-started.mp4`)
- The video autoplays on loop with floating BRB, Pause/Play, and Fullscreen buttons
- To switch videos, change the setting in `/home/settings` > **Booth display** or update `.env`

### Static Instruction Page

The static page at `/home/panel` is a branded instruction panel designed for booth monitors. It displays a QR code, numbered steps, and configurable text -- all with Twilio typography (Display Extrabold headlines, Text body copy, Mono step numbers) and draft line accents.

New events start in **Static Page** mode. Configure it from `/home/settings` > **Booth display**:

- **Headline** -- large text at the top (e.g. "Get Your AI Portrait")
- **Subline** -- smaller text below the headline (e.g. event name)
- **QR Code** -- automatically generated from the enabled messaging channels; attendees scan it to start
- **Steps 1-3** -- numbered instructions shown below the QR code
- **Legal Text** -- optional additional text shown on the instruction page and full participation terms

The page includes BRB and Fullscreen buttons. Each channel needs a usable sender number for an automatic QR code, or an uploaded QR image as a fallback. An uploaded QR may lead outside this app and bypass the attendee start page; scan each uploaded image to verify its destination.

### Channel Selector

Auto-generated booth QRs open the public `/start` page first. The **Continue with SMS** and/or **Continue with WhatsApp** buttons appear directly below the heading and intro. Below the buttons, **About this experience** states that Twilio receives the attendee's phone number and photo, may collect their name, email, and country if the event asks, and shares the photo with OpenAI for image checks, analysis, and portrait generation. A **Read participation terms** link opens `/start/notice`. The page has no marketing checkbox. The footer reads, `By continuing, you agree to the participation terms.` The full notice's **Terms of Service** section retains its separate 18-or-older clause.

The full participation terms have six sections: **Privacy Notice**, **Marketing Enrollment**, **AI Portrait Generation**, **Data Collection**, **Photo Retention**, and **Terms of Service**. **Marketing Enrollment** describes enrollment for everyone who sends the starter message. The terms link Twilio's Privacy Notice and Terms. **Legal Text** adds a separate event-specific section; a configured **Terms URL** adds an additional event-terms link when it differs from Twilio's Terms URL.

The **Photo Retention** section promises that the original photo is kept only as long as needed to generate the portrait and deleted following the event. This is an operator commitment: V1 does not enforce that retention limit or automatically delete photos when the event ends. Staff need a cleanup process before live use; `/home/settings` > **Reset & data** > **Clear event data** provides a manual event-data deletion action.

The channel buttons match the event setup:

| Enabled channels | What the attendee sees after scanning |
|---|---|
| SMS only | **Continue with SMS**, then the notice and terms link |
| WhatsApp only | **Continue with WhatsApp**, then the notice and terms link |
| Both | Both buttons, then the notice and terms link |

Tapping a button opens the matching messaging app with a draft. It does **not** send the message. The attendee taps **Send** there, then sends a selfie. The default draft on both channels is:

```text
Hit send to start! 🚀

By sending this text, I agree to Twilio’s Terms (twil.io/terms) and Privacy Notice (twil.io/privacy) for marketing communications.

Msg & data rates apply.
```

The legal block is included in every SMS and WhatsApp starter draft. Marketing enrollment is recorded after the app receives the sent statement from the Twilio sender. For this QR flow, the attendee taps **Send** to start. Until a sender has recorded enrollment for the current event and channel, a direct message or a draft with the consent block removed receives a request to send the required starter. The app waits to ask for a chat language or process a photo until that starter is received.

Edit the SMS and WhatsApp **Pre-fill message** fields separately at `/home/settings` > **Booth Display** > **SMS** or **WhatsApp**, with **Static Page** selected. These fields set the opening text; the app adds the fixed Terms, Privacy Notice, and marketing block automatically, including when the opening text is custom. Previously saved built-in starter messages are upgraded to the current default when settings load. Other custom opening text is retained.

In **Ask** language mode, links on `/start` change the page language. An attendee without a saved language preference is asked to choose a **chat** language after sending the starter. A configured single-language event does not ask that question.

When both channels use auto-generated QRs and have usable booth numbers, the panel shows one shared QR. An explicitly uploaded QR appears in a separate labeled slot; mixed setups pair it with an auto-generated QR labeled **Scan to choose SMS or WhatsApp**. Auto-generated QRs open `/start`; uploaded images may bypass it. A channel with neither a usable number nor an uploaded QR is omitted.

### Booth Display

The booth display at `/home/combo` is responsive to monitor orientation and opens as a normal page without a popup or fullscreen prompt. Landscape screens retain the original side-by-side layout. Portrait screens place the content pane above the photo book. Theme changes synchronize across both panes in either orientation, and the divider is draggable horizontally or vertically to resize the panes.

The **Display Mode** setting under **Booth display** at `/home/settings` controls what shows on the left side:

| Mode | Left pane | Right pane | Use case |
|------|-----------|------------|----------|
| **Video** | Looping intro video (`/home/video`) | Photo book | Attract with video |
| **Static Page** | Instruction panel with QR code (`/home/panel`) | Photo book | QR-driven engagement |
| **None** | *(no left pane)* | Photo book (full width) | Photo book only |

When the mode is "Video" but no video file is selected, the display falls back to full-width photo book (same as "None").

### Photo Book

The photo book at `/photogallery` presents AI-generated portraits as an open two-page book in both landscape and portrait orientations. It uses the [turn.js](https://github.com/nickmilo/turn.js) library for realistic page-turn animations and is designed for a tactile, physical feel on booth displays.

- Open book layout with left and right pages showing different portraits
- Realistic page-turn animations powered by turn.js (drag corners or use arrows)
- Stacked page layers and book cover for a realistic book depth effect
- Per-page "View Original" buttons to reveal the original selfie
- Page numbers on each page (highest to lowest, newest to oldest)
- White photo frame mat around each image with decorative corner mounts
- Auto-rotates through spreads every 10 seconds
- Play/Pause, keyboard arrows, and clickable thumbnails for manual navigation
- Fullscreen support with responsive sizing
- Warm parchment-toned pages with subtle paper texture and a Twilio-red ambient gradient in light mode
- **Event filter** -- dropdown to filter portraits by event, or view all events combined
- Live portrait counter with animated bump when new images arrive
- Polls for new images every 5 seconds

## Admin Dashboard

The admin dashboard is available at `/dashboard`.

Use the **event selector** dropdown in the header to filter all metrics by a specific event, or view combined totals across all events. Events are discovered from both job history and the `downloads/` directory, so any event with a folder or completed jobs appears in the dropdown.

The **Exclude admin** checkbox in the header filters out admin phone numbers from all metrics -- totals, averages, top users, style breakdowns, and geography. Uncheck it to include admin activity (useful during testing). PDF reports always exclude admin activity.

The dashboard shows:

- **Stats overview** -- total prints, prints in the last 24 hours, unique users, average prints per user, current queue depth
- **Generate Report** -- button to download a PDF event report (see below)
- **Style breakdown** -- bar chart showing how many prints of each art style
- **Hourly activity** -- bar chart of prints per hour over the last 24 hours with hour labels and hover tooltips
- **Top users** -- most active phone numbers (masked for privacy)
- **Job health** -- completed vs failed counts, overall success rate, content rejection rate, and average generation/print times
- **Failure breakdown** -- bar chart categorizing failures by reason (moderation, face detection, generation/API errors, printer errors, crash recovery)
- **User geography** -- bar chart showing where users are located based on phone number country codes
- **Queue status** -- live counts for each pipeline stage (pending, generating, ready, printing) and printer status with disable/enable buttons. Stuck job detection alerts when a job has been generating for over 5 minutes or printing for over 10 minutes. Shows warnings when jobs are waiting but no printers are connected or all printers are disabled.
- **Jobs panel** -- combined view of all failed and completed jobs with filter tabs (All / Failed / Completed) and color-coded status badges. Printer-failure jobs show a printer dropdown and "Retry Print" button. Generation failures have a "Retry" button for re-generation. Completed jobs have a "Reprint" button with printer targeting. Sorted by time, most recent first.
- **Printer management** -- disable/enable individual printers from the queue status panel. Disabled printers receive no new jobs and disabling clears targeting on queued jobs aimed at that printer. In cloud mode, relay printers auto-register and appear alongside local printers. Jobs that fail on a printer are automatically routed to a different printer on retry.
The dashboard auto-refreshes every 3 seconds. No external dependencies -- it's a single self-contained HTML page with inline CSS and JavaScript.

### Event Report

Click **Generate Report** on the dashboard to download a PDF summarizing key event metrics. The report includes:

- AI-generated event summary (via OpenAI)
- Key metrics (total prints, unique users, avg per user, most popular style, success rate, avg generation/print times)
- Style breakdown table
- Top users
- NPS score (average, response count, 1-5 distribution)
- Failure analysis with rejection rate
- User geography (top 10 countries)

The report respects the currently selected event filter. AI summaries are cached in memory so repeated downloads don't re-call the API.

## Style Selection

After sending a selfie, users receive a numbered style menu:

```
Great selfie! Pick your art style:

1. cartoon
2. pop art
3. watercolor
4. anime
5. sketch
6. pixel art

Reply with a number or style name.
```

Users can reply with a number (`3`) or type the style name (`watercolor`). If a user includes a recognized style name in the caption when sending their selfie, the menu is skipped and generation starts immediately.

If no style is specified, the user is shown the style menu unless only one style is active for the event. When only one style is active, that style is selected automatically.

The bot also responds conversationally when users send text-only messages with questions or unusual input (e.g. "what is twilio?", "how does this work?"). Common short messages like "hi" get a fast static response, while longer or more interesting messages get a dynamic AI-generated reply (via `gpt-5.4-nano` by default) that answers the question and directs the user to send a selfie.

## Adding or Changing Styles

Art styles can be managed in two ways:

**From Settings** (no code changes): Open `/home/settings` > **Portrait** > **Styles & Art**. You can toggle built-in styles on/off, edit their prompts (with a reset button to revert to the original), add custom styles with a name and prompt, and edit custom style names and prompts after creation. You can also choose which style is used as the default when a user doesn't specify one, and import style prompt overrides from another event. Click **Save changes** to apply edits; customizations are stored in `data/settings.json` and the active event profile.

**In code**: Built-in styles are defined in `lib/styles.js`. Each style has a keyword, display name, and an LLM prompt. To add a new built-in style, add an entry to the `STYLES` object:

```js
"oil-painting": {
    name: "oil painting",
    prompt: "Transform this photo into a classical oil painting portrait..."
},
```

Styles automatically appear in SMS messages and are available for users to select. Style matching is fuzzy -- it handles extra spaces, hyphens, and case differences.

## Multi-Subject Photos

New events set **Multi-Subject Photos** to **Normal**, so group photos are generated as usual. Scene analysis counts the primary people and pets so the prompt can preserve the intended subject count.

Change the mode under **Portrait** > **Styles & Art** to **Reject** when an event needs solo selfies. In that mode, a photo with multiple primary human subjects gets the configurable `multiSubjectReject` message and its usage count is refunded.

## Branding

Branding controls how the AI renders clothing, logos, and visual themes across all art styles. The **Branding** group in `/home/settings` > **Portrait** has two modes, toggled by the **Let Users Choose Brand** switch.

### Single Brand Mode

When the brand selection toggle is OFF, all portraits use a single brand configuration:

- **Brand Prompt** -- a global modifier appended to every art style's AI prompt (e.g. "wearing a bright red Twilio t-shirt with the Twilio logo clearly visible"). Applied to all subjects in multi-person photos.
- **Brand Reference Images** -- uploaded images that show the AI what the branded items look like (jerseys, logos, gear). Stored in a shared library; each event selects which images to use via checkboxes.

Configure from `/home/settings` > **Portrait** > **Branding**. Leave the brand prompt blank to disable. Can also be set via the `BRAND_PROMPT` environment variable.

### Multi-Brand Selection

When the brand selection toggle is ON, users choose a brand/team via SMS or WhatsApp after picking their art style, when there is more than one effective choice.

**Flow:** Selfie → Style → Brand (when needed) → Scene/background (when needed) → Enqueue

Each brand is a card in the Settings panel with:

- **Display name** -- what users see in the SMS menu (e.g. "LA Kings")
- **Brand prompt** -- per-brand AI prompt override
- **Reference files** -- selected from the shared brand reference library

Brands are stored as a global library (`customBrands` in settings), shared across events. Per-event controls include:

- **Enable/disable individual brands** -- toggle brands on or off per event without deleting them
- **Offer Unbranded** -- on by default; lets users choose a portrait without a configured brand
- **Brand prompt overrides** -- customize a brand's prompt for a specific event

With **Offer Unbranded** on, a single enabled brand appears alongside Unbranded. Turn it off to remove that choice. If only one brand is enabled, the app selects it automatically and continues to that brand's scene/background choices. With multiple enabled brands, users still get a brand menu. Brand menu messages (intro, footer, retry) are configurable under **Engagement & Messages**.

Brand reference images are stored in the `brand-references/` folder. Uploading adds to the shared library; each brand selects which images to use. Deleting an image removes it from the library and from all brands that reference it.

## Background Selection

The app includes a configurable background system for AI-generated portraits. By default, a background instruction is appended to every generation prompt that tells the AI to recreate the original photo's background in the chosen art style. This default prompt is editable in `/home/settings` > **Portrait** > **Backgrounds**.

When **Enable Background Selection** is turned on, users get a numbered background menu via SMS after choosing their art style -- similar to the style selection menu. Admins configure the available background options (name + prompt) from the Settings panel. Each option tells the AI what background to render (e.g. "Solid White", "Original Scene", "City Skyline").

When background selection is enabled, the menu is shown for multiple available options; a single option is applied automatically. Scenes configured under a chosen brand are offered even when general Background Selection is off. With that toggle off, an Unbranded portrait uses the default background prompt. Leave the default prompt blank to let the AI decide freely.

Background menu SMS messages (intro, footer, retry) are configurable under **Engagement & Messages**.

## Review Modes

Before a generated portrait reaches the user, it can pass through an optional review step. Configure **Review Mode** in `/home/settings` > **Delivery** > **Image Review**:

| Mode | Behavior | When to use |
|---|---|---|
| `off` | Portraits are delivered automatically as soon as generation finishes | Low-stakes events, demos |
| `human` | Portraits park in `queue/review/` until an admin explicitly approves each one from the dashboard or the mobile review URL (guarded by a PIN) | Brand-sensitive events where every output needs eyes |
| `ai` | The orchestrator model reviews each portrait; clean ones pass, problematic ones are auto-rejected with a "try again" SMS to the user | Medium-trust events — catches obvious failures without requiring a human |

When `reviewMode` is `human` or `ai`, the **Variants Per Review** setting (default `1`, max `3`) controls how many portraits are generated per request. With variants >1, each request fans out to N parallel generations sharing a `parentJobId`, and they surface to the reviewer as a single card showing all variants side by side.

- In `human` mode, the reviewer picks one of the N variants (the winner goes to the user, losing siblings are marked `SUPERSEDED` and discarded).
- In `ai` mode, a best-of-N coordinator picks the winner automatically once all siblings are terminal.

The reviewer can also:

- **Regenerate a single variant** without touching siblings (cost: one additional OpenAI call per regen). Limited by the per-event **Regeneration Limit** setting.
- **Reject the whole parent** (with optional "try again" SMS to the user) or **Re-analyze** to queue a fresh batch of variants from scratch (preserves lineage via `reanalyzedFrom`).

Flipping review mode **off** while items sit in the queue does NOT auto-approve them — they remain in `queue/review/` until a human acts on them. Review mode only affects newly generated portraits.

## Delivery Mode

The app supports three delivery setups, configured in `/home/settings` > **Delivery**:

- **Print + Digital (local)** -- Portraits are printed on a directly connected printer and sent to the user via MMS/share link. With immediate digital delivery enabled, delivery happens after generation while printing continues; otherwise it waits for print completion. Requires a CUPS printer on the server machine. Set `ENABLE_PRINTING=true` in `.env` or choose **Print + Digital** in Settings.
- **Print + Digital (cloud relay)** -- The server runs in the cloud. A relay agent on the event laptop polls for print-ready jobs, downloads images, and prints locally. Choose **Print + Digital** in Settings and set `PRINT_RELAY_KEY` in deployment configuration. See [Print Relay](#print-relay-cloud-printing) for full setup.
- **Digital Only** -- Portraits are sent via MMS or share link immediately after AI generation. No printer required. Use this for demos, remote events, or setups without a physical printer. Set `ENABLE_PRINTING=false` or choose **Digital Only** in Settings. An existing relay key can remain configured; printing still stays off.

The delivery mode affects the SMS messages users receive (e.g. "head to the booth to pick up your print" vs "we'll text it to you").

### Immediate Digital Delivery

When **Print + Digital** mode is active, the **Send digital copy immediately** checkbox (enabled by default) sends the user their portrait via SMS right after AI generation -- without waiting for the print to finish. The print still happens in the background.

This ensures users always get their digital portrait within seconds, even if the printer is slow, offline, or broken. If the immediate SMS fails (e.g. Twilio is down), the system falls back to sending the MMS after print completion.

The setting uses the `deliveryDigital` SMS template (the same one used for digital-only delivery). For SMS, `sharePageOnly` sends the share page URL as text instead of the MMS image. WhatsApp always sends its portrait preview card.

Disable this checkbox to restore the original behavior where SMS is gated on print completion.

## Print Relay (Cloud Printing)

The print relay enables physical printing when the app runs in the cloud (Azure, Docker, etc.) and the printer is at the event venue. A polling agent runs on the event laptop and bridges the gap.

There are two ways to run the relay:

| | Print Station App | CLI (`pnpm relay`) |
|---|---|---|
| **Location** | `relay-app/` directory | `scripts/print-relay.js` |
| **Best for** | Event staff, booth operators | Developers, CI/automation |
| **Setup** | Fill in fields in the UI | Edit `.env` file, run terminal command |
| **Distribution** | Build a standalone `.app` bundle | Requires Node.js + repo clone |

### Architecture

```
Cloud App                              Event Laptop
┌────────────────────────┐             ┌────────────────────────┐
│                        │   poll/5s   │  Print Station app     │
│  /api/print-relay/jobs ◄─────────────┤  (or pnpm relay CLI)   │
│                        │             │                        │
│  /api/print-relay/     │   claim     │  1. Poll for ready jobs│
│    jobs/:id/ack        ◄─────────────┤  2. Claim a job        │
│                        │             │  3. Download image     │
│  /api/print-relay/     │  download   │  4. Print via CUPS     │
│    image/:event/:file  ├────────────►│  5. Report completion  │
│                        │             │                        │
│  /api/print-relay/     │  complete   │  Handles: offline      │
│    jobs/:id/complete   ◄─────────────┤  printers, retries,    │
│                        │             │  crashes, reconnects   │
│  digital delivery      │             │                        │
│  usually sent earlier  │             │                        │
└────────────────────────┘             └────────────────────────┘
```

### Setup -- Step 1: Cloud App

Open `/home/settings` on the cloud app. Under **Delivery**, choose **Print + Digital** and click **Save changes**. Generate a strong, unique key (for example, with `openssl rand -hex 32`) and set it as `PRINT_RELAY_KEY` in the cloud deployment configuration. For this repository's GitHub Actions deployment, update the `PRINT_RELAY_KEY` repository secret and run the deployment workflow. The Settings page shows only whether a relay key is configured; it cannot display or change the secret.

The relay key enables and authenticates the relay API. Printing must also be enabled; otherwise generated jobs go straight to `done/` as digital-only jobs and the relay has nothing to claim.

### Setup -- Step 2: Event Laptop

#### Print Station App (Recommended)

The Print Station is a desktop app in the `relay-app/` directory. Event staff click **Edit** to enter the Cloud URL and Relay Key, select one or more printers from the checklist, and click **Connect**. New installations leave both credential fields blank. No terminal or `.env` files are needed. When multiple printers are selected, jobs are distributed automatically across them.

**Install and run:**

```sh
cd relay-app
npm install
npm start
```

**In the app UI:**
1. Click **Edit** next to **Cloud URL**, enter your cloud URL (e.g. `https://your-app.azurecontainerapps.io`), then lock it again if desired
2. Click **Edit** next to **Relay Key**, enter the same key configured as `PRINT_RELAY_KEY` in the cloud deployment, then lock it again if desired
3. Select the **Event to Print**; the station will not connect without an explicit event
4. Select one or more **Printers** from the checklist (or leave all unchecked for auto-detect)
5. Click **Connect**

The status bar shows live indicators for cloud connection (green/yellow/red), per-printer status, and a printed job count. Jobs appear in the Recent Jobs list (showing which printer handled each job) as users submit selfies.

**Multi-printer:** When two or more printers are selected, each gets its own independent worker. Jobs are distributed automatically — whichever printer finishes first grabs the next job from the queue. If one printer jams or goes offline, the other keeps printing. Each printer has its own status indicator so you can see at a glance which one needs attention.

**Building for distribution** -- To create a standalone `.app` that event staff can run without Node.js installed:

```sh
cd relay-app
npm run make
```

This creates the standard Forge zip and an event-staff bundle at `out/make/Twilio Print Station <version> (start here).zip`. Send the **`(start here)`** zip to staff. It contains the `.app`, `READ ME FIRST.txt`, and `Open Twilio Print Station.command` for the first macOS launch.

See **[relay-app/README.md](../relay-app/README.md)** for full documentation including UI overview, features, and project structure.

#### CLI Relay (Alternative)

For developers or automated setups, the CLI relay runs in the terminal. Clone the repo and install dependencies:

```sh
git clone <your-repo-url>
cd twilio-cartoon-printer
pnpm install
```

Create a `.env` file:

```sh
PRINT_RELAY_URL=https://your-cloud-app.example.com
PRINT_RELAY_KEY=<same-random-secret-configured-in-the-cloud-app>
```

Start the relay:

```sh
pnpm relay
```

**Verify** -- You should see:

```
Connected to cloud app (printing: true, size: 5x7, quality: high)
Printer found: EPSON_ET_8550_Series
Polling for print jobs...
```

Text a selfie to your Twilio number. The relay should claim the job, download the image, and print it. With the default **Send digital copy immediately** setting, the user receives the digital portrait after generation and print completion suppresses duplicate MMS. If that setting is disabled, the cloud app sends the MMS after printing succeeds.

### CLI options

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--url` | `PRINT_RELAY_URL` | (required) | Cloud app base URL |
| `--key` | `PRINT_RELAY_KEY` | (required) | Shared secret matching the cloud app |
| `--printer` | `PRINT_RELAY_PRINTER` | auto-detect | Override printer name (single printer) |
| `--printers` | `PRINT_RELAY_PRINTERS` | auto-detect all | Comma-separated printer list for multi-printer |
| `--interval` | `PRINT_RELAY_INTERVAL` | `5` | Poll interval in seconds |
| `--dry-run` | `PRINT_RELAY_DRY_RUN` | `false` | Download images but skip printing |

### Reliability

- **Network drops** -- The relay keeps polling. When the network comes back, it reconnects automatically. No manual intervention needed.
- **Relay crash** -- Print Station v1.1+ posts a heartbeat to the cloud every 20s while it holds a job. If the cloud sees no heartbeat for >60s after the first heartbeat, it moves the job back to `ready/`. A crash before the first heartbeat, and older v1.0 relays without heartbeats, fall back to a 15-minute `printingAt`-age threshold. Either way, the next relay to poll claims the recovered job.
- **Printer offline** -- If the printer is offline or stopped, the relay detects this within seconds and reports failure. The cloud app re-queues the job for retry (up to 3 retries).
- **Multiple printers** -- Select multiple printers in the Print Station app or use `--printers "A,B"` in the CLI to distribute jobs across printers automatically. Each selected/listed printer gets its own worker. In the Print Station app, leaving every printer unchecked starts one unfiltered auto worker that picks the first healthy printer; for production multi-printer setups, explicitly check the printers you want to use. In the CLI, omitting printer flags auto-detects all healthy printers.
- **Multiple agents** -- You can run multiple relay agents with the same key for redundancy. They race to claim jobs; only one wins each job. The others gracefully skip it.
- **Image missing** -- If the output image doesn't exist on the server (e.g. disk error), the relay is told to skip the job and it won't retry for 1 hour.
- **Graceful shutdown** -- Press Ctrl+C in the CLI, or close Print Station. The desktop app lets an in-flight print finish before exiting or switching events.

### Print settings

The relay reads fallback print settings from a cached `/status` response, while each claimed job carries its own snapshotted size, orientation, quality, and validated custom flags. Print Station 1.4.0 adds required event selection, and 1.4.1 adds the DNP DS620 mapping alongside the existing Epson ET-8550 and DNP DS-RX1 mappings. Transient cloud outages do not change an already-claimed job's profile.

## Cloud Deployment

### Docker

```sh
docker build -t twilio-cartoon-printer .
docker run --rm -p 8080:8080 --env-file .env twilio-cartoon-printer
```

The container listens on port 8080 (set in the Dockerfile via `PORT=8080`).

### Persistent storage

Without persistent storage, all data (settings, jobs, downloads, leads) is lost when the container restarts. Mount a volume at `/app/appdata` to persist everything:

```sh
docker run --rm -p 8080:8080 --env-file .env \
  -v /path/to/storage:/app/appdata \
  twilio-cartoon-printer
```

The startup script (`scripts/start.sh`) automatically symlinks these directories to the mount:

| Directory | Contents |
|-----------|----------|
| `data/` | Settings, leads, NPS scores, raffle history |
| `queue/` | Job files in all pipeline stages |
| `downloads/` | Input photos and generated portraits |
| `brand-references/` | Brand reference images for AI generation |
| `style-references/` | Style reference images for AI generation |
| `background-references/` | Background reference images for AI generation |
| `templates/` | Frame overlay PNGs |
| `booth-uploads/` | Uploaded booth videos, QR images, and display media |

Set `DATA_MOUNT` to customize the mount path (defaults to `/app/appdata`). The Docker build intentionally excludes local `booth-uploads/`, `brand-references/`, `style-references/`, and `background-references/`; upload or seed those files into persistent storage after deployment.

### Azure Container Apps

1. Build and push the Docker image to Azure Container Registry
2. Create an Azure Container App with the image
3. Set environment variables (Twilio, OpenAI credentials) in the container app configuration
4. Create an Azure Files share and mount it at `/app/appdata` for persistent storage
5. Point your Twilio webhook to `https://your-app.azurecontainerapps.io/inbound`
6. (Optional) Set up the [print relay](#print-relay-cloud-printing) for physical printing at events

### Twilio webhook

Point your Twilio phone number's Messaging webhook (POST) to:

```
https://your-cloud-app.example.com/inbound
```

No ngrok needed for cloud deployments -- the app is already publicly accessible.

## Lead Capture

The app can collect attendee contact information via a short SMS survey. When enabled, each user completes a one-time survey (per event). Each field can be individually toggled on/off with custom prompts and error messages from the Settings panel:

| # | Field | Validation | Default Prompt |
|---|-------|------------|----------------|
| 1 | First name | Non-empty | "What's your first name?" |
| 2 | Last name | Non-empty | "And your last name?" |
| 3 | Country code | 2-3 letter code | "What country are you from? (2-letter code...)" |
| 4 | Business email | Valid email, personal domains rejected | "What's your business email?" |
| 5 | Company | Non-empty | "What company do you work for?" |
| 6 | Job title | Non-empty | "Last one -- what's your job title?" |

### Modes

Configure Lead Capture from `/home/settings` > **Messaging**. Toggle it on to enable, then choose the timing:

- **Before** -- Survey runs when a user first texts the app. If they sent a selfie, it's held and auto-enqueued after survey completion. If they texted without an image, they're prompted to send a selfie after finishing. On completion the user receives a brief thank-you and proceeds to the normal portrait flow.
- **After** -- Normal flow proceeds (selfie, generation, printing). When the portrait is ready, the completion MMS is held back and the survey starts. After completion, the held portrait is delivered.

The survey only runs once per user per event. Admin phone numbers always skip the survey. Leads persist to `data/leads.json` and survive server restarts. In-memory survey state (active conversations) is lost on restart, but the user's next message will restart the survey if their lead hasn't been saved yet.

### Lead Reports

The Outreach page (`/outreach`) includes a Lead Capture panel that shows captured leads for the selected event. Admins can download a CSV export with all survey fields plus the phone number and capture date.

## Outreach

The Outreach page at `/outreach` is a dedicated tool for engaging attendees after they've used the photobooth. It's accessible from the home page and provides a focused workflow separate from the monitoring-oriented dashboard.

Features:

- **User directory** -- lists every attendee who has generated an image, with masked phone numbers, print counts, art styles used, and time since last activity
- **Event filtering** -- dropdown to filter users by event, matching the dashboard's event selector
- **Broadcast messaging** -- select individual users or "Select All" and compose a message; sends only to attendees with recorded marketing consent for their event and channel
- **Raffle system** -- "Draw Winner" button with an animated random selection that highlights users in sequence before landing on a winner. Winners are automatically persisted to `data/raffle.json` and marked with a trophy icon in the user list
- **Raffle history** -- scrollable list of past raffle winners with timestamps, persisted across server restarts
- **Lead Capture** -- panel showing captured leads for the selected event with a CSV download button for exporting lead data
- **Stat cards** -- at-a-glance counts for total recipients, currently selected, raffle winners drawn, and leads captured

The page uses a two-column layout on desktop (user list on the left, actions on the right) and stacks to a single column on mobile. It auto-refreshes the user list every 10 seconds.

## Configurable SMS Messages

Every SMS message the app sends to users is configurable from `/home/settings` > **Messaging**. Messages are organized into categories:

- **Welcome & Onboarding** -- welcome text, quota counts, multiple photo warning
- **Style Selection** -- menu intro, footer, retry on invalid input
- **Brand Selection** -- menu intro, footer, retry on invalid input (shown when multi-brand is enabled)
- **Background Selection** -- menu intro, footer, retry on invalid input (shown when background selection is enabled)
- **Processing & Delivery** -- enqueue confirmation, pickup instructions, delivery text, last portrait notice, Twilio blurb
- **Error Responses** -- moderation failure, no face detected
- **Lead Capture** -- intro (before/after), completion, CTA
- **NPS** -- prompt and thank you

Messages support `{variable}` interpolation for dynamic values. Available variables depend on the message:

| Variable | Available in | Description |
|---|---|---|
| `{firstName}` | Lead capture completion messages | User's first name from survey |
| `{eventName}` | Welcome count, quota exceeded | Current event name |
| `{maxPrints}` | Welcome count, quota exceeded | Max prints per user |
| `{remaining}` | Remaining count | Prints/portraits left |
| `{unit}` | Welcome count, remaining count | "print"/"prints" or "portrait"/"portraits" (auto-pluralized) |
| `{units}` | Quota exceeded | Plural unit name |
| `{confirmLabel}` | Enqueued | "Your portrait" or "Your {style} portrait" |
| `{styleName}` | Delivery messages | Name of the art style used |

Lead capture survey fields (first name, last name, country, email, company, job title) can each be toggled on/off with custom prompts and error messages.

For WhatsApp and other channels that require Twilio Content Templates, `/home/settings` > **Advanced** > **Twilio routing** includes a **Content Templates** group. Enter an `HX...` Content SID for each message key that needs template delivery. If no Content SID is configured for a key, the app falls back to the plain-text body for that message. Media attachments are only sent for plain-body sends because Twilio Content Template sends are handled separately.

All message customizations are stored in `data/settings.json` and take effect immediately.

## NPS Survey

The app can send a Net Promoter Score survey after a user's final portrait (when their quota is exhausted). When enabled, the app waits a configurable delay (default 30 seconds) after the last delivery, then texts the user asking for a 1-5 rating.

Configure from `/home/settings` > **Messaging**:

- **Enable/Disable** toggle
- **Delay** -- seconds to wait after delivery before sending the prompt (default 30)
- **Prompt and Thank You messages** -- editable in the SMS Messages section

NPS data is visible in:

- **Dashboard** -- NPS Score panel with average rating, response count, and 1-5 distribution bar chart
- **PDF Reports** -- NPS section with average, count, and distribution

Scores persist to `data/nps.json` across restarts. Admin phone numbers are excluded from NPS surveys.

## Social Sharing

When enabled, delivery messages include a single clean share link (e.g. `twil.io/signal-1`) that opens a branded share page. The share page displays the portrait with proper Open Graph meta tags for rich social media previews, and includes per-platform share buttons for X/Twitter, LinkedIn, and Instagram.

### Share Page (`/s/:filePrefix`)

Each portrait gets its own share page at `/s/:filePrefix?e=EventName`. The page is public (no auth required) and includes:

- **OG meta tags** -- `og:image`, `og:title`, `og:description`, `twitter:card: summary_large_image` for rich previews when the URL is shared on any platform
- **Portrait image** -- displayed large and mobile-optimized
- **Share buttons** -- X/Twitter (opens tweet intent), LinkedIn (opens share dialog), Instagram (downloads image for manual upload), and a generic download button
- **Personalized title** -- if the user completed lead capture, the page title uses their first name (e.g. "Alex's AI Portrait"). Falls back to a default title otherwise.
- **Twilio branding** -- custom fonts, brand colors, bug mark, builder shape

### URL Shortening (dub.co)

The app integrates with [dub.co](https://dub.co) to create short links for share pages. Each portrait gets a unique short link with a configurable per-event slug prefix and auto-incrementing counter (e.g. `twil.io/signal-1`, `twil.io/signal-2`).

- Short links are created via the dub.co API when the portrait is delivered
- If shortening fails or no API key is configured, the full share page URL is used as fallback
- The `https://` prefix is stripped from short links in SMS for cleaner display
- Short links are stored in the job JSON so the share page can use them in social share button intent URLs

### Share Page Only Mode

When **SMS Share Page Only** is enabled, the delivery SMS sends only text with the share link -- no MMS image attachment. This avoids showing the portrait twice and saves on MMS costs. It does not affect WhatsApp, which always includes the portrait preview and **View & Share** button.

### Configuration

Configure share behavior from `/home/settings` > **Messaging** > **Social Sharing**. The dub.co key, short domain, and folder ID are in **Advanced**:

**Global settings (infrastructure):**

| Setting | Env var | Default | Description |
|---------|---------|---------|-------------|
| dub.co API Key | `DUB_API_KEY` | *(empty)* | Set in the app environment for URL shortening. If no environment key is set, **Advanced** has a write-only replacement for a saved fallback key. Leave blank to skip shortening. |
| Short Domain | `DUB_DOMAIN` | `twil.io` | Custom short domain configured in dub.co |
| Folder ID | `DUB_FOLDER_ID` | *(empty)* | Optional dub.co folder ID for organizing links |

**Per-event settings:**

| Setting | Default | Description |
|---------|---------|-------------|
| Enable Share Links | `true` | Master toggle for social sharing |
| SMS Share Page Only | `false` | Skip the SMS MMS image and send a text-only share link; WhatsApp is unaffected |
| Enable X/Twitter Share | `true` | Show/hide X/Twitter button on share page |
| Enable LinkedIn Share | `true` | Show/hide LinkedIn button on share page |
| Enable Instagram Share | `true` | Show/hide Instagram save button on share page |
| X/Twitter Handle | `@twilio` | Handle included in pre-filled tweet text |
| X/Twitter Share Text | `"Check out my AI portrait from {eventName}! Made with @twilio on X"` | Pre-filled tweet template |
| LinkedIn Share Text | `"Check out my AI portrait from {eventName}, powered by Twilio!"` | Pre-filled LinkedIn text |
| LinkedIn Company URL | `https://www.linkedin.com/company/twilio-inc-` | Company page URL |
| Instagram Handle | `@twilio` | Shown on save button hint text |
| Slug Prefix | `p` | Per-event prefix for short link slugs (e.g. `signal` → `twil.io/signal-1`) |
| SMS Share Text | `"Share your portrait: {url}"` | Template for the share line in delivery SMS |
| Share Page Title | `"My AI Portrait"` | Default page heading and og:title |
| Share Page Title (Personalized) | `"{firstName}'s AI Portrait"` | Used when lead capture has the user's name |
| Share Page Description | `"Check out my AI portrait, powered by Twilio!"` | og:description for social previews |

## BRB Screen

All three booth displays (intro video, combo, photo book) include a **BRB** button in the bottom toolbar. Clicking it shows a fullscreen "We'll Be Right Back" overlay with animated visuals, the event name, and an optional custom message. Click anywhere to dismiss.

The break message is configurable from `/home/settings` > **Booth display** > **Photo Book & Gallery**. The standalone break screen is also available directly at `/home/break`.

## Promotional Messages

The app can send a standalone promotional message over the attendee's messaging channel after portrait delivery. It is scheduled shortly after delivery, separate from the portrait and status messages.

The promo is eligible after each portrait completion, including repeat users, only when that attendee has a recorded marketing opt-in for the current event and channel. Admin shortcuts are excluded. New events enable the promo with this message:

> Had fun? ⭐ Star the repo and build your own AI photo booth! https://github.com/anthonyplusAI/twilio-cartoon-printer

Configure or turn off the promo from `/home/settings` > **Messaging** > **Promotional**. `PROMO_MESSAGE` in `.env` can replace the default text; leaving the message field empty prevents a promo from being sent.

## Runtime Settings

Open the Settings page at `/home/settings` from Home. It lets admins change creative and operational settings at runtime. Click **Save changes** to apply edits; the page sends only changed fields. Saved values take effect immediately. Overrides persist to `data/settings.json`; per-event values also persist to the active event profile. The search field finds settings across the page.

### Defaults for new events

Newly created events start with these values. Existing event profiles keep their other settings; previously saved built-in starter messages are upgraded to the current default shown above. The SMS and WhatsApp first-message fields contain the opening line; the fixed legal block is added when the draft is created.

| Setting | New-event value |
|---------|-----------------|
| Frame Border | Off; no extra inset between the portrait and template |
| Multi-Subject Photos | Normal |
| Review Mode | Off |
| Booth Display Mode | Static Page |
| SMS first message | `Hit send to start! 🚀` |
| WhatsApp first message | `Hit send to start! 🚀` |
| Milestone Celebrations | On, every 10 portraits |
| Reveal Animation | Pixel (blur-in) |
| Social Sharing | On |
| SMS Share Page Only | Off; include the MMS image |
| Promotional Message | On, with the repo invitation shown above; sent only to attendees with recorded marketing enrollment |

The navigation has six sections:

- **Event** -- Choose or create an event, then use **Switch event**; set attendee language, print limits, generation concurrency, and queue pause state; view the staff mobile QR code.
- **Portrait** -- Manage styles and prompts, multi-subject handling, template frames, branding, and backgrounds. See [Branding](#branding) for details.
- **Delivery** -- Choose Print + Digital or Digital Only, printer and print quality options, immediate digital delivery, and portrait review mode. See [Print Relay](#print-relay-cloud-printing) for cloud printing.
- **Booth display** -- Configure the video or static instruction screen, QR content, photo book, break message, and terms URL.
- **Messaging** -- Configure lead capture, promotional messages, NPS, SMS copy, and social sharing. See [Lead Capture](#lead-capture) for details.
- **Advanced** -- View credential status; configure admin phone numbers, Twilio sender and Messaging Service IDs, Content Template SIDs, OpenAI model choices, and dub.co short-link options.

**Reset & data** is separate from the six settings sections. **Reset settings** restores event and display defaults while keeping connection credentials and the Review PIN configured. **Clear event data** deletes jobs, generated images, leads, contacts, and kiosk submissions for the active event after confirmation; it does not reset settings or the audit history. This is manual cleanup, not an automatic retention policy.

OpenAI, Twilio auth, and print relay secrets are status-only in **Advanced**; the OpenAI key may show its last four characters. Change these secrets in deployment configuration (or local `.env`), not in the browser. Replace or remove the Review PIN at `/review/settings`. The dub.co key can be replaced with a write-only action in **Advanced** only when no deployment-managed `DUB_API_KEY` is set. Other settings are overrides on top of `.env` defaults. See [Switching Events](#switching-events) for the explicit event-switch flow.

The settings API is also available programmatically:

- `GET /dashboard/api/settings` -- current non-secret settings and credential status (never raw key, token, or PIN values)
- `POST /dashboard/api/settings` -- update non-credential settings; credential fields are rejected
- `POST /dashboard/api/settings/credentials/dub` -- write-only saved dub.co key replacement when `DUB_API_KEY` is not deployment-managed
- `POST /dashboard/api/settings/reset-all` -- reset event settings to defaults while retaining connection credentials and the Review PIN
- `POST /dashboard/api/settings/reset` -- legacy per-user compatibility endpoint; does not reset global settings
- `GET /dashboard/api/settings/files` -- list available templates, videos, printers, known events, and event profiles with saved settings
- `GET /dashboard/api/settings/event-styles/:eventName` -- read another event's style prompt overrides (for importing)
- `POST /dashboard/api/settings/upload?type=<type>&filename=<name>` -- upload a file (types: `template`, `video`, `brand-reference`, `style-reference`, `background-reference`, `booth-image`)

## Import Style Prompts

When you craft a great style prompt override for one event and want to reuse it in another, the **Import from another event** button in **Portrait** > **Styles & Art** lets you copy overrides without manual copy-paste.

1. Click **Import from another event** below the custom style form
2. Select a source event from the dropdown (only events with saved profiles appear)
3. The panel shows all style prompt overrides from that event with a preview of each prompt
4. Overrides that differ from the current event are pre-checked
5. Click **Import Selected** to apply the checked overrides to the current event's style prompts
6. Click **Save changes** to persist -- no auto-save, same as any other edit

This only imports style prompt overrides (the text you've customized for each art style). It does not copy custom styles, disabled styles, or any other settings.

## Switching Events

Most creative and operational settings are saved and restored **per event**. Each event keeps its own profile -- art styles, brand references, prompts, SMS messages, lead capture, background config, delivery/display options, and most operator controls. Connection credentials and shared infrastructure keys remain global; the Review PIN belongs to the selected event.

### How it works

In `/home/settings` > **Event**, click the Event name field's arrow to choose a previous event, or type a new name. Selecting a suggestion only fills the field. Click **Switch event** to load or create that event. If you have unsaved edits, save them first; otherwise the page asks whether to discard them before switching. The switch does not auto-save browser edits.

When you switch events, the app:

1. Keeps the current event's last saved profile in `data/events/{eventName}/settings.json`
2. Loads the target event's saved settings (or starts with defaults for a new event)
3. Creates a downloads subfolder for the event
4. Uses the target event's own print counts and data
5. Refreshes the entire Settings UI with the loaded configuration

Events with saved profiles show a **saved** badge in the dropdown. New names show a **Create** suggestion; selecting it still requires **Switch event**.

### What's saved per event

All creative and event-specific settings, including:

- Art styles (custom styles, disabled styles, prompt overrides, default style)
- Branding (brand prompt, brand reference file selection, enabled/disabled brands, brand prompt overrides, brand menu toggle)
- AI prompts (preserve, composition, brand, background, face detection, scene analysis, smart reply)
- Background settings (default prompt, background menu toggle, background choices)
- Booth display mode (video/static/none), static page content (headline, subline, QR image, steps, legal text)
- SMS messages (all categories including brand menu messages)
- Template frame, frame border, video
- Lead capture mode and fields
- Delivery mode, print size/quality
- NPS, promo messages
- Social sharing (platform toggles, handles, share text, slug prefix/counter, share page title/description)
- Max prints per user, terms URL, break message

### What stays global

- Twilio credentials and sender IDs (Account SID, Auth Token, SMS sender, SMS Messaging Service SID, WhatsApp sender, WhatsApp Messaging Service SID)
- OpenAI credentials and model selections
- Print Relay Key
- Custom brands library (brand definitions are shared; per-event controls are disabled brands, scene choices, and prompt overrides)
- Usage overrides
- dub.co connection settings (API Key, Short Domain, Folder ID)

The Review PIN, admin phones, printer selection, concurrency, queue pause state, delivery mode, and most creative/operator controls are per-event in the current settings model. The dub.co slug prefix is also per-event.

### Brand reference images

Brand reference images are stored in a shared library (`brand-references/` folder). Each event **selects** which images to use via checkboxes -- uploading an image adds it to the library and auto-selects it for the current event. Switching events changes the selection, not the files on disk. Deleting an image removes it from the library for all events.

### Example workflow

1. Configure "LAKingsHockey" with hockey jerseys, brand refs, custom styles → **Save changes**
2. Type "GolfTournament" in Event name → select the Create suggestion → click **Switch event** → starts with defaults
3. Upload golf brand refs, configure golf styles → **Save changes**
4. Select "LAKingsHockey" from the dropdown → click **Switch event** → its saved settings load

Previous event data (downloads, completed jobs, leads, NPS scores) is always preserved on disk regardless of which event is active.

## Job Queue

Jobs are managed entirely via the filesystem -- no database or Redis required.

Job files, input photos, and output photos all share the same timestamp prefix so you can easily match them:

```
queue/done/20260211_143000.json
downloads/YourEventName/20260211_143000_input.jpg
downloads/YourEventName/20260211_143000_output.png
```

The pipeline is split into two independent workers:

- **Generation worker** -- Processes up to `MAX_CONCURRENT_GENERATION` jobs at the same time. Each job goes through download, moderation, face detection, scene analysis, AI generation, compositing, and print prep. The scene analysis step describes the subjects in the photo (number of people, positions, pets) so the generation model includes everyone. Multiple images generate in parallel so users don't wait in a long single-threaded queue.
- **Print worker** -- Processes jobs from the `ready/` queue, one per printer. In local mode with multiple printers, smart dispatch reads each job's metadata and pairs it with an idle printer that hasn't failed it before (see [Printer Failure Resilience](#printer-failure-resilience)). Jobs with a `targetPrinter` are only dispatched to that specific printer. In relay mode, the cloud app exposes the ready queue via API and remote agents handle printing.
- **Stale relay recovery** -- Periodically scans `printing/`. For v1.1+ relays (which heartbeat every 20s while holding a job), recovery fires when the last heartbeat is >60s old. For v1.0 relays without heartbeats, falls back to a 15-minute `printingAt`-age threshold. Recovered jobs go back to `ready/` for retry.
- **Stale generation recovery** -- Separately, `sweepStaleGenerating` runs each generation-poll tick and rescues jobs stuck in `generating/` for >5 min (worker crashed, OpenAI call hung, etc.) using the same retry/failover path as boot-time recovery.

Each job tracks timestamps for every state transition (`pendingAt`, `generatingAt`, `readyAt`, `printingAt`, `completedAt`) which are used by the dashboard to compute average generation/print times and detect stuck jobs.

### Crash Recovery

On server restart:

- Jobs in `generating/` are recovered. If the output image already exists on disk, the job skips straight to `ready/` (no re-generation). Otherwise it goes back to `pending/` for retry.
- Jobs in `printing/` are moved back to `ready/` (the image exists, just retry the print).
- Non-permanent jobs in `failed/` are recovered automatically -- routed to `ready/` or `pending/` depending on whether the output image exists.

### Permanent Failures

Jobs flagged by content moderation or rejected by face detection are moved directly to `failed/` without retrying. The user's print count is refunded and they're told it didn't cost a print. Each failed job records a `failReason` field (`moderation`, `face_detection`, `generation`, `printer`, `max_retries`) used by the dashboard's failure breakdown panel.

### Retry Logic

Failed jobs retry up to 3 times. Each pipeline step is skipped on retry if its output already exists on disk, so only the failed step re-runs.

### Printer Failure Resilience

When a print fails, the job tracks which printer failed it in a `failedPrinters` array. On the next dispatch cycle, the smart dispatcher routes the job to a different printer, avoiding all previously failed printers. If all available printers have failed the job, any printer is allowed to retry as a last resort.

This works for both local printing and relay mode:

- **Local:** The `processPrintQueue` dispatcher reads each job's metadata and pairs it with an idle printer not in its `failedPrinters` list.
- **Relay:** The `GET /jobs` API filters out jobs where the requesting printer is in `failedPrinters` (with a last-retry fallback so jobs don't get stuck).

Operators can also **disable a printer** from the dashboard's queue status panel. Disabled printers are excluded from `getActivePrinters()` and receive no new jobs until re-enabled. Disabling a printer also clears `targetPrinter` on any queued jobs aimed at it, so they immediately become available to working printers.

#### Relay Printer Tracking

In cloud deployments, the server has no local CUPS printers. Relay printers self-register when they poll for jobs -- the server records the printer name from the `?printer=` query parameter and tracks when it last checked in. Printers that haven't polled in 60 seconds are considered offline and pruned.

This means the cloud dashboard shows relay printers just like local ones:
- **Disable/Enable** -- disabling a relay printer returns an empty job list to that relay agent, effectively pausing it
- **Printer targeting** -- retry or reprint jobs to specific relay printers from the dashboard dropdowns
- **Stale target auto-clear** -- if a job is targeted to a relay printer that goes offline for 2+ minutes, the targeting is automatically cleared so any available printer can claim it
- **Dashboard warnings** -- the dashboard shows alerts when jobs are waiting but no printers are connected or all printers are disabled (with an additional warning if `immediateDigitalDelivery` is off, meaning users won't receive their portraits at all)

### Reprints

Completed jobs can be reprinted from the dashboard's **Completed Jobs** panel. Click "Reprint" to send the job back through the print queue.

- **No SMS:** The reprint preserves the original `smsSentAt` flag, so no duplicate SMS is sent on print completion.
- **No usage impact:** Reprints don't call `incrementUsage`, and the `reprint: true` flag prevents `decrementUsage` on failure. The usage cache rebuild also skips reprint jobs.
- **Printer targeting:** Select a specific printer from the dropdown, or leave it on "Any printer" (default). In cloud mode, relay printer names appear in the dropdown automatically.
- **If the reprint fails:** It follows the standard retry logic (up to 3 retries, failed printer avoidance). If all retries exhaust, the job moves to `failed/` and can be retried again from the failed jobs panel.

## Project Structure

```
twilio-cartoon-printer/
├── index.js              Express app, Twilio webhook, server startup
├── lib/
│   ├── config.js         Static constants, paths, API clients
│   ├── settings.js       Runtime mutable settings (persists to data/settings.json)
│   ├── styles.js         Art style definitions and prompts
│   ├── helpers.js        Image download, SMS, moderation, face detection, compositing, AI smart replies
│   ├── style-menu.js     Style selection menu after selfie (numbered list, pending state)
│   ├── brand-menu.js     Brand selection menu after style choice (numbered list, pending state)
│   ├── brands.js         Brand library -- active brands, brand resolution for pipeline
│   ├── background-menu.js Background selection menu after brand/style choice (numbered list, pending state)
│   ├── printer.js        Printer discovery and print commands
│   ├── pipeline.js       generateImage (steps 1-6) and printJob (steps 7-8)
│   ├── queue.js          Concurrent generation worker, serial print worker, usage tracking, stale relay recovery
│   ├── print-relay.js    Cloud-side relay API (poll, claim, download, complete endpoints)
│   ├── dashboard.js      Admin dashboard (mounted at /dashboard)
│   ├── home.js           Home page, separate settings page, intro video, booth display (mounted at /home)
│   ├── brb.js            Shared BRB overlay (CSS, HTML, script) used by all booth displays
│   ├── leads.js          Lead capture SMS survey engine and persistence
│   ├── nps.js            NPS survey engine and persistence
│   ├── outreach.js       Outreach -- broadcast messaging, raffles, lead reports (mounted at /outreach)
│   ├── photogallery.js   Photo book (mounted at /photogallery)
│   ├── share.js          Shareable portrait page with OG meta tags (mounted at /s)
│   ├── dub.js            dub.co URL shortening client with in-memory cache
├── scripts/
│   ├── print-relay.js    Local relay agent -- polls cloud, downloads images, prints via CUPS
│   └── start.sh          Docker entrypoint -- symlinks dirs to persistent storage
├── docs/
│   └── GUIDE.md          Detailed documentation (this file)
  ├── assets/               Shipped static assets, fonts, CSS, and in-image media
  ├── booth-uploads/        Uploaded booth videos, QR images, and display media
  ├── brand-references/     Brand reference images for AI generation
  ├── style-references/     Style reference images for AI generation
  ├── background-references/ Background reference images for AI generation
├── templates/            Frame overlays (PNGs with transparent center)
│   └── signal_sf.png     Example: SIGNAL SF branded frame
├── downloads/            Generated images, organized by event name
│   └── YourEventName/
│       ├── 20260211_143000_input.jpg
│       └── 20260211_143000_output.png
├── queue/                File-based job queue
│   ├── pending/          New jobs waiting for generation
│   ├── generating/       Jobs currently generating AI images (up to N concurrent)
│   ├── ready/            Generation complete, waiting to print or relay
│   ├── printing/         Job currently being printed (local or relay)
│   ├── done/             Successfully printed/delivered jobs
│   └── failed/           Permanent failures or max retries exceeded
├── data/                 Persistent app data
│   ├── events/           Per-event settings profiles
│   │   └── YourEventName/
│   │       └── settings.json  Saved per-event overrides
│   ├── leads.json        Captured leads — keyed by phone:event (gitignored)
│   ├── nps.json          NPS survey scores — keyed by phone:event (gitignored)
│   ├── raffle.json       Raffle winner history
│   └── settings.json     Active runtime settings overrides
├── .env                  API keys, printer config, event settings
├── .env.example          Template with all available environment variables
├── Dockerfile            Production container image
├── .gitignore            Excludes local runtime data, secrets, logs, and dependencies
├── package.json
└── pnpm-lock.yaml
```
