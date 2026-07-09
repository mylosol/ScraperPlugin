# QA Update Scraper — Chrome Extension

A private Chrome Extension that scrapes an Azure DevOps **Kanban Board**
and compiles QA Update email tables — no manual copy-pasting required.

---

## Installation (Developer / Unpacked)

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this repo's folder (`ScraperPlugin`)
5. The **QA** icon will appear in your toolbar (pin it for easy access)

---

## Daily Workflow

### Step 1 — Create a table
Click the extension icon. On first use (or after clicking **+ New Table**),
enter a table name, e.g.:
- `Cases pushed to feature branch`
- `Cases pushed to develop`

### Step 2 — Scrape the board
1. Navigate to your team's Azure DevOps **Kanban Board**
   (`.../_boards/board/t/{team}/{Backlog level}`)
2. Click the extension icon
3. Click **Scrape This Page**

Every card visible on the board — any column — is scraped in one pass; the
active filter (see below) determines which rows actually show up in the
table. Re-scraping is safe: duplicate rows are skipped automatically, so
you can scrape again after the board changes to pick up new/moved cards.

### Step 3 — Copy the table
- **📋 Copy for Email** — copies a rich-text HTML table; paste directly into
  Outlook, Gmail, etc. Formatting and color-coded status badges are preserved.
- **📄 Copy Plain Text** — copies a fixed-width plain-text table.

Both exports only include rows matching the **active filter set**.

### Step 4 — Start the next table
Click **+ New Table**, enter a new name, and repeat the scrape process.

---

## Filter Rules (🔎)

Click the **🔎** button in the header to open the rule builder. It's modeled
on the Azure DevOps Query editor:

- Each row has **And/Or**, **Field**, **Operator**, **Value**.
- Rows are combined **left to right** using each row's own And/Or (the
  first row's And/Or is ignored — there's nothing before it). This is a
  flat list, not nested groups.
- **+ Add rule** appends a row; the **✕** on a row deletes it.
- A card must match the combined result of all rows to appear in the table.
  With zero rules, every scraped card is shown.

### Available fields
| Field | Source |
|---|---|
| Column | The card's Kanban board column (`System.BoardColumn`) |
| State | The parent work item's state |
| Work Item Type | e.g. Product Backlog Item, Bug, User Story |
| Title | The parent work item's title |
| Parent Assigned To | The parent work item's assignee |
| QA Task Assigned To | The assignee of a QA task on the card (if any) |
| QA Task Title | The title of a QA task on the card (if any) |
| Has QA Task | True/False — whether the card has a task whose title starts with "QA" |

Operators depend on the field type: text fields get `is`, `is not`,
`contains`, `does not contain`, `in`, `not in`, `is empty`, `is not empty`
(`in`/`not in` take a comma-separated list of values); the boolean field
gets `is` with a True/False value.

### Default filter set
Ships preloaded as **"Ready & In QA (default)"**:

> Column **in** `Ready For QA, In QA`

### Saved filter sets
Next to the rule rows, use the **filter set** dropdown to switch between
saved sets, or:
- **+ New** — save the rules you're editing as a new named set
- **✏ Rename** — rename the current set
- **🗑 Delete** — delete the current set (at least one set must always exist)

Filter sets are saved to `chrome.storage.sync`, so they follow your signed-in
Chrome profile and survive closing the popup. Click **Apply** to save your
edits, or **Cancel** to discard them and revert to how the set looked when
you opened the builder.

---

## Table columns

| Column | What it shows |
|---|---|
| Case # | Link to the parent work item |
| Title | Parent work item title |
| Assigned To | Both **QA Task** and **Parent** assignees, with a per-row dropdown to pick which one is "active" (bolded here, and the one used for email/text export). Defaults to QA Task if the card has one, otherwise Parent. |
| Status | A friendly label — `Ready` for the `Ready For QA` column, `In Progress` for the `In QA` column, otherwise the raw board column name. The real board column is shown as smaller subtext when it differs from the label. |
| Notes | Linked build number (if any) and Feature Branch/Develop annotations for QA tasks |

Each row also has a **✕** to remove it from the table, and rows can be added
manually via **+ Add Row** (ADO lookup by case number/URL, or fully manual
entry).

### Swimlanes
If your board uses swimlanes, rows are automatically grouped under a
swimlane header — in the popup table, the copied email table, and the
plain-text export — matching how the cards are grouped on the board itself.
Cards on the unnamed default lane are grouped under **Default** and always
listed first; other lanes follow alphabetically. If the whole board uses
only the default lane, no swimlane headers are shown at all. Swimlane is
also available as a **Field** in the Filter Rules builder, so you can
filter down to a specific lane (e.g. "Expedite") if you want.

---

## Undo
If you scraped the wrong page, click **↩ Undo Last** to remove that page's items.

## Clear Table
Removes all accumulated items and resets the current table.

---

## Settings

Click the **⚙** gear icon to configure:

| Setting | Default | Description |
|---|---|---|
| Row sort order | By Case # (ascending) | Sort by Case # or alphabetically by board Column |
| Personal Access Token | (none) | See below — only needed for Azure AD-backed orgs |

### Personal Access Token (Azure AD orgs)
Some Azure DevOps organizations are backed by Azure AD (Entra ID) sign-in.
For those orgs, the browser session cookies the extension normally relies
on aren't sufficient to authenticate its background API calls — you'll see
scrapes fail with `Not signed in to Azure DevOps (401)` even though the
board itself loads fine in the browser.

If that happens, create a PAT and paste it into Settings:

1. In Azure DevOps, click your profile icon (top right) → **Personal access
   tokens** → **+ New Token**
2. Name it something like "QA Update Scraper", set an expiration you're
   comfortable with, and grant these scopes (read-only is enough):
   - **Work Items** → Read
   - **Project and Team** → Read
3. Copy the generated token (you won't be able to see it again)
4. In the extension, click **⚙** → paste it into **Personal Access Token**
   → **Save Settings**

The token is stored only in `chrome.storage.local` on this machine — it's
never synced or sent anywhere except your own Azure DevOps organization's
API. Leave it blank if cookie-based auth already works for your org; the
extension falls back to that automatically.

---

## Supported Azure DevOps Formats

- `https://dev.azure.com/{org}/{project}/_boards/board/t/{team}/{Backlog level}`
- `https://{org}.visualstudio.com/{project}/_boards/board/t/{team}/{Backlog level}`

---

## Troubleshooting

**"Not an Azure DevOps Kanban Board page"**
Make sure you are on a Board URL (see formats above), not a Sprint
Taskboard/Backlog, Repos, or Pipelines view.

**"Not signed in to Azure DevOps (401)"**
If refreshing the ADO tab and re-scraping doesn't fix it, your org likely
uses Azure AD sign-in and needs a Personal Access Token — see
[Settings](#personal-access-token-azure-ad-orgs) above.

**"ADO API error 403"**
Your account does not have permission to read this project's work items.

**No items returned**
The board may have no cards matching the active filter set — open **🔎
Filter Rules** and check what's configured, or switch to a broader/default
set. If the table shows "0 of N items (filtered)", N items were scraped but
none matched — that's the filter working as intended, not an error.

**Content script not injecting**
The extension will automatically re-inject the content script on the first
scrape. If it still fails, refresh the Azure DevOps page and try again.

---

## Privacy

All processing happens locally in your browser. No data is sent anywhere
other than the Azure DevOps REST API of your organization (the same API
your browser already calls when you view the board), and — for saved
filter sets — Chrome's own sync storage.
