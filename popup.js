// ============================================================
// QA Update Scraper — popup.js
// ============================================================

// ── Constants ─────────────────────────────────────────────────

// Deterministic pastel palette for board-column badges (columns are
// user-defined on a Kanban board, so we can't hardcode a color map).
const COLUMN_PALETTE = [
  { bg: '#cce5ff', color: '#004085' },
  { bg: '#d4edda', color: '#155724' },
  { bg: '#fde8c8', color: '#7a3e00' },
  { bg: '#f8d7da', color: '#721c24' },
  { bg: '#e2d9f3', color: '#5a3489' },
  { bg: '#fff3cd', color: '#856404' },
  { bg: '#d2f0ea', color: '#0f5c52' },
];
function styleForColumn(column) {
  let hash = 0;
  for (let i = 0; i < column.length; i++) hash = (hash * 31 + column.charCodeAt(i)) >>> 0;
  return COLUMN_PALETTE[hash % COLUMN_PALETTE.length];
}

// Friendly label for the default QA workflow columns; any other board
// column (custom rule sets can filter on anything) falls back to its
// own name so it's still shown clearly.
const READY_IN_PROGRESS_LABELS = {
  'Ready For QA': 'Ready',
  'In QA':        'In Progress',
};
function statusLabelFor(column) {
  return READY_IN_PROGRESS_LABELS[column] || column;
}

const STORAGE_KEY = 'qaScraperTables';
const SETTINGS_KEY = 'qaScraperSettings';
const RULE_SETS_SYNC_KEY = 'qaScraperRuleSets'; // chrome.storage.sync — small, so it can follow the user across machines

// ── State ──────────────────────────────────────────────────────

let state = {
  tables:       [],   // [{id, name, items: [], pagesScraped, boardName, createdAt}]
  activeTableId: null,
  view:         'new-table', // 'new-table' | 'main' | 'settings' | 'rules'
  scraping:     false,
  settings: {
    sortOrder:  'id',
  },
  ruleSets:         [],   // [{id, name, rules}]
  activeRuleSetId:  null,
};

let ruleBuilderSnapshot = null; // deep clone of {ruleSets, activeRuleSetId} taken when the builder opens, restored on Cancel

function getActiveRuleSet() {
  return state.ruleSets.find(s => s.id === state.activeRuleSetId) || state.ruleSets[0];
}

// ── DOM refs ───────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const DOM = {
  views: {
    newTable: $('view-new-table'),
    main:     $('view-main'),
    settings: $('view-settings'),
    addRow:   $('view-add-row'),
    rules:    $('view-rules'),
  },
  header: {
    tableLabel: $('current-table-label'),
    btnSettings:$('btn-settings'),
    btnRules:   $('btn-open-rules'),
  },
  rules: {
    setSelect:    $('rule-set-select'),
    btnNewSet:    $('btn-new-rule-set'),
    btnRenameSet: $('btn-rename-rule-set'),
    btnDeleteSet: $('btn-delete-rule-set'),
    rows:         $('rule-rows'),
    emptyHint:    $('rule-empty-hint'),
    btnAdd:       $('btn-add-rule'),
    btnApply:     $('btn-apply-rules'),
    btnCancel:    $('btn-cancel-rules'),
  },
  newTable: {
    nameInput:  $('table-name-input'),
    btnCreate:  $('btn-create-table'),
    btnCancel:  $('btn-cancel-create'),
  },
  main: {
    sprintStrip:      $('sprint-strip'),
    sprintName:       $('sprint-name-display'),
    pagesScraped:     $('pages-scraped-display'),
    statusBar:        $('status-bar'),
    statusIcon:       $('status-icon'),
    statusText:       $('status-text'),
    btnScrape:        $('btn-scrape'),
    btnUndo:          $('btn-undo-page'),
    chipsRow:         $('status-chips'),
    tableWrapper:     $('table-wrapper'),
    tableCount:       $('table-count'),
    resultsBody:      $('results-body'),
    btnCopyHtml:      $('btn-copy-html'),
    btnCopyText:      $('btn-copy-text'),
    btnNewTable:      $('btn-new-table'),
    btnClearTable:    $('btn-clear-table'),
  },
  settings: {
    sortOrderSelect:  $('sort-order-select'),
    btnSave:          $('btn-save-settings'),
    btnClose:         $('btn-close-settings'),
  },
  toast: $('toast'),
};

// ── Storage helpers ────────────────────────────────────────────

async function loadState() {
  return new Promise(resolve => {
    chrome.storage.local.get([STORAGE_KEY, SETTINGS_KEY], result => {
      if (result[STORAGE_KEY]) {
        state.tables        = result[STORAGE_KEY].tables        || [];
        state.activeTableId = result[STORAGE_KEY].activeTableId || null;
      }
      if (result[SETTINGS_KEY]) {
        state.settings = { ...state.settings, ...result[SETTINGS_KEY] };
      }
      resolve();
    });
  });
}

