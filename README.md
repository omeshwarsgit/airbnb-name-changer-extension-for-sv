# StayVista Airbnb Renamer

Chrome side-panel extension + Google Sheet tracker for updating Airbnb listing titles in bulk.

- Opens each listing's **Title** page on airbnb.co.in/hosting and edits **only the English title** (max 50 characters).
  The **Internal name**, description and other fields are never touched.
- **Assisted mode** (default): the new name is filled in, a person presses **Save & next**.
  **Auto mode**: saves by itself with random gaps and a daily limit.
- Every save is re-read from Airbnb and logged in the Google Sheet (old name, new name, who, when, status).

## Install (team members)
1. Code → Download ZIP, unzip into Documents (or `git clone`).
2. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → select the `extension` folder.
3. Open the side panel → Settings → your name, the Web app URL and token (ask the admin) → Test connection.
4. Run **Test one listing** before the first batch.

Full setup, including the one-time Google Sheet / Apps Script deployment: [SETUP.md](./SETUP.md).

## Updating
`git pull` (or download the ZIP again), then click ↻ on the extension in `chrome://extensions`.

## Privacy
Do not commit the Apps Script URL, token, listing exports or logs. They are entered in the extension's Settings only.

## Note
Airbnb's terms restrict automated changes. Prefer Assisted mode; use Auto mode only where permitted.

SheetJS 0.18.5 is bundled at `extension/lib/xlsx.full.min.js` under its own licence.
