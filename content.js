// ============================================================
// QA Update Scraper — content.js  v11
//
// Scrapes an Azure DevOps Kanban Board (not a Sprint) via the
// REST/WIQL API. Cards are identified by System.BoardColumn, which
// Azure DevOps stamps on every work item shown on a team's board.
//
// Debug: open DevTools on the ADO tab → Console, filter "[QA Scraper]"
// ============================================================
if (!window.__qaScraperLoaded) {
  window.__qaScraperLoaded = true;

const LOG  = (...args) => console.log('[QA Scraper]',  ...args);
const WARN = (...args) => console.warn('[QA Scraper]', ...args);

const DEFAULT_PARENT_TYPES = ['Product Backlog Item', 'Bug', 'User Story', 'Feature'];
const DEFAULT_CHILD_TYPES  = ['Task'];

// ── Task-name classifiers ────────────────────────────────────

function isQATask(title) {
  // Must START with "QA" — prevents false matches like "PR for QA findings",
  // "Dev Test for QA Findings", etc.
  return /^\s*qa\b/i.test(title);
}
function isFeatureBranchQATask(title) {
  return /feature\s*branch/i.test(title);
}
function isDevelopQATask(title) {
  return /\bdevelop\b/i.test(title);
}

// ── URL parser ───────────────────────────────────────────────

// Given path segments AFTER the project (e.g. ['_boards','board','t','MyTeam','Stories']),
// find the team name. Handles both '/_boards/board/t/{team}/...' and
// '/_boards/board/{team}/...' variants.
function extractTeamFromBoardPath(parts) {
  const boardsIdx = parts.findIndex(p => p === '_boards');
  if (boardsIdx === -1) return null;
  const tail = parts.slice(boardsIdx + 1);
  if (tail[0] !== 'board') return null;
  if (tail[1] === 't' && tail[2]) return decodeURIComponent(tail[2]);
  if (tail[1]) return decodeURIComponent(tail[1]);
  return null;
}

function parseAzureDevOpsUrl(url) {
  try {
    const u = new URL(url);
    let org, project, team, baseApiUrl, pathParts;

    if (u.hostname === 'dev.azure.com') {
      pathParts = u.pathname.split('/').filter(Boolean);
      if (pathParts.length < 2) return null;
      org        = pathParts[0];
      project    = decodeURIComponent(pathParts[1]);
      baseApiUrl = `https://dev.azure.com/${org}`;
      team       = extractTeamFromBoardPath(pathParts.slice(2));
    } else if (u.hostname.endsWith('.visualstudio.com')) {
      org        = u.hostname.replace('.visualstudio.com', '');
      pathParts  = u.pathname.split('/').filter(Boolean);
      if (pathParts.length < 1) return null;
      project    = decodeURIComponent(pathParts[0]);
      baseApiUrl = `https://${u.hostname}`;
      team       = extractTeamFromBoardPath(pathParts.slice(1));
    } else {
      return null;
    }

    if (!team) return null;

    LOG('Parsed URL →', { org, project, team, baseApiUrl });
    return { org, project, team, baseApiUrl };
  } catch (e) {
    WARN('URL parse error:', e);
    return null;
  }
}

// ── ADO REST helpers ─────────────────────────────────────────

async function adoGet(url) {
  LOG('GET', url);
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`ADO API ${resp.status} → ${url}\n${text.slice(0, 300)}`);
  }
  return resp.json();
}

async function adoPost(url, body) {
  LOG('POST', url);
  const resp = await fetch(url, {
    method:      'POST',
    credentials: 'include',
    headers:     { 'Content-Type': 'application/json' },
    body:        JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`ADO API ${resp.status} → ${url}\n${text.slice(0, 300)}`);
  }
  return resp.json();
}

async function fetchWorkItemsBatch(baseApiUrl, ids) {
  if (!ids.length) return {};
  const BATCH  = 200;
  const wiMap  = {};
  const fields = [
    'System.Id',
    'System.Title',
    'System.State',
    'System.WorkItemType',
    'System.AssignedTo',
  ].join(',');

  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH).join(',');
    const url   = `${baseApiUrl}/_apis/wit/workitems?ids=${slice}&fields=${fields}&api-version=7.0`;
    try {
      const data = await adoGet(url);
      (data.value || []).forEach(wi => { wiMap[wi.id] = wi; });
      LOG(`  batch [${i}–${i + BATCH}]: ${(data.value || []).length} items loaded`);
    } catch (e) {
      WARN('Batch fetch error:', e.message);
    }
  }
  return wiMap;
}