function saveState() {
  chrome.storage.local.set({
    [STORAGE_KEY]:  { tables: state.tables, activeTableId: state.activeTableId },
    [SETTINGS_KEY]: state.settings,
  });
}

async function loadRuleSets() {
  return new Promise(resolve => {
    chrome.storage.sync.get([RULE_SETS_SYNC_KEY], result => {
      const saved = result[RULE_SETS_SYNC_KEY];
      if (saved && Array.isArray(saved.ruleSets) && saved.ruleSets.length) {
        state.ruleSets        = saved.ruleSets;
        state.activeRuleSetId = saved.activeRuleSetId || saved.ruleSets[0].id;
        resolve();
      } else {
        // First run — seed with the default rule set and persist it.
        state.ruleSets        = [JSON.parse(JSON.stringify(DEFAULT_RULE_SET))];
        state.activeRuleSetId = DEFAULT_RULE_SET.id;
        saveRuleSets();
        resolve();
      }
    });
  });
}

function saveRuleSets() {
  chrome.storage.sync.set({
    [RULE_SETS_SYNC_KEY]: { ruleSets: state.ruleSets, activeRuleSetId: state.activeRuleSetId },
  });
}

// ── Table helpers ──────────────────────────────────────────────

function getActiveTable() {
  return state.tables.find(t => t.id === state.activeTableId) || null;
}

function createTable(name) {
  const table = {
    id:           Date.now().toString(),
    name:         name.trim(),
    items:        [],
    pagesScraped: 0,
    boardName:    '',
    createdAt:    new Date().toLocaleString(),
    pageSnapshots:[],  // [{pageUrl, itemIds, scrapedAt}]
  };
  state.tables.push(table);
  state.activeTableId = table.id;
  saveState();
  return table;
}

function mergeItems(existing, incoming) {
  // Merge incoming items; avoid duplicate rows (rowKey already encodes card+column+task)
  const existingKeys = new Set(existing.map(i => i.rowKey));
  const added = [];
  incoming.forEach(item => {
    if (!existingKeys.has(item.rowKey)) {
      existing.push(item);
      existingKeys.add(item.rowKey);
      added.push(item);
    }
  });
  return added;
}

// Rows in the active table that match the active rule set.
function getVisibleItems(table) {
  return table.items.filter(item => evaluateRuleSet(item, getActiveRuleSet()));
}

// Which assignee to show for a row, honoring the per-row selector.
function computeAssignedTo(item) {
  if (item.assigneeSource === 'qaTask') return item.qaTaskAssignedTo || item.parentAssignedTo || 'Unassigned';
  if (item.assigneeSource === 'parent') return item.parentAssignedTo || 'Unassigned';
  return item.qaTaskAssignedTo || item.parentAssignedTo || 'Unassigned';
}

// ── View management ────────────────────────────────────────────

function showView(viewName) {
  Object.values(DOM.views).forEach(v => (v.style.display = 'none'));
  DOM.views[viewName].style.display = '';
  state.view = viewName;
}

function updateHeaderLabel() {
  const t = getActiveTable();
  DOM.header.tableLabel.textContent = t ? `📋 ${t.name}` : 'No active table';
}

// ── Render main view ───────────────────────────────────────────

function renderMain() {
  const table = getActiveTable();
  if (!table) { showView('newTable'); return; }

  showView('main');
  updateHeaderLabel();

  // Board strip
  if (table.boardName) {
    DOM.main.sprintName.textContent    = table.boardName;
    DOM.main.pagesScraped.textContent  = table.pagesScraped;
    DOM.main.sprintStrip.style.display = '';
  } else {
    DOM.main.sprintStrip.style.display = 'none';
  }

  // Undo button
  DOM.main.btnUndo.style.display = table.pagesScraped > 0 ? '' : 'none';

  if (table.items.length === 0) {
    DOM.main.tableWrapper.style.display = 'none';
    DOM.main.chipsRow.style.display     = 'none';
    setStatus('idle', 'Navigate to a Kanban board and click Scrape.');
    return;
  }

  const visibleItems = getVisibleItems(table);

  if (visibleItems.length === 0) {
    DOM.main.tableWrapper.style.display = 'none';
    DOM.main.chipsRow.style.display     = 'none';
    setStatus('idle', `${table.items.length} item${table.items.length !== 1 ? 's' : ''} scraped — none match the active filter.`);
    return;
  }

  // Chips
  renderChips(visibleItems);

  // Table
  renderTable(visibleItems);
  DOM.main.tableWrapper.style.display = '';
  DOM.main.tableCount.textContent = visibleItems.length === table.items.length
    ? `${visibleItems.length} item${visibleItems.length !== 1 ? 's' : ''}`
    : `${visibleItems.length} of ${table.items.length} items (filtered)`;

  if (!state.scraping) setStatus('idle', `${visibleItems.length} items shown — scrape more pages or copy the table.`);
}

