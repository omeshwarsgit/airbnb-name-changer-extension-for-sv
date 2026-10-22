# StayVista Airbnb Renamer — setup (about 10 minutes, all free)

## 1. Make the tracker Google Sheet
1. Create a new Google Sheet (e.g. "Airbnb Rename Tracker").
2. Extensions → Apps Script. Delete what's there, paste all of `google-sheet/Code.gs`, Save.
3. Choose the function `setup` → Run → allow the permissions. A box shows your **token**
   (it's also kept in the sheet's *Settings* tab).
4. Deploy → New deployment → type **Web app** → Execute as **Me**, Who has access **Anyone** → Deploy.
   Copy the **Web app URL** (ends in `/exec`).

The sheet now has:
- **Queue**: one row per listing. Fill Listing Link, Property Name, New Name (or import from the extension).
  The tool fills Status, Old Name, Name After Save, Mode, Done By, times, Attempts and Notes.
- **Summary**: counts by status, % complete, done today, done per person per day.
- Menu **Airbnb Renamer**: release stuck rows, send Failed rows back to Pending.

## 2. Install the Chrome extension
1. Unzip, open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → pick the `extension` folder. Pin the icon.
3. Click the icon → the side panel opens → **Settings**: your name, the Web app URL, the token → Save → Test connection.

## 3. Daily use
1. Log in to the Airbnb host account in the same Chrome.
2. Add listings: upload the names file under **Add listings to the sheet** (or paste rows into the Queue tab).
3. First time: **Test one listing** with any link — it must say "Looks good". If Airbnb uses a different
   domain/URL for its title page, change "Airbnb title page" in Settings (keep `{id}`).
4. Pick a mode, set "Listings this run", press **Start**.
   - **Assisted**: each listing opens with the new name filled in. Check it, press **Save & next** (or Ctrl+Enter).
     You can edit the name in Airbnb's box first; the edit is recorded.
   - **Auto**: the tool saves by itself with a random 25–60 s gap. Use small batches.
5. Every save is re-checked by reloading the page; the sheet gets **Done** only if Airbnb really shows the new name.

## Safety built in
- Stops at once on an Airbnb login or human-check page, and after 3 failures in a row.
- Daily limit (default 300, all modes). Names over 50 characters are never sent.
- Several people can run it together: each row is claimed by one person; abandoned rows free up after 30 min.
- The old name is kept in the sheet, so any listing can be put back.

Airbnb's terms don't allow bots. Assisted mode keeps a person pressing every Save; use Auto mode with care.
