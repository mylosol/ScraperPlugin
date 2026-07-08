// ============================================================
// QA Update Scraper — rules.js
//
// Customizable rule/filter engine, modeled on the Azure DevOps
// Query editor: a flat list of rule rows, each joined to the
// previous one by And/Or (no nested groups), evaluated left to
// right against a scraped row.
//
// Loaded by popup.html before popup.js.
// ============================================================

const RULE_FIELDS = [
  { key: 'column',           label: 'Column',              type: 'text'    },
  { key: 'state',             label: 'State',               type: 'text'    },
  { key: 'workItemType',      label: 'Work Item Type',      type: 'text'    },
  { key: 'title',             label: 'Title',                type: 'text'    },
  { key: 'parentAssignedTo',  label: 'Parent Assigned To',  type: 'text'    },
  { key: 'qaTaskAssignedTo',  label: 'QA Task Assigned To', type: 'text'    },
  { key: 'qaTaskTitle',       label: 'QA Task Title',        type: 'text'    },
  { key: 'hasQaTask',         label: 'Has QA Task',          type: 'boolean' },
];

const OPERATORS_BY_TYPE = {
  text: ['is', 'is not', 'contains', 'does not contain', 'in', 'not in', 'is empty', 'is not empty'],
  boolean: ['is'],
};

// Operators whose value is a list (rendered as a comma-separated input).
const LIST_OPERATORS = new Set(['in', 'not in']);

function ruleFieldDef(key) {
  return RULE_FIELDS.find(f => f.key === key) || RULE_FIELDS[0];
}

function getRowFieldValue(row, fieldKey) {
  const v = row[fieldKey];
  return v === undefined || v === null ? '' : v;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim().toLowerCase()).filter(Boolean);
  return String(value || '')
    .split(',')
    .map(v => v.trim().toLowerCase())
    .filter(Boolean);
}

function evaluateRule(row, rule) {
  const fieldDef = ruleFieldDef(rule.field);
  const raw = getRowFieldValue(row, rule.field);

  if (fieldDef.type === 'boolean') {
    const expected = rule.value === true || rule.value === 'true';
    return Boolean(raw) === expected;
  }

  const value    = String(raw).toLowerCase();
  const ruleValue = String(rule.value ?? '').toLowerCase();

  switch (rule.operator) {
    case 'is':               return value === ruleValue;
    case 'is not':            return value !== ruleValue;
    case 'contains':          return ruleValue !== '' && value.includes(ruleValue);
    case 'does not contain':  return ruleValue === '' || !value.includes(ruleValue);
    case 'in':                return normalizeList(rule.value).includes(value);
    case 'not in':             return !normalizeList(rule.value).includes(value);
    case 'is empty':          return value === '';
    case 'is not empty':       return value !== '';
    default:                  return true;
  }
}

// Rules are evaluated sequentially, left to right, using each rule's
// own joiner to combine with the running result (the first rule's
// joiner is ignored). This mirrors the (non-grouped) ADO query editor.
function evaluateRuleSet(row, ruleSet) {
  const rules = (ruleSet && ruleSet.rules) || [];
  if (!rules.length) return true;

  let result = evaluateRule(row, rules[0]);
  for (let i = 1; i < rules.length; i++) {
    const rule = rules[i];
    const ruleResult = evaluateRule(row, rule);
    result = rule.joiner === 'Or' ? (result || ruleResult) : (result && ruleResult);
  }
  return result;
}

const DEFAULT_RULE_SET = {
  id:    'default',
  name:  'Ready & In QA (default)',
  rules: [
    { id: 'r1', joiner: 'And', field: 'column', operator: 'in', value: ['Ready For QA', 'In QA'] },
  ],
};

function makeEmptyRule(joiner) {
  return { id: `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`, joiner: joiner || 'And', field: 'column', operator: 'is', value: '' };
}