function renderChips(items) {
  const counts = {};
  items.forEach(i => { counts[i.column] = (counts[i.column] || 0) + 1; });
  DOM.main.chipsRow.innerHTML = '';
  Object.keys(counts).sort().forEach(col => {
    const st = styleForColumn(col);
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.background = st.bg;
    chip.style.color       = st.color;
    chip.textContent = `${statusLabelFor(col)}: ${counts[col]}`;
    DOM.main.chipsRow.appendChild(chip);
  });
  DOM.main.chipsRow.style.display = '';
}

function removeItem(rowKey) {
  const table = getActiveTable();
  if (!table) return;
  table.items = table.items.filter(i => i.rowKey !== rowKey);
  saveState();
  renderMain();
}

function setAssigneeSource(rowKey, source) {
  const table = getActiveTable();
  if (!table) return;
  const item = table.items.find(i => i.rowKey === rowKey);
  if (!item) return;
  item.assigneeSource = source;
  saveState();
  renderMain();
}

function renderTable(items) {
  const sorted = sortItems(items);
  DOM.main.resultsBody.innerHTML = sorted.map(item => {
    const st       = styleForColumn(item.column);
    const safeKey  = escHtml(item.rowKey || '');
    const label    = statusLabelFor(item.column);
    const subtext  = label !== item.column ? `<div class="status-subtext">${escHtml(item.column)}</div>` : '';

    return `
      <tr>
        <td class="col-delete">
          <button class="btn-delete" data-key="${safeKey}" title="Remove this row">✕</button>
        </td>
        <td class="col-case">
          <a class="case-link" href="${escHtml(item.url)}" target="_blank">#${item.id}</a>
        </td>
        <td class="col-title">${escHtml(item.title)}</td>
        <td class="col-person">
          <div class="assignee-line${item.assigneeSource === 'qaTask' ? ' assignee-active' : ''}">
            <span class="assignee-tag">QA</span>${escHtml(item.qaTaskAssignedTo || '—')}
          </div>
          <div class="assignee-line${item.assigneeSource === 'parent' ? ' assignee-active' : ''}">
            <span class="assignee-tag">Parent</span>${escHtml(item.parentAssignedTo || '—')}
          </div>
          <select class="assignee-source-select" data-key="${safeKey}" title="Which assignee to use for this row">
            <option value="qaTask"${item.assigneeSource === 'qaTask' ? ' selected' : ''}${item.hasQaTask ? '' : ' disabled'}>Use QA Task</option>
            <option value="parent"${item.assigneeSource === 'parent' ? ' selected' : ''}>Use Parent</option>
          </select>
        </td>
        <td class="col-status">
          <span class="status-badge" style="background:${st.bg};color:${st.color}">
            ${escHtml(label)}
          </span>
          ${subtext}
        </td>
        <td class="col-notes">${escHtml(item.notes || '')}</td>
      </tr>`;
  }).join('');

  DOM.main.resultsBody.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', () => removeItem(btn.dataset.key));
  });
  DOM.main.resultsBody.querySelectorAll('.assignee-source-select').forEach(sel => {
    sel.addEventListener('change', () => setAssigneeSource(sel.dataset.key, sel.value));
  });
}

function sortItems(items) {
  const sorted = [...items];
  if (state.settings.sortOrder === 'column') {
    sorted.sort((a, b) => a.column.localeCompare(b.column) || a.id - b.id);
  } else {
    sorted.sort((a, b) => a.id - b.id);
  }
  return sorted;
}

// ── Status bar ─────────────────────────────────────────────────

function setStatus(type, text) {
  const map = {
    idle:    'status-idle',
    loading: 'status-loading',
    success: 'status-success',
    error:   'status-error',
  };
  const icons = { idle: '●', loading: '⟳', success: '✓', error: '✕' };
  DOM.main.statusBar.className = `status-bar ${map[type] || 'status-idle'}`;
  DOM.main.statusIcon.textContent = icons[type] || '●';
  DOM.main.statusIcon.className   = type === 'loading' ? 'spin' : '';
  DOM.main.statusText.textContent = text;
}

// ── Toast ──────────────────────────────────────────────────────

let toastTimer;
function showToast(msg) {
  DOM.toast.textContent = msg;
  DOM.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => DOM.toast.classList.remove('show'), 2400);
}

// ── Scrape ─────────────────────────────────────────────────────