// Fetch parent work items with $expand=all so we get BOTH all fields
// (including System.BoardColumn) AND relations (for linked builds).
// NOTE: Cannot combine fields= and $expand= in one call — $expand is silently
// dropped when fields= is present.
async function fetchParentsWithRelations(baseApiUrl, ids) {
  if (!ids.length) return {};
  const BATCH     = 100; // smaller batch — responses are larger with relations
  const parentMap = {};

  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH).join(',');
    const url   = `${baseApiUrl}/_apis/wit/workitems?ids=${slice}&$expand=all&api-version=7.0`;
    try {
      const data = await adoGet(url);
      (data.value || []).forEach(wi => { parentMap[wi.id] = wi; });
      LOG(`  parent+relations batch [${i}–${i + BATCH}]: ${(data.value || []).length} items`);
    } catch (e) {
      WARN('Parent relations fetch error:', e.message);
    }
  }
  return parentMap;
}

// Extract the ADO build ID from an ArtifactLink URL.
// URL format: "vstfs:///Build/Build/{buildId}"
function buildIdFromArtifactUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/\/Build\/Build\/(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

// Collect all build IDs linked to a set of parent work items,
// fetch them from the Builds API in batches, and return a
// map of buildId → buildNumber string.
async function fetchBuildNumbers(baseApiUrl, projectEnc, parentWiMap) {
  const buildIds = new Set();

  Object.values(parentWiMap).forEach(wi => {
    (wi.relations || []).forEach(r => {
      if (r.rel === 'ArtifactLink') {
        const id = buildIdFromArtifactUrl(r.url);
        if (id) buildIds.add(id);
      }
    });
  });

  if (!buildIds.size) return {};

  // Batched like fetchWorkItemsBatch/fetchParentsWithRelations — a board
  // scrape can accumulate hundreds of linked builds across many cards
  // (unlike the old sprint-scoped scrape), and a single unbatched request
  // produces a URL long enough for ADO's edge to reject with a 404.
  const BATCH = 200;
  const idArray = [...buildIds];
  const map = {};

  for (let i = 0; i < idArray.length; i += BATCH) {
    const slice = idArray.slice(i, i + BATCH).join(',');
    const url = `${baseApiUrl}/${projectEnc}/_apis/build/builds?buildIds=${slice}&api-version=7.0`;
    try {
      const data = await adoGet(url);
      (data.value || []).forEach(b => { map[b.id] = b.buildNumber; });
      LOG(`  build number batch [${i}–${i + BATCH}]: ${(data.value || []).length} builds`);
    } catch (e) {
      WARN('Build number fetch failed:', e.message);
    }
  }

  return map;
}

// Return the linked build number string for a work item, or null.
// Priority: (1) ArtifactLink build number (resolved via Builds API)
//           (2) Microsoft.VSTS.Build.IntegrationBuild text field
function getIntegratedBuild(wi, buildNumberMap) {
  const relations = wi.relations || [];
  const buildLinks = relations.filter(r =>
    r.rel === 'ArtifactLink' &&
    typeof r.url === 'string' &&
    r.url.toLowerCase().includes('/build/build/')
  );
  if (buildLinks.length) {
    const latest = buildLinks[buildLinks.length - 1];
    const id     = buildIdFromArtifactUrl(latest.url);
    const number = id ? buildNumberMap[id] : null;
    if (number) return `Integrated in build: ${number}`;
  }

  const fieldVal = wi.fields?.['Microsoft.VSTS.Build.IntegrationBuild'];
  return fieldVal ? `Integrated in build: ${fieldVal}` : null;
}

// ── Team/board configuration ─────────────────────────────────

async function fetchTeamAreaPaths(baseApiUrl, projectEnc, teamEnc) {
  try {
    const d = await adoGet(
      `${baseApiUrl}/${projectEnc}/${teamEnc}/_apis/work/teamsettings/teamfieldvalues?api-version=7.0`
    );
    const values = (d.values || []).map(v => ({ value: v.value, includeChildren: !!v.includeChildren }));
    if (!values.length && d.defaultValue) values.push({ value: d.defaultValue, includeChildren: true });
    return values;
  } catch (e) {
    WARN('Team area path fetch failed:', e.message);
    return [];
  }
}

async function fetchBacklogWorkItemTypes(baseApiUrl, projectEnc, teamEnc) {
  try {
    const d = await adoGet(
      `${baseApiUrl}/${projectEnc}/${teamEnc}/_apis/work/backlogconfiguration?api-version=7.0`
    );
    const parentTypes = (d.requirementBacklog?.workItemTypes || []).map(t => t.name);
    const childTypes  = (d.taskBacklog?.workItemTypes || []).map(t => t.name);
    return {
      parentTypes: parentTypes.length ? parentTypes : DEFAULT_PARENT_TYPES,
      childTypes:  childTypes.length  ? childTypes  : DEFAULT_CHILD_TYPES,
    };
  } catch (e) {
    WARN('Backlog configuration fetch failed:', e.message);
    return { parentTypes: DEFAULT_PARENT_TYPES, childTypes: DEFAULT_CHILD_TYPES };
  }
}

function buildAreaClause(areaValues) {
  if (!areaValues || !areaValues.length) return '';
  const clauses = areaValues.map(v => {
    const esc = v.value.replace(/'/g, "''");
    return v.includeChildren ? `[System.AreaPath] UNDER '${esc}'` : `[System.AreaPath] = '${esc}'`;
  });
  return `(${clauses.join(' OR ')})`;
}

// ── Main scraper ─────────────────────────────────────────────

const getDisplayName = field => {
  if (!field) return 'Unassigned';
  if (typeof field === 'string') return field;
  return field.displayName || field.uniqueName || 'Unassigned';
};

async function scrapeAzureDevOpsBoardData() {
  const parsed = parseAzureDevOpsUrl(window.location.href);
  if (!parsed) {
    throw new Error(
      'Not an Azure DevOps Kanban Board page. ' +
      'Navigate to a Board (…/_boards/board/t/{team}/…), then click Scrape.'
    );
  }

  const { baseApiUrl } = parsed;
  const project    = parsed.project;
  const projectEnc = encodeURIComponent(project);
  const teamEnc    = encodeURIComponent(parsed.team);

  // ── 1. Resolve team's board scope (area paths + backlog work item types)
  LOG('═══ Step 1: Resolving team board configuration…');
  const [areaValues, backlogTypes] = await Promise.all([
    fetchTeamAreaPaths(baseApiUrl, projectEnc, teamEnc),
    fetchBacklogWorkItemTypes(baseApiUrl, projectEnc, teamEnc),
  ]);
  const areaClause = buildAreaClause(areaValues);
  LOG('  Area clause:', areaClause || '(none — whole project)');
  LOG('  Parent types:', backlogTypes.parentTypes);

  // ── 2. WIQL: cards currently on the board ───────────────────
  LOG('═══ Step 2: WIQL — querying board cards…');
  const wiqlProject = project.replace(/'/g, "''");
  const typesList    = backlogTypes.parentTypes.map(t => `'${t.replace(/'/g, "''")}'`).join(',');

  const wiqlParents = await adoPost(
    `${baseApiUrl}/${projectEnc}/_apis/wit/wiql?api-version=7.0`,
    {
      query: `
        SELECT [System.Id]
        FROM WorkItems
        WHERE [System.TeamProject] = '${wiqlProject}'
          AND [System.WorkItemType] IN (${typesList})
          AND [System.BoardColumn] <> ''
          ${areaClause ? `AND ${areaClause}` : ''}
        ORDER BY [System.Id]
      `,
    }
  );

  const parentIds = (wiqlParents.workItems || []).map(w => w.id);
  LOG(`  Found ${parentIds.length} board cards:`, parentIds);

  if (!parentIds.length) {
    return { items: [], boardName: `${parsed.team} Board`, scrapedAt: new Date().toLocaleString(), pageUrl: window.location.href };
  }

  // ── 3. WIQL: child Tasks for those cards ─────────────────────
  LOG('═══ Step 3: WIQL — querying child Tasks…');
  const wiqlChildren = await adoPost(
    `${baseApiUrl}/${projectEnc}/_apis/wit/wiql?api-version=7.0`,
    {
      query: `
        SELECT [System.Id]
        FROM WorkItemLinks
        WHERE [Source].[System.TeamProject] = '${wiqlProject}'
          AND [Source].[System.Id] IN (${parentIds.join(',')})
          AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward'
          AND [Target].[System.WorkItemType] = 'Task'
        ORDER BY [System.Id]
        MODE (MustContain)
      `,
    }
  );

  const parentToChildren = {};
  const childIdSet       = new Set();

  (wiqlChildren.workItemRelations || []).forEach(rel => {
    if (!rel.source || !rel.target) return;
    const pid = rel.source.id;
    const cid = rel.target.id;
    if (!parentToChildren[pid]) parentToChildren[pid] = [];
    parentToChildren[pid].push(cid);
    childIdSet.add(cid);
  });

  LOG(`  ${childIdSet.size} child tasks across ${Object.keys(parentToChildren).length} cards`);

  // ── 4. Fetch all work item details ──────────────────────────
  LOG('═══ Step 4: Fetching work item details…');
  const parentMap = await fetchParentsWithRelations(baseApiUrl, parentIds);
  const childMap  = await fetchWorkItemsBatch(baseApiUrl, [...childIdSet]);
  const wiMap     = { ...childMap, ...parentMap };

  LOG('═══ Step 4b: Fetching linked build numbers…');
  const buildNumberMap = await fetchBuildNumbers(baseApiUrl, projectEnc, parentMap);

  // ── 5. Build rows (one per QA task, or one per card if none) ─
  LOG('═══ Step 5: Building rows…');
  const results  = [];
  const seenKeys = new Set();
  const columnsSeen = new Set();

  parentIds.forEach(pid => {
    const wi = wiMap[pid];
    if (!wi) { WARN(`Skipping ${pid} — missing from wiMap`); return; }

    const column = wi.fields['System.BoardColumn'] || '(No Column)';
    columnsSeen.add(column);

    const childTaskObjs = (parentToChildren[pid] || [])
      .map(cid => wiMap[cid])
      .filter(Boolean);

    const qaTasks   = childTaskObjs.filter(t => isQATask(t.fields['System.Title'] || ''));
    const buildNote = getIntegratedBuild(wi, buildNumberMap);
    const parentAssignedTo = getDisplayName(wi.fields['System.AssignedTo']);

    const makeRow = task => {
      const qaTaskAssignedTo = task ? getDisplayName(task.fields['System.AssignedTo']) : null;
      const hasQaTask = !!task;
      const rowKey = `${wi.id}|${column}|${task ? task.id : 'none'}`;
      if (seenKeys.has(rowKey)) return;
      seenKeys.add(rowKey);

      const noteParts = [];
      if (buildNote) noteParts.push(buildNote);
      if (task) {
        const title = task.fields['System.Title'] || '';
        if (isFeatureBranchQATask(title)) noteParts.push('(Feature Branch)');
        else if (isDevelopQATask(title))  noteParts.push('(Develop)');
      }

      results.push({
        id:               wi.id,
        title:            wi.fields['System.Title'] || '(no title)',
        url:              `${baseApiUrl}/${projectEnc}/_workitems/edit/${wi.id}`,
        workItemType:     wi.fields['System.WorkItemType'] || '',
        state:            wi.fields['System.State'] || '',
        column,
        parentAssignedTo,
        qaTaskAssignedTo,
        qaTaskTitle:      task?.fields['System.Title'] || '',
        qaTaskState:      task?.fields['System.State'] || '',
        hasQaTask,
        notes:            noteParts.join(' — '),
        assigneeSource:   hasQaTask ? 'qaTask' : 'parent',
        rowKey,
      });
    };

    if (qaTasks.length) qaTasks.forEach(makeRow);
    else makeRow(null);
  });

  LOG(`\n═══ Complete. ${results.length} rows emitted across columns: [${[...columnsSeen].join(', ')}]`);

  return {
    items:     results,
    columns:   [...columnsSeen],
    boardName: `${parsed.team} Board`,
    scrapedAt: new Date().toLocaleString(),
    pageUrl:   window.location.href,
  };
}

// ── Message listener ─────────────────────────────────────────
// Guard prevents duplicate listeners if the script is injected more than once.

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'scrape') {
      scrapeAzureDevOpsBoardData()
        .then(data => sendResponse({ success: true, data }))
        .catch(err => {
          WARN('Scrape error:', err);
          sendResponse({ success: false, error: err.message });
        });
      return true;
    }

    if (message.action === 'fetchCase') {
      fetchSingleCase(message.caseId)
        .then(data => sendResponse({ success: true, data }))
        .catch(err => {
          WARN('fetchCase error:', err);
          sendResponse({ success: false, error: err.message });
        });
      return true;
    }
  });

  LOG('Content script registered (v11 — Kanban Board).');

