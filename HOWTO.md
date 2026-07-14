# QA Update Scraper — How to Use

The QA Update Scraper is a Chrome extension that reads your team's Azure DevOps **Kanban Board** and builds a ready-to-send QA status table — no manual copy-pasting between the board and an email.

---

## 1. Install the Extension

The extension isn't published to the Chrome Web Store — it's installed as an unpacked extension from source.

1. Download or clone the repository: `https://github.com/mylosol/ScraperPlugin`
2. Open Chrome and go to `chrome://extensions`
3. Turn on **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `ScraperPlugin` folder
5. A **QA** icon appears in your toolbar — click the puzzle-piece icon and pin it for easy access

To pick up updates later: pull the latest code, then click the **Reload** icon on the extension's card in `chrome://extensions`. After reloading, also refresh any open Azure DevOps tab before scraping again.

---

## 2. Choosing a Sign-In Method

Click the **⚙** (Settings) icon → **Sign-in method** to choose how the extension authenticates to Azure DevOps:

| Method | When to use it |
|---|---|
| **Browser session (cookies)** | Default. Works out of the box for most Azure DevOps organizations. |
| **Personal Access Token** | Needed for organizations that use Azure AD (Entra ID) sign-in — you'll know because a scrape fails with **"Not signed in to Azure DevOps (401)"** even though the board loads fine in your browser. |

### Setting up a Personal Access Token
1. In Azure DevOps, click your profile icon (top right) → **Personal access tokens** → **+ New Token**
2. Name it something like `QA Update Scraper`, set an expiration you're comfortable with
3. Under scopes, grant (read-only is enough):
   - **Work Items** → Read
   - **Project and Team** → Read
4. Click **Create**, then copy the token — you won't be able to see it again
5. In the extension, click **⚙** → set **Sign-in method** to **Personal Access Token** → paste it into the field that appears → **Save Settings**

**Important:** the token is kept only in the extension's background memory for your current browser session — it is **never written to disk** (not to `chrome.storage`, not anywhere else). This means:
- It clears whenever Chrome fully restarts, the extension is reloaded, or after a period of browser inactivity — you'll need to paste it again in Settings when that happens.
- If a scrape fails with a message asking you to re-enter your token, that's why — go back to **⚙ → Personal Access Token** and paste it in again.
- Check the **Sign-in method** back to **Browser session (cookies)** at any time to stop using a token entirely; nothing needs to be cleared out first.

**Save the token in 1Password** as a new entry (e.g. "ADO PAT — QA Update Scraper") right after you create it, so you have a compliant place to copy it back from each time the extension asks for it again. Don't keep a copy anywhere else (a text file, a note, etc.).

If your organization doesn't need a token, leave the sign-in method on **Browser session (cookies)** — that's the default and requires no setup.

---

## 3. Daily Workflow

### Step 1 — Create a table
Click the extension icon. On first use (or after **+ New Table**), give the table a name, e.g.:
- `Cases pushed to feature branch`
- `Sprint 42 QA Update`

### Step 2 — Scrape the board
1. Navigate to your team's Azure DevOps **Kanban Board**
2. Click the extension icon
3. Click **Scrape This Page**

The extension reads every card currently on the board — every column, every swimlane — in one pass. Your **Filter Rules** (see below) then decide which rows actually show up in the table. It's safe to scrape the same board again later (e.g. after standup) to pick up new or moved cards — duplicates are skipped automatically.

### Step 3 — Review the table
Rows are grouped by **swimlane** (if your board uses them), and each row shows:

| Column | What it shows |
|---|---|
| Case # | Link straight to the work item in Azure DevOps |
| Title | The parent work item's title |
| Assigned To | Both the **QA Task** assignee and the **Parent** assignee, with a dropdown to pick which one counts as the "real" assignee for this row (defaults to QA Task if one exists, otherwise Parent) |
| Status | A friendly label — `Ready` for the Ready For QA column, `In Progress` for the In QA column, or the board's own column name for anything else |
| Notes | Linked build number (if any), plus Feature Branch / Develop callouts for QA tasks |

Click **✕** on any row to remove it from the table without affecting the real board.

### Step 4 — Copy the table for your update
- **📋 Copy for Email** — copies a formatted, color-coded HTML table. Paste directly into Outlook, Gmail, Teams, etc.
- **📄 Copy Plain Text** — copies a fixed-width plain-text version, useful for Slack or chat.