async function doScrape() {
  if (state.scraping) return;
  state.scraping = true;

  const table = getActiveTable();
  if (!table) { showView('newTable'); state.scraping = false; return; }

  DOM.main.btnScrape.disabled = true;
  setStatus('loading', 'Scraping board data via Azure DevOps API…');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Verify it's an ADO page
    if (!tab.url || (!tab.url.includes('dev.azure.com') && !tab.url.includes('visualstudio.com'))) {
      throw new Error('Please navigate to an Azure DevOps Kanban Board first.');
    }

    const response = await new Promise((resolve, reject) => {
      // Always inject the content script first. The guard in content.js
      // (window.__qaScraperLoaded) ensures duplicate injection is safe —
      // a second injection simply skips re-registering the listener.
      chrome.scripting.executeScript(
        { target: { tabId: tab.id }, files: ['content.js'] },
        () => {
          if (chrome.runtime.lastError) {
            reject(new Error('Could not inject scraper: ' + chrome.runtime.lastError.message));
            return;
          }
          // Small delay to let the script settle before messaging
          setTimeout(() => {
            chrome.tabs.sendMessage(tab.id, { action: 'scrape' }, resp => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
              } else {
                resolve(resp);
              }
            });
          }, 150);
        }
      );
    });

    if (!response || !response.success) {
      throw new Error(response?.error || 'Unknown scraping error.');
    }

    const { items, boardName, scrapedAt, pageUrl } = response.data;

    // Update board name if not set
    if (boardName && !table.boardName) table.boardName = boardName;

    // Merge items, track snapshot for undo
    const snapshotBefore = table.items.map(i => ({ ...i }));
    const added = mergeItems(table.items, items);

    table.pagesScraped += 1;
    table.pageSnapshots.push({
      pageUrl,
      scrapedAt,
      snapshotBefore,
      itemsAdded: added.length,
    });

    saveState();
    renderMain();

    const msg = added.length > 0
      ? `✓ Added ${added.length} new item${added.length !== 1 ? 's' : ''} from this page.`
      : `✓ Page scraped — no new items found (${items.length} already captured).`;
    setStatus('success', msg);

  } catch (err) {
    setStatus('error', err.message);
  } finally {
    state.scraping = false;
    DOM.main.btnScrape.disabled = false;
  }
}

// ── Undo last page ─────────────────────────────────────────────

function undoLastPage() {
  const table = getActiveTable();
  if (!table || !table.pageSnapshots.length) return;

  const last = table.pageSnapshots.pop();
  table.items = last.snapshotBefore;
  table.pagesScraped = Math.max(0, table.pagesScraped - 1);
  if (table.pagesScraped === 0) table.boardName = '';

  saveState();
  renderMain();
  showToast(`↩ Removed last page (${last.itemsAdded} items undone)`);
}

// ── Copy helpers ───────────────────────────────────────────────

function buildHtmlTable(items) {
  const sorted = sortItems(items);
  const rows = sorted.map(item => {
    const st = styleForColumn(item.column);
    const caseCell = `<a href="${item.url}" style="color:#0078d4;font-weight:600;text-decoration:none">#${item.id}</a>`;
    const badge    = `<span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;background:${st.bg};color:${st.color}">${escHtml(statusLabelFor(item.column))}</span>`;
    return `    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #e0e0e0;white-space:nowrap">${caseCell}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e0e0e0">${escHtml(item.title)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e0e0e0;white-space:nowrap">${escHtml(computeAssignedTo(item))}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e0e0e0">${badge}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e0e0e0">${escHtml(item.notes || '')}</td>
    </tr>`;
  }).join('\n');

  const table = getActiveTable();
  const heading = table
    ? `<p style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;font-weight:600;margin-bottom:8px">${escHtml(table.name)}</p>`
    : '';

  return `${heading}<table style="border-collapse:collapse;font-family:Segoe UI,Arial,sans-serif;font-size:12px;width:100%">
  <thead>
    <tr style="background:#f0f0f0">
      <th style="padding:6px 8px;text-align:left;font-weight:600;border-bottom:2px solid #d0d0d0;white-space:nowrap">Case #</th>
      <th style="padding:6px 8px;text-align:left;font-weight:600;border-bottom:2px solid #d0d0d0">Title</th>
      <th style="padding:6px 8px;text-align:left;font-weight:600;border-bottom:2px solid #d0d0d0;white-space:nowrap">Assigned To</th>
      <th style="padding:6px 8px;text-align:left;font-weight:600;border-bottom:2px solid #d0d0d0">Status</th>
      <th style="padding:6px 8px;text-align:left;font-weight:600;border-bottom:2px solid #d0d0d0">Notes</th>
    </tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>`;
}

function buildPlainText(items) {
  const sorted = sortItems(items);
  const table = getActiveTable();
  const header = table ? `${table.name}\n${'─'.repeat(table.name.length)}\n` : '';
  const cols = ['Case #', 'Title', 'Assigned To', 'Status', 'Notes'];

  // Calculate column widths
  const widths = cols.map((c, i) => {
    const vals = sorted.map(item => {
      const row = [`#${item.id}`, item.title, computeAssignedTo(item), statusLabelFor(item.column), item.notes || ''];
      return row[i] || '';
    });
    return Math.max(c.length, ...vals.map(v => v.length));
  });

  const pad = (s, w) => String(s).padEnd(w);
  const divider = widths.map(w => '─'.repeat(w)).join('  ');
  const headerRow = cols.map((c, i) => pad(c, widths[i])).join('  ');

  const rows = sorted.map(item => {
    const row = [`#${item.id}`, item.title, computeAssignedTo(item), statusLabelFor(item.column), item.notes || ''];
    return row.map((v, i) => pad(v, widths[i])).join('  ');
  });

  return `${header}${headerRow}\n${divider}\n${rows.join('\n')}`;
}