// ── Single-case fetcher ───────────────────────────────────────
// Fetches a card + all child Tasks by work item ID.
// Returns { id, title, url, state, column, parentAssignedTo, buildNote, tasks[] } for the popup.
async function fetchSingleCase(caseId) {
  const parsed = parseAzureDevOpsUrl(window.location.href);
  if (!parsed) throw new Error('Not an Azure DevOps Board page.');

  const { baseApiUrl } = parsed;
  const projectEnc = encodeURIComponent(parsed.project);

  // Fetch the card with full relations (for build links + board column)
  const parentUrl = `${baseApiUrl}/_apis/wit/workitems?ids=${caseId}&$expand=all&api-version=7.0`;
  const parentData = await adoGet(parentUrl);
  const wi = (parentData.value || [])[0];
  if (!wi) throw new Error(`Work item #${caseId} not found.`);

  // WIQL to get child tasks
  const project = parsed.project.replace(/'/g, "''");
  const wiqlResult = await adoPost(
    `${baseApiUrl}/${projectEnc}/_apis/wit/wiql?api-version=7.0`,
    {
      query: `
        SELECT [System.Id]
        FROM WorkItemLinks
        WHERE [Source].[System.Id] = ${caseId}
          AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward'
          AND [Target].[System.WorkItemType] = 'Task'
        ORDER BY [System.Id]
        MODE (MustContain)
      `,
    }
  );

  const childIds = (wiqlResult.workItemRelations || [])
    .filter(r => r.source && r.target)
    .map(r => r.target.id);

  let tasks = [];
  if (childIds.length) {
    const fields = [
      'System.Id','System.Title','System.State',
      'System.WorkItemType','System.AssignedTo',
    ].join(',');
    const taskData = await adoGet(
      `${baseApiUrl}/_apis/wit/workitems?ids=${childIds.join(',')}&fields=${fields}&api-version=7.0`
    );
    tasks = (taskData.value || []);
  }

  // Resolve build numbers from ArtifactLink relations
  const buildIds = new Set();
  (wi.relations || []).forEach(r => {
    if (r.rel === 'ArtifactLink') {
      const id = buildIdFromArtifactUrl(r.url);
      if (id) buildIds.add(id);
    }
  });

  let buildNumberMap = {};
  if (buildIds.size) {
    try {
      const bData = await adoGet(
        `${baseApiUrl}/${projectEnc}/_apis/build/builds?buildIds=${[...buildIds].join(',')}&api-version=7.0`
      );
      (bData.value || []).forEach(b => { buildNumberMap[b.id] = b.buildNumber; });
    } catch (e) { WARN('Build fetch failed:', e.message); }
  }

  const buildNote = getIntegratedBuild(wi, buildNumberMap);

  return {
    id:               wi.id,
    title:            wi.fields['System.Title'] || '(no title)',
    url:              `${baseApiUrl}/${projectEnc}/_workitems/edit/${wi.id}`,
    state:            wi.fields['System.State'] || '',
    column:           wi.fields['System.BoardColumn'] || '(No Column)',
    parentAssignedTo: getDisplayName(wi.fields['System.AssignedTo']),
    buildNote,
    tasks: tasks.map(t => ({
      id:         t.id,
      title:      t.fields['System.Title'] || '',
      state:      t.fields['System.State'] || '',
      assignedTo: getDisplayName(t.fields['System.AssignedTo']),
    })),
  };
}

} // end window.__qaScraperLoaded guard
