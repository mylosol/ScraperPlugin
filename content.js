// ============================================================
// QA Update Scraper — content.js  v9.3
//
// Debug: open DevTools on the ADO tab → Console, filter "[QA Scraper]"
// ============================================================
if (!window.__qaScraperLoaded) {
  window.__qaScraperLoaded = true;
  
const LOG  = (...args) => console.log('[QA Scraper]',  ...args);
const WARN = (...args) => console.warn('[QA Scraper]', ...args);

// ── Task-name classifiers ────────────────────────────────────

function isCodeSolutionTask(title) {
  return /code\s*(the\s*)?solution/i.test(title);
}
function isCodeReviewTask(title) {
  return /code\s*review/i.test(title);
}
function isDevTestTask(title) {
  // Match any task whose title contains the phrase "Dev Test" — including
  // "Dev Test for QA Findings", "Dev Test (Round 2)", etc.
  // "Dev Automated Test" does NOT match because "Dev" and "Test" are not adjacent.
  return /\bdev\s+test\b/i.test(title);
}
function isDevOrCodeTask(title) {
  // BROAD match used only for the blocking check.
  // If ANY task starting with "Dev" or "Code" is In Progress,
  // QA rows (Ready / QA Test in progress) are suppressed.
  // This intentionally catches "Dev Test for QA Findings",
  // "Dev Automated Test", "Code Review", "Code the Solution", etc.
  return /^\s*(dev|code)\b/i.test(title);
}
function isQATask(title) {
  // Must START with "QA" — prevents false matches like "PR for QA findings",
  // "Dev Test for QA Findings", etc.
  // Matches: "QA", "QA Test", "QA Task", "QA Test in Feature Branch 3",
  //          "QA Automated Test", "QA Test in Develop"
  return /^\s*qa\b/i.test(title);
}
function isFeatureBranchQATask(title) {
  return /feature\s*branch/i.test(title);
}
function isDevelopQATask(title) {
  return /\bdevelop\b/i.test(title);
}

// Extract a trailing enumeration number from a task title.
// "QA Test in Feature Branch 3" → 3   "QA Test" → null
function qaTaskEnumeration(title) {
  const m = title.match(/\b(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : null;
}

// ── URL parser ───────────────────────────────────────────────

function parseAzureDevOpsUrl(url) {
  try {
    const u = new URL(url);
    let org, project, team, baseApiUrl;

    if (u.hostname === 'dev.azure.com') {
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length < 5) return null;
      org        = parts[0];
      project    = decodeURIComponent(parts[1]);
      team       = decodeURIComponent(parts[4]);
      baseApiUrl = `https://dev.azure.com/${org}`;
    } else if (u.hostname.endsWith('.visualstudio.com')) {
      org        = u.hostname.replace('.visualstudio.com', '');
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length < 4) return null;
      project    = decodeURIComponent(parts[0]);
      team       = decodeURIComponent(parts[3]);
      baseApiUrl = `https://${u.hostname}`;
    } else {
      return null;
    }

    const pathParts  = u.pathname.split('/').filter(Boolean);
    const sprintsIdx = pathParts.findIndex(p => p === '_sprints');
    const iterParts  = sprintsIdx >= 0 ? pathParts.slice(sprintsIdx + 3) : [];
    const iterUrlName = iterParts.map(decodeURIComponent).join('\\');

    LOG('Parsed URL →', { org, project, team, baseApiUrl, iterUrlName });
    return { org, project, team, baseApiUrl, iterUrlName };
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
    'Microsoft.VSTS.Build.IntegrationBuild',
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
// AND relations. We use this to find ArtifactLink relations (linked builds).
// NOTE: Cannot combine fields= and $expand= in one call — $expand is silently
// dropped when fields= is present. So this is a separate fetch for parents only.
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
// fetch them from the Builds API in one call, and return a
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

  if (!buildIds.size) {
    LOG('  No ArtifactLink build relations found on any parent.');
    return {};
  }

  LOG(`  Fetching build numbers for IDs: [${[...buildIds].join(', ')}]`);
  const idList = [...buildIds].join(',');
  const url = `${baseApiUrl}/${projectEnc}/_apis/build/builds?buildIds=${idList}&api-version=7.0`;

  try {
    const data = await adoGet(url);
    const map  = {};
    (data.value || []).forEach(b => {
      map[b.id] = b.buildNumber;
      LOG(`  build ${b.id} → "${b.buildNumber}"`);
    });
    return map;
  } catch (e) {
    WARN('Build number fetch failed:', e.message);
    return {};
  }
}

// Count how many ArtifactLink build relations on a WI have a resolved
// build number (i.e. the build exists and was returned by the Builds API).
function countBuildsForWi(wi, buildNumberMap) {
  return (wi.relations || []).filter(r => {
    if (r.rel !== 'ArtifactLink') return false;
    const id = buildIdFromArtifactUrl(r.url);
    return id != null && buildNumberMap[id] != null;
  }).length;
}

// Return the linked build number string for a work item, or null.
function extractBuildFromRelations(wi, buildNumberMap) {
  const relations = wi.relations || [];
  const buildLinks = relations.filter(r =>
    r.rel === 'ArtifactLink' &&
    typeof r.url === 'string' &&
    r.url.toLowerCase().includes('/build/build/')
  );
  if (!buildLinks.length) return null;

  // Use the last linked build (most recently added)
  const latest = buildLinks[buildLinks.length - 1];
  const id     = buildIdFromArtifactUrl(latest.url);
  const number = id ? buildNumberMap[id] : null;

  LOG(`  ArtifactLink buildId=${id} → buildNumber="${number}"`);
  return number ? `Integrated in build: ${number}` : null;
}

// ── Main scraper ─────────────────────────────────────────────

async function scrapeAzureDevOpsData() {
  const parsed = parseAzureDevOpsUrl(window.location.href);
  if (!parsed) {
    throw new Error(
      'Not an Azure DevOps sprint page. ' +
      'Navigate to a Sprint Taskboard or Backlog, then click Scrape.'
    );
  }

  const { org, project, team, baseApiUrl, iterUrlName } = parsed;
  const projectEnc = encodeURIComponent(project);
  const teamEnc    = encodeURIComponent(team);

  // ── 1. Resolve the current sprint iteration ─────────────────
  LOG('═══ Step 1: Resolving sprint iteration…');
  let currentIteration = null;

  try {
    const d = await adoGet(
      `${baseApiUrl}/${projectEnc}/${teamEnc}/_apis/work/teamsettings/iterations?$timeframe=current&api-version=7.0`
    );
    if (d.value?.length > 0) {
      currentIteration = d.value[0];
      LOG('  Found via $timeframe=current:', currentIteration.name);
    }
  } catch (e) {
    WARN('  $timeframe=current failed:', e.message);
  }

  if (!currentIteration) {
    LOG('  Falling back to iteration list…');
    try {
      const allIters = await adoGet(
        `${baseApiUrl}/${projectEnc}/${teamEnc}/_apis/work/teamsettings/iterations?api-version=7.0`
      );
      const iters = allIters.value || [];
      LOG('  All iterations:', iters.map(it => `"${it.name}" (${it.path})`));

      if (iterUrlName) {
        currentIteration = iters.find(it => {
          const urlTail   = iterUrlName.toLowerCase();
          const pathLower = it.path.toLowerCase();
          return pathLower.endsWith(urlTail) ||
                 it.name.toLowerCase() === iterUrlName.split('\\').pop().toLowerCase();
        });
        LOG('  URL match:', iterUrlName, '→', currentIteration?.name ?? 'none');
      }
      if (!currentIteration && iters.length) {
        currentIteration = iters[iters.length - 1];
        LOG('  Fallback to last iteration:', currentIteration.name);
      }
    } catch (e) {
      WARN('  Iteration list fetch failed:', e.message);
    }
  }

  if (!currentIteration) {
    throw new Error(
      'Could not determine the current sprint iteration. ' +
      'Check DevTools Console → filter "[QA Scraper]" for details.'
    );
  }
  LOG('Using iteration:', currentIteration.name, '| ID:', currentIteration.id);

  // ── 2. WIQL: PBI / Bug IDs in this sprint ──────────────────
  LOG('═══ Step 2: WIQL — querying sprint PBIs/Bugs…');
  const wiqlProject  = project.replace(/'/g, "''");
  const wiqlIterPath = currentIteration.path.replace(/'/g, "''");

  const wiqlParents = await adoPost(
    `${baseApiUrl}/${projectEnc}/_apis/wit/wiql?api-version=7.0`,
    {
      query: `
        SELECT [System.Id]
        FROM WorkItems
        WHERE [System.TeamProject] = '${wiqlProject}'
          AND [System.IterationPath] = '${wiqlIterPath}'
          AND [System.WorkItemType] IN ('Product Backlog Item', 'Bug', 'User Story', 'Feature')
        ORDER BY [System.Id]
      `,
    }
  );

  const parentIds = (wiqlParents.workItems || []).map(w => w.id);
  LOG(`  Found ${parentIds.length} PBI/Bug IDs:`, parentIds);

  if (!parentIds.length) {
    return {
      items:      [],
      sprintName: currentIteration.name,
      scrapedAt:  new Date().toLocaleString(),
      pageUrl:    window.location.href,
    };
  }

  // ── 3. WIQL: child Tasks for those parents ──────────────────
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

  LOG(`  ${childIdSet.size} child tasks across ${Object.keys(parentToChildren).length} parents`);

  // ── 4. Fetch all work item details ──────────────────────────
  LOG('═══ Step 4: Fetching work item details…');

  // Parents: fetch with $expand=all to capture ArtifactLink (linked build) relations.
  // Children: fetch with fields= only (relations not needed for tasks).
  const parentMap = await fetchParentsWithRelations(baseApiUrl, parentIds);
  const childMap  = await fetchWorkItemsBatch(baseApiUrl, [...childIdSet]);

  // Merge into one lookup map; parent entries (with relations) take precedence.
  const wiMap = { ...childMap, ...parentMap };
  LOG(`  wiMap: ${Object.keys(wiMap).length} entries (${Object.keys(parentMap).length} parents, ${Object.keys(childMap).length} children)`);

  // Fetch the actual build number strings for all ArtifactLink build relations.
  // attributes.name on the relation is just the label ("Integrated in build"),
  // not the build number — we need one more Builds API call to resolve them.
  LOG('═══ Step 4b: Fetching linked build numbers…');
  const buildNumberMap = await fetchBuildNumbers(baseApiUrl, projectEnc, parentMap);

  // Sanity log per parent
  parentIds.forEach(pid => {
    const wi = wiMap[pid];
    if (!wi) { WARN(`  Parent ${pid} missing!`); return; }
    const kids = (parentToChildren[pid] || []).map(cid => {
      const t = wiMap[cid];
      return t
        ? `${cid}:"${t.fields['System.Title']}"[${t.fields['System.State']}]`
        : `${cid}:MISSING`;
    });
    LOG(`  ${wi.fields['System.WorkItemType']} ${pid} state="${wi.fields['System.State']}" — [${kids.join(' | ') || 'none'}]`);
  });

  // ── 5. Helpers ───────────────────────────────────────────────

  const getDisplayName = field => {
    if (!field) return 'Unassigned';
    if (typeof field === 'string') return field;
    return field.displayName || field.uniqueName || 'Unassigned';
  };

  // Returns the build string, or null.
  // Priority: (1) ArtifactLink build number (resolved via Builds API)
  //           (2) Microsoft.VSTS.Build.IntegrationBuild text field on parent
  //           (3) Same text field on any child task (fallback)
  const getIntegratedBuild = (wi, childTasks) => {
    const fromRelations = extractBuildFromRelations(wi, buildNumberMap);
    if (fromRelations) return fromRelations;

    const fieldVal = wi.fields?.['Microsoft.VSTS.Build.IntegrationBuild'];
    if (fieldVal) return `Integrated in build: ${fieldVal}`;

    for (const t of childTasks) {
      const b = t.fields?.['Microsoft.VSTS.Build.IntegrationBuild'];
      if (b) return `Integrated in build: ${b}`;
    }
    return null;
  };

  const ST = { DONE: 'Done', IN_PROGRESS: 'In Progress', TO_DO: 'To Do' };

  const allDone     = tasks => tasks.length > 0 && tasks.every(t => t.fields['System.State'] === ST.DONE);
  const anyIP       = tasks => tasks.some(t => t.fields['System.State'] === ST.IN_PROGRESS);
  const anyToDo     = tasks => tasks.some(t => t.fields['System.State'] === ST.TO_DO);
  const filterState = (tasks, s) => tasks.filter(t => t.fields['System.State'] === s);

// ── 6. Evaluate status rules ─────────────────────────────────
  LOG('═══ Step 5: Evaluating status rules…');
  const results  = [];
  const seenKeys = new Set();
  
  const pushRow = (status, wi, task, extraNotes = [], missingTasksList = []) => {
    // Deduplicate by (PBI id, status, assignedTo)
    const assignedTo = task ? getDisplayName(task.fields['System.AssignedTo']) : 'Unassigned';
    const key = `${wi.id}|${status}|${assignedTo}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);

    const noteParts = [...extraNotes];

    // QA-specific notes only apply when the task is actually a QA task
    if (task && isQATask(task.fields['System.Title'] || '')) {
      const title = task.fields['System.Title'] || '';
      if (isFeatureBranchQATask(title)) noteParts.push('(Feature Branch)');
      else if (isDevelopQATask(title))  noteParts.push('(Develop)');

      const enumNum = qaTaskEnumeration(title);
      if (enumNum !== null) noteParts.push(`Task #${enumNum}`);
    }

    const needsReview = missingTasksList.length > 0;

    LOG(`  ✔ EMIT "${status}" — PBI ${wi.id} assignedTo="${assignedTo}" needsReview=${needsReview}`);

    results.push({
      id:          wi.id,
      title:       wi.fields['System.Title'] || '(no title)',
      url:         `${baseApiUrl}/${projectEnc}/_workitems/edit/${wi.id}`,
      assignedTo,
      status,
      notes:       noteParts.join(' — '),
      taskTitle:   task?.fields['System.Title'] || '',
      needsReview,
      missingTasks: missingTasksList,
      rowKey:      key,
    });
  };

  parentIds.forEach(pid => {
    const wi = wiMap[pid];
    if (!wi) { WARN(`Skipping ${pid} — missing from wiMap`); return; }

    const wiState = wi.fields['System.State'] || '';
    LOG(`\n── PBI ${pid} state="${wiState}"`);

    const childTaskObjs = (parentToChildren[pid] || [])
      .map(cid => wiMap[cid])
      .filter(Boolean);

    wi._allChildTasks = childTaskObjs;

    const codeSolTasks   = childTaskObjs.filter(t => isCodeSolutionTask(t.fields['System.Title'] || ''));
    const codeRevTasks   = childTaskObjs.filter(t => isCodeReviewTask(t.fields['System.Title'] || ''));
    const devTestTasks   = childTaskObjs.filter(t => isDevTestTask(t.fields['System.Title'] || ''));
    const qaTasks        = childTaskObjs.filter(t => isQATask(t.fields['System.Title'] || ''));

    // ── BLOCKING CHECK ────────────────────────────────────────
    const devOrCodeTasks = childTaskObjs.filter(t => isDevOrCodeTask(t.fields['System.Title'] || ''));
    const devOrCodeBlocking = devOrCodeTasks.some(t => t.fields['System.State'] === ST.IN_PROGRESS);
    const devTestIP   = anyIP(devTestTasks);

    // ── Gate logic ────────────────────────────────────────────
    const codeSolSatisfied = codeSolTasks.length === 0 || allDone(codeSolTasks);
    const codeRevSatisfied = codeRevTasks.length === 0 || allDone(codeRevTasks);
    const devTestSatisfied = devTestTasks.length === 0 || allDone(devTestTasks);
    const devTestToDo      = devTestTasks.length > 0   && anyToDo(devTestTasks);

    // Track which standard task types were absent
    const missingTasks = [
      codeSolTasks.length === 0 && 'Code Solution',
      codeRevTasks.length === 0 && 'Code Review',
      devTestTasks.length === 0 && 'Dev Test',
    ].filter(Boolean);

    // Build number (checked on parent WI first, then child tasks)
    const buildNote = getIntegratedBuild(wi, childTaskObjs);

    // ════════════════════════════════════════════════════════
    // IN-PROGRESS STATUSES
    // ════════════════════════════════════════════════════════

    if (wiState === 'Committed' && !devOrCodeBlocking) {
      const ipQA = filterState(qaTasks, ST.IN_PROGRESS);
      ipQA.forEach(qt => {
        const notes = buildNote ? [buildNote] : ['No linked build'];
        pushRow('QA Test in progress', wi, qt, notes, []);
      });
    }

    if (wiState === 'Committed' && devTestIP) {
      const ipDevTest = devTestTasks.find(t => t.fields['System.State'] === ST.IN_PROGRESS);
      const notes = buildNote ? [buildNote] : ['No linked build'];
      pushRow('Dev Test in progress', wi, ipDevTest ?? null, notes, []);
    }

    // ════════════════════════════════════════════════════════
    // "TO DO" STATUSES
    // ════════════════════════════════════════════════════════

    if (wiState === 'Committed' && codeSolSatisfied && codeRevSatisfied && devTestSatisfied && !devOrCodeBlocking) {
      const buildCount = countBuildsForWi(wi, buildNumberMap);

      filterState(qaTasks, ST.TO_DO).forEach(qt => {
        const isFeatureBranch   = isFeatureBranchQATask(qt.fields['System.Title'] || '');
        const enumNum           = qaTaskEnumeration(qt.fields['System.Title'] || '');
        const hasSufficientBuilds = enumNum === null || buildCount >= enumNum;

        if (!hasSufficientBuilds) {
          pushRow('Pending Passing Build', wi, qt, ['No linked build'], missingTasks);
        } else if (buildNote) {
          pushRow('Ready', wi, qt, [buildNote], missingTasks);
        } else if (isFeatureBranch) {
          pushRow('Ready', wi, qt, [], missingTasks);
        } else {
          pushRow('Pending Passing Build', wi, qt, ['No linked build'], missingTasks);
        }
      });
    }

    if (wiState === 'Blocked' && codeSolSatisfied && codeRevSatisfied && devTestSatisfied && !devOrCodeBlocking) {
      filterState(qaTasks, ST.TO_DO).forEach(qt => {
        const notes = buildNote ? [buildNote] : ['No linked build'];
        pushRow('Blocked', wi, qt, notes, missingTasks);
      });
    }

    if (wiState === 'Committed' && codeSolSatisfied && codeRevSatisfied && devTestToDo) {
      const toDoQA = filterState(qaTasks, ST.TO_DO);
      if (toDoQA.length > 0) {
        toDoQA.forEach(qt => pushRow('Pending Dev Test', wi, qt, [], missingTasks));
      } else {
        pushRow('Pending Dev Test', wi, null, [], missingTasks);
      }
    }
  });

  LOG(`\n═══ Complete. ${results.length} rows emitted.`);

  const STATUS_ORDER = {
    'QA Test in progress':    1,
    'Ready':                  2,
    'Pending Passing Build':  3,
    'Blocked':                4,
    'Dev Test in progress':   5,
    'Pending Dev Test':       6,
  };
  results.sort((a, b) => (STATUS_ORDER[a.status] || 9) - (STATUS_ORDER[b.status] || 9));

  return {
    items:      results,
    sprintName: currentIteration.name,
    scrapedAt:  new Date().toLocaleString(),
    pageUrl:    window.location.href,
  };
}

// ── Message listener ─────────────────────────────────────────
// Guard prevents duplicate listeners if the script is injected more than once.

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'scrape') {
      scrapeAzureDevOpsData()
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

  LOG('Content script registered (v9.3).');

// ── Single-case fetcher ───────────────────────────────────────
// Fetches a PBI/Bug + all child Tasks by work item ID.
// Returns { id, title, url, state, buildNote, tasks[] } for the popup.
async function fetchSingleCase(caseId) {
  const parsed = parseAzureDevOpsUrl(window.location.href);
  if (!parsed) throw new Error('Not an Azure DevOps page.');

  const { baseApiUrl } = parsed;
  const projectEnc = encodeURIComponent(parsed.project);

  // Fetch the parent WI with full relations (for build links)
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

  const buildNote = extractBuildFromRelations(wi, buildNumberMap)
    || wi.fields?.['Microsoft.VSTS.Build.IntegrationBuild']
    || null;

  const getDisplayName = field => {
    if (!field) return 'Unassigned';
    if (typeof field === 'string') return field;
    return field.displayName || field.uniqueName || 'Unassigned';
  };

  return {
    id:          wi.id,
    title:       wi.fields['System.Title'] || '(no title)',
    url:         `${baseApiUrl}/${projectEnc}/_workitems/edit/${wi.id}`,
    state:       wi.fields['System.State'] || '',
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