async function copyHtml() {
  const table = getActiveTable();
  if (!table || !table.items.length) return;

  const visibleItems = getVisibleItems(table);
  const html = buildHtmlTable(visibleItems);
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html':  new Blob([html],            { type: 'text/html' }),
        'text/plain': new Blob([buildPlainText(visibleItems)], { type: 'text/plain' }),
      }),
    ]);
    showToast('📋 Copied as rich-text table — paste into your email!');
  } catch {
    // Fallback: copy plain text
    await navigator.clipboard.writeText(html);
    showToast('📋 Copied HTML — paste into email as HTML source.');
  }
}

async function copyPlainText() {
  const table = getActiveTable();
  if (!table || !table.items.length) return;
  await navigator.clipboard.writeText(buildPlainText(getVisibleItems(table)));
  showToast('📄 Copied plain text table.');
}

// ── Utility ────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Add Row feature ────────────────────────────────────────────

let lookupResult = null; // cache of last fetched case

function showAddRow() {
  showView('addRow');
  updateHeaderLabel();
  // Reset to lookup tab
  switchAddRowTab('lookup');
  // Clear previous lookup
  lookupResult = null;
  $('lookup-input').value = '';
  $('lookup-result').style.display = 'none';
  $('lookup-status').style.display = 'none';
  $('lookup-task-list').innerHTML = '';
  setTimeout(() => $('lookup-input').focus(), 50);
}

function switchAddRowTab(tab) {
  $('pane-lookup').style.display  = tab === 'lookup' ? '' : 'none';
  $('pane-manual').style.display  = tab === 'manual' ? '' : 'none';
  $('tab-lookup').className = 'tab-btn' + (tab === 'lookup' ? ' tab-active' : '');
  $('tab-manual').className = 'tab-btn' + (tab === 'manual' ? ' tab-active' : '');
}

function setLookupStatus(type, text) {
  const el = $('lookup-status');
  el.style.display = '';
  const map  = { idle: 'status-idle', loading: 'status-loading', success: 'status-success', error: 'status-error' };
  const icons = { idle: '●', loading: '⟳', success: '✓', error: '✕' };
  el.className = `status-bar ${map[type] || 'status-idle'}`;
  $('lookup-status-icon').textContent = icons[type] || '●';
  $('lookup-status-icon').className   = type === 'loading' ? 'spin' : '';
  $('lookup-status-text').textContent = text;
}

// Extract a plain case ID from either a raw number or a full ADO URL
function parseCaseInput(raw) {
  raw = raw.trim();
  // Plain number
  if (/^\d+$/.test(raw)) return raw;
  // URL ending in /edit/12345 or /_workitems/edit/12345
  const m = raw.match(/\/(\d+)\s*$/);
  if (m) return m[1];
  // ?workItemId=12345
  const q = raw.match(/[?&]workItemId=(\d+)/i);
  if (q) return q[1];
  return null;
}

async function doLookup() {
  const raw    = $('lookup-input').value;
  const caseId = parseCaseInput(raw);
  if (!caseId) {
    setLookupStatus('error', 'Enter a case number or ADO URL.');
    return;
  }

  setLookupStatus('loading', `Looking up #${caseId}…`);
  $('lookup-result').style.display = 'none';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.url || (!tab.url.includes('dev.azure.com') && !tab.url.includes('visualstudio.com'))) {
      throw new Error('Navigate to an Azure DevOps page first so the scraper can use your session.');
    }

    const response = await new Promise((resolve, reject) => {
      chrome.scripting.executeScript(
        { target: { tabId: tab.id }, files: ['content.js'] },
        () => {
          if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
          setTimeout(() => {
            chrome.tabs.sendMessage(tab.id, { action: 'fetchCase', caseId }, resp => {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(resp);
            });
          }, 150);
        }
      );
    });

    if (!response?.success) throw new Error(response?.error || 'Unknown error.');

    lookupResult = response.data;
    renderLookupResult(lookupResult);
    setLookupStatus('success', `Found: #${lookupResult.id} — ${lookupResult.state}`);

  } catch (err) {
    setLookupStatus('error', err.message);
  }
}