Both only include the rows currently matching your active filter — see below.

### Step 5 — Start the next table
Click **+ New Table** and repeat.

---

## 4. Filter Rules (the 🔎 button)

By default, the table shows cards where **Column is Ready For QA or In QA** — that's the standard "what does QA need to look at" view. Click the **🔎** button to see or change this.

The rule builder works like the Azure DevOps Query editor:

- Each row has **And / Or**, **Field**, **Operator**, **Value**
- Rows combine **left to right** (the first row's And/Or doesn't matter — there's nothing before it to combine with)
- **+ Add rule** adds a row; **✕** removes one
- A card must satisfy the combined result of every row to show up. With zero rules, everything scraped is shown.

**Available fields:** Column, Swimlane, State, Work Item Type, Title, Parent Assigned To, QA Task Assigned To, QA Task Title, Has QA Task.

**Operators** (for text fields): is, is not, contains, does not contain, in, not in, is empty, is not empty. `in` / `not in` take a comma-separated list, e.g. `Ready For QA, In QA`. The boolean field (`Has QA Task`) just takes True/False.

### Saving multiple filter sets
Next to the rule rows there's a **filter set** dropdown:
- **+ New** — save your current rules as a new named set (e.g. "Blocked items only", "Everything in QA")
- **✏ Rename** — rename the set you're currently editing
- **🗑 Delete** — delete it (you always need at least one set)

Filter sets are saved to your Chrome profile and are still there next time you open the extension. Click **Apply** to save your edits and re-filter the table, or **Cancel** to discard changes and go back to how the set looked when you opened the builder.

---

## 5. Adding Rows Manually

Click **+ Add Row** for two ways to add a row that wasn't picked up (or wasn't on the board) automatically:

**ADO Lookup tab** — type a case number or paste an ADO URL, click **Look up**, then check the child task(s) you want added as rows. Useful for pulling in a specific case regardless of what column/filter it's currently in.

**Manual Entry tab** — type everything in by hand (Case #, Title, Assigned To, Column, Swimlane, Notes) for a card that doesn't exist in ADO yet, or that you want to represent differently than what's on the board.

---

## 6. Settings (the ⚙ button)

| Setting | What it does |
|---|---|
| Row sort order | Sort the table by Case # (ascending) or alphabetically by Column |
| Sign-in method | Browser session (cookies) or Personal Access Token — see [section 2](#2-choosing-a-sign-in-method) above |

---

## 7. Other Useful Buttons

- **↩ Undo Last** — appears after a scrape; removes just the items added by your most recent scrape (handy if you scraped the wrong board or team)
- **🗑 Clear Table** — wipes everything in the current table and starts fresh (confirms before deleting)

---

## 8. Troubleshooting

**"Not an Azure DevOps Kanban Board page"**
Make sure you're on a Board URL, not a Sprint Taskboard/Backlog, Repos, or Pipelines page. Board URLs look like `.../_boards/board/t/{team}/{Backlog level}`.

**"Not signed in to Azure DevOps (401)"**
Refresh the Azure DevOps tab and try again. If it still fails, your org likely needs a Personal Access Token — see [section 2](#2-choosing-a-sign-in-method).

**"Enter your Personal Access Token in Settings…"**
You've selected the Personal Access Token sign-in method, but the token isn't currently held in memory (it clears on browser restart, extension reload, or after a period of inactivity — see [section 2](#2-choosing-a-sign-in-method)). Open **⚙ Settings** and paste it in again.

**"403" error**
Your account doesn't have permission to read this project's work items — check with your ADO admin.

**Table shows "0 of N items (filtered)"**
N cards were scraped but none matched your active filter — that's the filter working correctly, not a bug. Open **🔎 Filter Rules** and check what's configured, or switch to a broader set.

**No swimlane headers even though your board has swimlanes**
If you scraped before this feature was added, old rows in that table won't have swimlane data. Click **🗑 Clear Table** (or start a **+ New Table**) and scrape fresh.

**Nothing happens when I click Scrape**
Refresh the Azure DevOps tab, then try again — this forces the extension to inject a fresh copy of its scraper into the page.

---

## 9. Privacy

All processing happens locally in your browser. The extension only talks to your own Azure DevOps organization's API (the same one your browser already calls when you view the board). If you use the Personal Access Token sign-in method, the token is held in memory only for your current browser session and is never written to disk — nothing is sent to any third party either way.
