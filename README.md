# QA Update Scraper — Chrome Extension

A private Chrome Extension that scrapes Azure DevOps Sprint Taskboards/Backlogs
and compiles QA Update email tables — no manual copy-pasting required.

---

## Installation (Developer / Unpacked)

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `qa-update-extension` folder
5. The **QA** icon will appear in your toolbar (pin it for easy access)

---

## Daily Workflow

### Step 1 — Create a table
Click the extension icon. On first use (or after clicking **+ New Table**),
enter a table name, e.g.:
- `Cases pushed to feature branch`
- `Cases pushed to develop`

### Step 2 — Scrape pages
1. Navigate to an Azure DevOps sprint **Taskboard** or **Backlog**
2. Click the extension icon
3. Click **Scrape This Page**
4. Repeat for as many sprint board pages as needed (data accumulates)

### Step 3 — Copy the table
- **📋 Copy for Email** — copies a rich-text HTML table; paste directly into
  Outlook, Gmail, etc. Formatting and color-coded status badges are preserved.
- **📄 Copy Plain Text** — copies a fixed-width plain-text table.

### Step 4 — Start the next table
Click **+ New Table**, enter a new name, and repeat the scrape process.

---

## Status Logic

| Email Status | PBI/Bug State | Code Solution | Code Review | Dev Test | QA Task State |
|---|---|---|---|---|---|
| **Ready** | Committed | Done | Done | Done | To Do |
| **QA Test in progress** | Committed | Done | Done | Done | In Progress |
| **Blocked** | Blocked | Done | Done | Done | To Do |
| **Pending Dev Test** | Committed | Done | Done | To Do | (any) |
| **Dev Test in progress** | Committed | Done | Done | In Progress | (any) |

**Notes about the logic:**
- If a task type (e.g., Code Review) doesn't exist on a PBI, that check is skipped.
- Multiple QA tasks on one PBI produce separate rows (one per person/branch).
- If a QA task title contains "Feature Branch" or "Develop", that is noted in the Notes column.
- "Integrated in Build" comes from the `Microsoft.VSTS.Build.IntegrationBuild` field.

### Recognized task name patterns
| Category | Matches (case-insensitive) |
|---|---|
| Code Solution | `Code the Solution`, `Code Solution` |
| Code Review | `Code Review` |
| Dev Test | `Dev Test` (but NOT `Dev Automated Test`) |
| QA Task | Any title containing `QA` |

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
| Integrated in Build field | `Microsoft.VSTS.Build.IntegrationBuild` | ADO field name for build version |
| Status sort order | By priority | How rows are sorted in the output |

---

## Supported Azure DevOps Formats

- `https://dev.azure.com/{org}/{project}/_sprints/taskboard/{team}/...`
- `https://dev.azure.com/{org}/{project}/_sprints/backlog/{team}/...`
- `https://{org}.visualstudio.com/{project}/_sprints/taskboard/{team}/...`

---

## Troubleshooting

**"Not an Azure DevOps sprint page"**  
Make sure you are on a Sprint Taskboard or Backlog URL (see formats above).
The extension does not work on the Boards, Repos, or Pipelines views.

**"ADO API error 401"**  
You are not logged in. Log into Azure DevOps in Chrome, then try again.

**"ADO API error 403"**  
Your account does not have permission to read this project's work items.

**No items returned**  
The current sprint may have no work items matching the QA Update criteria,
or the sprint detection may have fallen back to the wrong iteration.
Ensure you are on a sprint taskboard or backlog for the correct sprint.

**Content script not injecting**  
The extension will automatically re-inject the content script on the first scrape.
If it still fails, refresh the Azure DevOps page and try again.

---

## Privacy

All processing happens locally in your browser. No data is sent anywhere
other than the Azure DevOps REST API of your organization (the same API
your browser already calls when you view the sprint board).