function renderLookupResult(data) {
  const link = $('lookup-case-link');
  link.textContent = `#${data.id}`;
  link.href = data.url;
  $('lookup-case-title').textContent = `${data.title} — ${data.column} · ${data.parentAssignedTo}`;

  const list = $('lookup-task-list');
  list.innerHTML = '';

  if (!data.tasks.length) {
    $('lookup-no-tasks').style.display = '';
    $('lookup-result').style.display   = '';
    return;
  }
  $('lookup-no-tasks').style.display = 'none';

  data.tasks.forEach(task => {
    const item = document.createElement('div');
    item.className = 'task-item';
    item.dataset.taskId = task.id;

    item.innerHTML = `
      <input type="checkbox" class="task-checkbox" id="task-cb-${task.id}" />
      <div class="task-item-body">
        <label class="task-item-title" for="task-cb-${task.id}">${escHtml(task.title)}</label>
        <div class="task-item-meta">${escHtml(task.state)} · ${escHtml(task.assignedTo)}</div>
        <div class="task-item-controls">
          <input class="task-notes-input" type="text"
            placeholder="Notes (optional)"
            value="${escHtml(data.buildNote || '')}" />
        </div>
      </div>`;

    // Toggle selection highlight when checkbox changes
    item.querySelector('.task-checkbox').addEventListener('change', e => {
      item.classList.toggle('task-selected', e.target.checked);
    });
    // Clicking the row (not the controls) toggles the checkbox
    item.addEventListener('click', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'LABEL') return;
      const cb = item.querySelector('.task-checkbox');
      cb.checked = !cb.checked;
      item.classList.toggle('task-selected', cb.checked);
    });

    list.appendChild(item);
  });

  $('lookup-result').style.display = '';
}

function addSelectedRows() {
  if (!lookupResult) return;
  const table = getActiveTable();
  if (!table) return;

  const items = $('lookup-task-list').querySelectorAll('.task-item');
  let added = 0;

  items.forEach(item => {
    const cb = item.querySelector('.task-checkbox');
    if (!cb.checked) return;

    const taskId = item.dataset.taskId;
    const task   = lookupResult.tasks.find(t => String(t.id) === String(taskId));
    const notes  = item.querySelector('.task-notes-input').value.trim();
    const rowKey = `${lookupResult.id}|${lookupResult.column}|${taskId}`;

    // Skip if exact duplicate already in table
    if (table.items.some(i => i.rowKey === rowKey)) return;

    table.items.push({
      id:               lookupResult.id,
      title:            lookupResult.title,
      url:              lookupResult.url,
      workItemType:     '',
      state:            lookupResult.state,
      column:           lookupResult.column,
      parentAssignedTo: lookupResult.parentAssignedTo,
      qaTaskAssignedTo: task ? task.assignedTo : null,
      qaTaskTitle:      task?.title || '',
      qaTaskState:      task?.state || '',
      hasQaTask:        true,
      notes,
      assigneeSource:   'qaTask',
      rowKey,
    });
    added++;
  });

  if (added === 0) {
    showToast('No new rows to add — check checkboxes or deselect duplicates.');
    return;
  }
  saveState();
  showToast(`＋ Added ${added} row${added !== 1 ? 's' : ''}.`);
  renderMain();
}

function addManualRow() {
  const table = getActiveTable();
  if (!table) return;

  const caseId   = $('manual-case').value.trim();
  const title    = $('manual-title').value.trim();
  const assigned = $('manual-assigned').value.trim() || 'Unassigned';
  const column   = $('manual-column').value.trim() || '(No Column)';
  const notes    = $('manual-notes').value.trim();

  if (!caseId || !title) {
    showToast('Case # and Title are required.');
    return;
  }
  if (!/^\d+$/.test(caseId)) {
    showToast('Case # must be a number.');
    return;
  }

  const rowKey = `${caseId}|${column}|none`;
  if (table.items.some(i => i.rowKey === rowKey)) {
    showToast('This row already exists in the table.');
    return;
  }

  table.items.push({
    id:               parseInt(caseId, 10),
    title,
    url:              '', // no URL for manual rows
    workItemType:     '',
    state:            '',
    column,
    parentAssignedTo: assigned,
    qaTaskAssignedTo: null,
    qaTaskTitle:      '',
    qaTaskState:      '',
    hasQaTask:        false,
    notes,
    assigneeSource:   'parent',
    rowKey,
  });

  saveState();
  // Clear fields for next entry
  $('manual-case').value = $('manual-title').value = $('manual-assigned').value = $('manual-column').value = $('manual-notes').value = '';
  showToast('＋ Row added.');
  renderMain();
}

// ── Rule builder ───────────────────────────────────────────────

function findRule(id) {
  return getActiveRuleSet().rules.find(r => r.id === id);
}

function ruleRowHtml(rule, idx) {
  const fieldDef     = ruleFieldDef(rule.field);
  const operators    = OPERATORS_BY_TYPE[fieldDef.type];
  const isListOp     = LIST_OPERATORS.has(rule.operator);
  const isEmptyOp    = rule.operator === 'is empty' || rule.operator === 'is not empty';
  const valueDisplay = isListOp && Array.isArray(rule.value) ? rule.value.join(', ') : (rule.value ?? '');

  const valueField = fieldDef.type === 'boolean'
    ? `<select class="rule-value" data-id="${rule.id}">
         <option value="true"${String(rule.value) === 'true' ? ' selected' : ''}>True</option>
         <option value="false"${String(rule.value) === 'false' ? ' selected' : ''}>False</option>
       </select>`
    : `<input class="rule-value" data-id="${rule.id}" type="text" value="${escHtml(String(valueDisplay))}"
         placeholder="${isListOp ? 'comma, separated, values' : 'value'}" ${isEmptyOp ? 'disabled' : ''} />`;

  return `
    <div class="rule-row" data-id="${rule.id}">
      <select class="rule-joiner" data-id="${rule.id}" ${idx === 0 ? 'disabled' : ''}>
        <option value="And"${rule.joiner === 'And' ? ' selected' : ''}>And</option>
        <option value="Or"${rule.joiner === 'Or' ? ' selected' : ''}>Or</option>
      </select>
      <select class="rule-field" data-id="${rule.id}">
        ${RULE_FIELDS.map(f => `<option value="${f.key}"${f.key === rule.field ? ' selected' : ''}>${escHtml(f.label)}</option>`).join('')}
      </select>
      <select class="rule-operator" data-id="${rule.id}">
        ${operators.map(op => `<option value="${op}"${op === rule.operator ? ' selected' : ''}>${escHtml(op)}</option>`).join('')}
      </select>
      ${valueField}
      <button class="btn-delete-rule" data-id="${rule.id}" title="Remove rule">✕</button>
    </div>`;
}

function renderRuleSetSelect() {
  DOM.rules.setSelect.innerHTML = state.ruleSets
    .map(s => `<option value="${escHtml(s.id)}"${s.id === state.activeRuleSetId ? ' selected' : ''}>${escHtml(s.name)}</option>`)
    .join('');
  DOM.rules.btnDeleteSet.disabled = state.ruleSets.length <= 1;
}

function renderRuleBuilder() {
  renderRuleSetSelect();
  const rules = getActiveRuleSet().rules;
  DOM.rules.rows.innerHTML = rules.map((rule, idx) => ruleRowHtml(rule, idx)).join('');
  DOM.rules.emptyHint.style.display = rules.length ? 'none' : '';
  wireRuleRowEvents();
}

function wireRuleRowEvents() {
  DOM.rules.rows.querySelectorAll('.rule-joiner').forEach(el => {
    el.addEventListener('change', () => { findRule(el.dataset.id).joiner = el.value; });
  });

  DOM.rules.rows.querySelectorAll('.rule-field').forEach(el => {
    el.addEventListener('change', () => {
      const rule = findRule(el.dataset.id);
      rule.field = el.value;
      const def  = ruleFieldDef(rule.field);
      rule.operator = OPERATORS_BY_TYPE[def.type][0];
      rule.value    = def.type === 'boolean' ? 'true' : '';
      renderRuleBuilder();
    });
  });

  DOM.rules.rows.querySelectorAll('.rule-operator').forEach(el => {
    el.addEventListener('change', () => {
      const rule = findRule(el.dataset.id);
      rule.operator = el.value;
      renderRuleBuilder();
    });
  });

  DOM.rules.rows.querySelectorAll('.rule-value').forEach(el => {
    const evt = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(evt, () => { findRule(el.dataset.id).value = el.value; });
  });

  DOM.rules.rows.querySelectorAll('.btn-delete-rule').forEach(el => {
    el.addEventListener('click', () => {
      const activeSet = getActiveRuleSet();
      activeSet.rules = activeSet.rules.filter(r => r.id !== el.dataset.id);
      renderRuleBuilder();
    });
  });
}

function openRuleBuilder() {
  ruleBuilderSnapshot = JSON.parse(JSON.stringify({ ruleSets: state.ruleSets, activeRuleSetId: state.activeRuleSetId }));
  renderRuleBuilder();
  showView('rules');
}

function closeRuleBuilder() {
  if (getActiveTable()) renderMain();
  else showView('newTable');
}

function newRuleSet() {
  const name = prompt('Name this filter set:', '');
  if (!name || !name.trim()) return;
  const newSet = {
    id:    `set-${Date.now()}`,
    name:  name.trim(),
    rules: [makeEmptyRule('And')],
  };
  state.ruleSets.push(newSet);
  state.activeRuleSetId = newSet.id;
  renderRuleBuilder();
}

function renameRuleSet() {
  const activeSet = getActiveRuleSet();
  const name = prompt('Rename filter set:', activeSet.name);
  if (!name || !name.trim()) return;
  activeSet.name = name.trim();
  renderRuleSetSelect();
}

function deleteRuleSet() {
  if (state.ruleSets.length <= 1) {
    showToast('At least one filter set is required.');
    return;
  }
  const activeSet = getActiveRuleSet();
  if (!confirm(`Delete the "${activeSet.name}" filter set? This cannot be undone.`)) return;
  state.ruleSets = state.ruleSets.filter(s => s.id !== activeSet.id);
  state.activeRuleSetId = state.ruleSets[0].id;
  renderRuleBuilder();
}

// ── Event wiring ────────────────────────────────────────────────

function wireEvents() {
  // New table form
  DOM.newTable.btnCreate.addEventListener('click', () => {
    const name = DOM.newTable.nameInput.value.trim();
    if (!name) {
      DOM.newTable.nameInput.focus();
      DOM.newTable.nameInput.style.borderColor = '#a4262c';
      return;
    }
    DOM.newTable.nameInput.style.borderColor = '';
    createTable(name);
    DOM.newTable.nameInput.value = '';
    renderMain();
  });

  DOM.newTable.nameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') DOM.newTable.btnCreate.click();
  });

  DOM.newTable.btnCancel.addEventListener('click', () => {
    if (getActiveTable()) renderMain();
  });

  // Scrape
  DOM.main.btnScrape.addEventListener('click', doScrape);

  // Undo
  DOM.main.btnUndo.addEventListener('click', undoLastPage);

  // Copy
  DOM.main.btnCopyHtml.addEventListener('click', copyHtml);
  DOM.main.btnCopyText.addEventListener('click', copyPlainText);

  // Add Row button
  DOM.main.btnAddRow = $('btn-add-row');
  DOM.main.btnAddRow.addEventListener('click', showAddRow);

  // Add Row view — tab switching
  $('tab-lookup').addEventListener('click', () => switchAddRowTab('lookup'));
  $('tab-manual').addEventListener('click', () => switchAddRowTab('manual'));

  // ADO Lookup
  $('btn-lookup').addEventListener('click', doLookup);
  $('lookup-input').addEventListener('keydown', e => { if (e.key === 'Enter') doLookup(); });
  $('btn-add-selected').addEventListener('click', addSelectedRows);

  // Manual entry
  $('btn-add-manual').addEventListener('click', addManualRow);
  $('manual-notes').addEventListener('keydown', e => { if (e.key === 'Enter') addManualRow(); });

  // Back button
  $('btn-add-row-back').addEventListener('click', () => {
    if (getActiveTable()) renderMain();
    else showView('newTable');
  });

  // New table
  DOM.main.btnNewTable.addEventListener('click', () => {
    // Show new table form with cancel button visible
    DOM.newTable.btnCancel.style.display = '';
    DOM.newTable.nameInput.value = '';
    showView('newTable');
    updateHeaderLabel();
    setTimeout(() => DOM.newTable.nameInput.focus(), 50);
  });

  // Clear table
  DOM.main.btnClearTable.addEventListener('click', () => {
    const table = getActiveTable();
    if (!table) return;
    if (!confirm(`Clear all ${table.items.length} items from "${table.name}"? This cannot be undone.`)) return;
    table.items        = [];
    table.pagesScraped = 0;
    table.boardName    = '';
    table.pageSnapshots= [];
    saveState();
    renderMain();
    showToast('🗑 Table cleared.');
  });

  // Settings
  DOM.header.btnSettings.addEventListener('click', () => {
    DOM.settings.sortOrderSelect.value  = state.settings.sortOrder;
    showView('settings');
  });

  // Rule builder
  DOM.header.btnRules.addEventListener('click', openRuleBuilder);
  DOM.rules.setSelect.addEventListener('change', () => {
    state.activeRuleSetId = DOM.rules.setSelect.value;
    renderRuleBuilder();
  });
  DOM.rules.btnNewSet.addEventListener('click', newRuleSet);
  DOM.rules.btnRenameSet.addEventListener('click', renameRuleSet);
  DOM.rules.btnDeleteSet.addEventListener('click', deleteRuleSet);
  DOM.rules.btnAdd.addEventListener('click', () => {
    getActiveRuleSet().rules.push(makeEmptyRule('And'));
    renderRuleBuilder();
  });
  DOM.rules.btnApply.addEventListener('click', () => {
    saveRuleSets();
    showToast('✓ Filter applied.');
    closeRuleBuilder();
  });
  DOM.rules.btnCancel.addEventListener('click', () => {
    state.ruleSets        = ruleBuilderSnapshot.ruleSets;
    state.activeRuleSetId = ruleBuilderSnapshot.activeRuleSetId;
    closeRuleBuilder();
  });

  DOM.settings.btnSave.addEventListener('click', () => {
    state.settings.sortOrder  = DOM.settings.sortOrderSelect.value;
    saveState();
    showToast('✓ Settings saved.');
    if (getActiveTable()) renderMain();
    else showView('newTable');
  });

  DOM.settings.btnClose.addEventListener('click', () => {
    if (getActiveTable()) renderMain();
    else showView('newTable');
  });
}

// ── Init ────────────────────────────────────────────────────────

(async () => {
  await Promise.all([loadState(), loadRuleSets()]);
  wireEvents();

  if (getActiveTable()) {
    renderMain();
  } else {
    showView('newTable');
    DOM.newTable.btnCancel.style.display = 'none';
    updateHeaderLabel();
    setTimeout(() => DOM.newTable.nameInput.focus(), 80);
  }
})();
