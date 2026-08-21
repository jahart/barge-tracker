# River Conditions Data Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `index.html`'s river-conditions panel show real data by generating `river.json` on a schedule via GitHub Actions (USGS stage + trend, NWS flood category), and simplify the UI to match what's actually available (dropping the fake flow/velocity fields).

**Architecture:** A small Node script (`scripts/update-river-conditions.mjs`) calls two public, unauthenticated APIs (USGS water-data, NWS NWPS), computes a trend from the USGS time series, and writes `river.json` to the repo root. A GitHub Actions workflow runs that script every 30 minutes and commits the result directly to `main`, where GitHub Pages already serves it. `index.html` is updated to read the new, simpler JSON shape.

**Tech Stack:** Plain Node.js (native `fetch`, ES modules, no new dependencies), Node's built-in `node:test` runner, GitHub Actions (`schedule` + `workflow_dispatch`).

**Reference spec:** `docs/superpowers/specs/2026-08-21-river-conditions-design.md`

---

### Task 1: Trend-computation helper (pure logic, TDD)

**Files:**
- Create: `scripts/compute-trend.mjs`
- Test: `scripts/compute-trend.test.mjs`

- [ ] **Step 1: Write the failing tests**

`scripts/compute-trend.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTrend } from './compute-trend.mjs';

test('classifies a rising stage', () => {
  assert.equal(computeTrend(25.0, 25.2), 'rising');
});

test('classifies a falling stage', () => {
  assert.equal(computeTrend(25.2, 25.0), 'falling');
});

test('classifies a steady stage within the dead-band', () => {
  assert.equal(computeTrend(25.10, 25.13), 'steady');
});

test('treats exactly +0.05 ft as steady (boundary, not rising)', () => {
  assert.equal(computeTrend(25.00, 25.05), 'steady');
});

test('treats exactly -0.05 ft as steady (boundary, not falling)', () => {
  assert.equal(computeTrend(25.05, 25.00), 'steady');
});

test('classifies just past the rising boundary', () => {
  assert.equal(computeTrend(25.00, 25.06), 'rising');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/compute-trend.test.mjs`
Expected: FAIL — `Cannot find module './compute-trend.mjs'`

- [ ] **Step 3: Write minimal implementation**

`scripts/compute-trend.mjs`:

```js
const STEADY_BAND_FT = 0.05;

export function computeTrend(oldestFt, newestFt) {
  // Round to avoid floating-point noise (e.g. 25.00 - 25.05 === -0.05000000000000071)
  // misclassifying values that are meant to land exactly on the steady-band boundary.
  const delta = Math.round((newestFt - oldestFt) * 1000) / 1000;
  if (delta > STEADY_BAND_FT) return 'rising';
  if (delta < -STEADY_BAND_FT) return 'falling';
  return 'steady';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/compute-trend.test.mjs`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/compute-trend.mjs scripts/compute-trend.test.mjs
git commit -m "feat: add river stage trend computation helper"
```

---

### Task 2: Main river-conditions fetch script

This script calls two real external APIs directly, so it isn't unit-tested — it's verified by actually running it (Step 2 below) and inspecting the real output, the same judgment call made for `AisRelay.js` in the AIS relay plan.

**Files:**
- Create: `scripts/update-river-conditions.mjs`

- [ ] **Step 1: Write the script**

`scripts/update-river-conditions.mjs`:

```js
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeTrend } from './compute-trend.mjs';

const USGS_URL =
  'https://waterservices.usgs.gov/nwis/iv/?sites=03151000&parameterCd=00065&period=PT3H&format=json';
const NWS_URL = 'https://api.water.noaa.gov/nwps/v1/gauges/parw2';

async function fetchStageAndTrend() {
  const res = await fetch(USGS_URL);
  if (!res.ok) throw new Error(`USGS HTTP ${res.status}`);

  const data = await res.json();
  const values = data.value?.timeSeries?.[0]?.values?.[0]?.value;
  if (!values || values.length === 0) {
    throw new Error('USGS response has no stage values');
  }

  const oldestFt = parseFloat(values[0].value);
  const newestFt = parseFloat(values[values.length - 1].value);
  if (!Number.isFinite(oldestFt) || !Number.isFinite(newestFt)) {
    throw new Error('USGS response has non-numeric stage values');
  }

  return { stageFt: newestFt, trend: computeTrend(oldestFt, newestFt) };
}

async function fetchFloodCategory() {
  const res = await fetch(NWS_URL);
  if (!res.ok) throw new Error(`NWS HTTP ${res.status}`);

  const data = await res.json();
  const category = data.status?.observed?.floodCategory;
  if (!category) throw new Error('NWS response missing floodCategory');

  return category;
}

async function main() {
  const [{ stageFt, trend }, floodCategory] = await Promise.all([
    fetchStageAndTrend(),
    fetchFloodCategory(),
  ]);

  const output = {
    stageFt,
    trend,
    floodCategory,
    updated: new Date().toISOString(),
  };

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  writeFileSync(join(repoRoot, 'river.json'), JSON.stringify(output, null, 2) + '\n');

  console.log('Wrote river.json:', output);
}

main().catch((err) => {
  console.error('Failed to update river conditions:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it against the real APIs and verify the output**

Run: `node scripts/update-river-conditions.mjs`
Expected: prints `Wrote river.json: { stageFt: <number>, trend: 'rising'|'falling'|'steady', floodCategory: 'no_flooding'|'minor'|'moderate'|'major', updated: '<ISO timestamp>' }`, and creates `river.json` at the repo root.

- [ ] **Step 3: Inspect the generated file**

Run: `cat river.json`
Expected: valid JSON matching the shape above, with a `stageFt` in the range of a plausible Ohio River stage at Parkersburg (roughly 15–35 ft under normal conditions) and `updated` within the last minute.

- [ ] **Step 4: Remove the local test artifact before committing**

`river.json` at the repo root should only ever be written by the scheduled workflow, not committed from a local run.

Run: `rm river.json`

- [ ] **Step 5: Commit**

```bash
git add scripts/update-river-conditions.mjs
git commit -m "feat: add script to fetch USGS/NWS river conditions into river.json"
```

---

### Task 3: GitHub Actions workflow

**Files:**
- Create: `.github/workflows/river-conditions.yml`

- [ ] **Step 1: Write the workflow**

`.github/workflows/river-conditions.yml`:

```yaml
name: Update river conditions

on:
  schedule:
    - cron: '*/30 * * * *'
  workflow_dispatch: {}

permissions:
  contents: write

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Fetch river conditions and write river.json
        run: node scripts/update-river-conditions.mjs

      - name: Commit and push river.json
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add river.json
          git commit -m "chore: update river conditions"
          git push
```

- [ ] **Step 2: Validate the YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/river-conditions.yml'))" && echo "YAML OK"`
Expected: `YAML OK`

(If `pyyaml` isn't installed, run `pip3 install pyyaml` first — this is only a local syntax sanity check, not a project dependency.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/river-conditions.yml
git commit -m "feat: add scheduled workflow to publish river.json"
```

- [ ] **Step 4: After pushing (Task 6), verify the workflow actually runs**

This can't be verified until the workflow is on `main` (GitHub Actions `schedule` triggers only fire from the default branch). After Task 6's push, either wait up to 30 minutes for the first scheduled run or trigger it manually from the GitHub Actions tab ("Update river conditions" → "Run workflow"), then confirm `river.json` appears at the repo root on GitHub with real values.

---

### Task 4: Simplify the river-conditions CSS

**Files:**
- Modify: `index.html:93-97` (grid), `index.html:147-166` (condition-state classes)

- [ ] **Step 1: Change the stats grid from 3 columns to 1**

Replace (around line 93-97):

```css
.river-stats {
  display:grid;
  grid-template-columns:repeat(3,1fr);
  gap:7px;
}
```

with:

```css
.river-stats {
  display:grid;
  grid-template-columns:1fr;
  gap:7px;
}
```

- [ ] **Step 2: Rename the escalation classes to match flood-category values**

Replace (around line 147-166):

```css
#river-condition.elevated {
  background:#2a200b;
  border-color:#92400e;
  color:#fbbf24;
}
#river-condition.elevated #river-condition-dot { background:#f59e0b; }

#river-condition.strong {
  background:#2a1308;
  border-color:#c2410c;
  color:#fb923c;
}
#river-condition.strong #river-condition-dot { background:#f97316; }

#river-condition.very-strong {
  background:#300909;
  border-color:#991b1b;
  color:#f87171;
}
#river-condition.very-strong #river-condition-dot { background:#ef4444; }
```

with:

```css
#river-condition.minor {
  background:#2a200b;
  border-color:#92400e;
  color:#fbbf24;
}
#river-condition.minor #river-condition-dot { background:#f59e0b; }

#river-condition.moderate {
  background:#2a1308;
  border-color:#c2410c;
  color:#fb923c;
}
#river-condition.moderate #river-condition-dot { background:#f97316; }

#river-condition.major {
  background:#300909;
  border-color:#991b1b;
  color:#f87171;
}
#river-condition.major #river-condition-dot { background:#ef4444; }
```

(The colors are unchanged — green→amber→orange→red — only the class names change, from the old velocity-escalation names to the flood-category names they now represent.)

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "style: rename river-condition escalation classes to flood-category names"
```

---

### Task 5: Simplify the river-conditions HTML

**Files:**
- Modify: `index.html:307-324`

- [ ] **Step 1: Remove the Flow and Current stat boxes**

Replace (around line 307-324):

```html
    <div class="river-stats">
      <div class="river-stat">
        <div class="river-stat-label">Stage</div>
        <div class="river-stat-value" id="river-stage">—</div>
        <div class="river-stat-unit">ft · Parkersburg</div>
      </div>

      <div class="river-stat">
        <div class="river-stat-label">Flow</div>
        <div class="river-stat-value" id="river-flow">—</div>
        <div class="river-stat-unit">kcfs · Willow Island</div>
      </div>

      <div class="river-stat">
        <div class="river-stat-label">Current</div>
        <div class="river-stat-value" id="river-velocity">—</div>
        <div class="river-stat-unit">mph ↓</div>
      </div>

      <div class="river-condition" id="river-condition">
        <span id="river-condition-dot"></span>
        <span id="river-condition-text">Loading river data…</span>
      </div>
    </div>
```

with:

```html
    <div class="river-stats">
      <div class="river-stat">
        <div class="river-stat-label">Stage</div>
        <div class="river-stat-value" id="river-stage">—</div>
        <div class="river-stat-unit">ft · Parkersburg</div>
      </div>

      <div class="river-condition" id="river-condition">
        <span id="river-condition-dot"></span>
        <span id="river-condition-text">Loading river data…</span>
      </div>
    </div>
```

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "feat: remove fake flow/current stat boxes from river panel"
```

---

### Task 6: Rewrite the river-conditions JS to match the new data shape

**Files:**
- Modify: `index.html` (the `RIVER CONDITIONS` section — currently the block from the `RIVER_DATA_URL` comment through the end of `setRiverCondition()`)

- [ ] **Step 1: Replace `updateRiverConditions()` and `setRiverCondition()`**

Replace:

```js
/* River JSON generated by GitHub Actions */
const RIVER_DATA_URL = './river.json';

/* ==========================================================================
   RIVER CONDITIONS
   ========================================================================== */

async function updateRiverConditions() {
  try {
    const response = await fetch(
      RIVER_DATA_URL + '?t=' + Date.now(),
      { cache: 'no-store' }
    );

    if (!response.ok) {
      throw new Error(`river.json HTTP ${response.status}`);
    }

    const data = await response.json();

    if (Number.isFinite(data.usgs?.stageFt)) {
      document.getElementById('river-stage').textContent =
        data.usgs.stageFt.toFixed(2);
    }

    if (Number.isFinite(data.nws?.flowKcfs)) {
      document.getElementById('river-flow').textContent =
        data.nws.flowKcfs.toFixed(1);
    }

    if (Number.isFinite(data.nws?.velocityMph)) {
      document.getElementById('river-velocity').textContent =
        data.nws.velocityMph.toFixed(1);

      setRiverCondition(data.nws.velocityMph);
    }

    const updated = data.updated
      ? new Date(data.updated)
      : null;

    document.getElementById('river-updated').textContent =
      updated && !isNaN(updated)
        ? 'Updated ' + updated.toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit'
          })
        : 'No timestamp';

    console.log('River data:', data);

  } catch (err) {
    console.error('River data error:', err);

    const condition = document.getElementById('river-condition');
    condition.className = 'river-condition error';
    document.getElementById('river-condition-text').textContent =
      'River data unavailable';
    document.getElementById('river-updated').textContent = 'Fetch failed';
  }
}

/*
 * These are dashboard categories, NOT official safety thresholds.
 * They are intentionally oriented toward your rowing use.
 */
function setRiverCondition(mph) {
  const condition = document.getElementById('river-condition');
  const text = document.getElementById('river-condition-text');

  condition.className = 'river-condition';

  if (mph < 1.2) {
    text.textContent = 'NORMAL CURRENT';
  } else if (mph < 1.7) {
    condition.classList.add('elevated');
    text.textContent = 'ELEVATED CURRENT';
  } else if (mph < 2.2) {
    condition.classList.add('strong');
    text.textContent = 'STRONG CURRENT · NEAL ISLAND CAUTION';
  } else {
    condition.classList.add('very-strong');
    text.textContent = 'VERY STRONG CURRENT · NEAL ISLAND CAUTION';
  }
}

/* Initial river load + refresh every 10 minutes */
updateRiverConditions();
setInterval(updateRiverConditions, 10 * 60 * 1000);
```

with:

```js
/* River JSON generated by a scheduled GitHub Actions workflow
   (.github/workflows/river-conditions.yml) */
const RIVER_DATA_URL = './river.json';

/* ==========================================================================
   RIVER CONDITIONS
   ========================================================================== */

const TREND_ARROWS = { rising: '↑', falling: '↓', steady: '→' };

async function updateRiverConditions() {
  try {
    const response = await fetch(
      RIVER_DATA_URL + '?t=' + Date.now(),
      { cache: 'no-store' }
    );

    if (!response.ok) {
      throw new Error(`river.json HTTP ${response.status}`);
    }

    const data = await response.json();

    if (Number.isFinite(data.stageFt)) {
      const arrow = TREND_ARROWS[data.trend] || '';
      document.getElementById('river-stage').textContent =
        data.stageFt.toFixed(2) + (arrow ? ' ' + arrow : '');
    }

    if (data.floodCategory) {
      setFloodCategory(data.floodCategory);
    }

    const updated = data.updated
      ? new Date(data.updated)
      : null;

    document.getElementById('river-updated').textContent =
      updated && !isNaN(updated)
        ? 'Updated ' + updated.toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit'
          })
        : 'No timestamp';

    console.log('River data:', data);

  } catch (err) {
    console.error('River data error:', err);

    const condition = document.getElementById('river-condition');
    condition.className = 'river-condition error';
    document.getElementById('river-condition-text').textContent =
      'River data unavailable';
    document.getElementById('river-updated').textContent = 'Fetch failed';
  }
}

const FLOOD_CATEGORY_TEXT = {
  no_flooding: 'NORMAL POOL',
  minor: 'MINOR FLOODING',
  moderate: 'MODERATE FLOODING',
  major: 'MAJOR FLOODING',
};

function setFloodCategory(category) {
  const condition = document.getElementById('river-condition');
  const text = document.getElementById('river-condition-text');

  condition.className = 'river-condition';

  if (category !== 'no_flooding') {
    condition.classList.add(category);
  }

  text.textContent = FLOOD_CATEGORY_TEXT[category] || 'UNKNOWN';
}

/* Initial river load + refresh every 10 minutes */
updateRiverConditions();
setInterval(updateRiverConditions, 10 * 60 * 1000);
```

- [ ] **Step 2: Check the JS still parses correctly**

Run:
```bash
python3 -c "
import re
content = open('index.html').read()
script = re.search(r'<script>(.*)</script>', content, re.S).group(1)
open('/tmp/index-check.js', 'w').write(script)
"
node --check /tmp/index-check.js
```
Expected: no output (success)

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: rewrite river-conditions UI for the real stage+trend+flood-category data"
```

---

### Task 7: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Create a realistic fake river.json for local testing**

Run: `cat > /tmp/river-test-server/river.json << 'EOF'
{
  "stageFt": 24.67,
  "trend": "falling",
  "floodCategory": "no_flooding",
  "updated": "2026-08-21T18:00:00Z"
}
EOF` (create the `/tmp/river-test-server` directory first if needed with `mkdir -p /tmp/river-test-server`)

- [ ] **Step 2: Serve index.html alongside the fake river.json**

Run:
```bash
cp index.html /tmp/river-test-server/index.html
cd /tmp/river-test-server && python3 -m http.server 8899
```

- [ ] **Step 3: Open it in a browser and verify**

Open `http://localhost:8899/index.html`. Confirm:
- The "Stage" box shows `24.67 ↓`
- The condition banner shows "NORMAL POOL" with the green dot (no extra class, since `floodCategory` is `no_flooding`)
- No "Flow" or "Current" boxes are present
- No console errors

- [ ] **Step 4: Verify the flood-category escalation states**

Edit `/tmp/river-test-server/river.json`'s `floodCategory` to `"minor"`, refresh the page, confirm the banner turns amber and reads "MINOR FLOODING". Repeat for `"moderate"` (orange, "MODERATE FLOODING") and `"major"` (red, "MAJOR FLOODING").

- [ ] **Step 5: Verify the error path still works**

Delete `/tmp/river-test-server/river.json` (or rename it), refresh the page, confirm the banner shows "River data unavailable" in the gray error state and `river-updated` shows "Fetch failed".

- [ ] **Step 6: Clean up**

Stop the `http.server` process (Ctrl+C) and remove the test directory: `rm -rf /tmp/river-test-server`

---

### Task 8: Push and confirm the live workflow

**Files:** none (deployment/observation only)

- [ ] **Step 1: Push all commits from Tasks 1–6**

```bash
git push origin main
```

- [ ] **Step 2: Trigger the workflow manually the first time**

On GitHub, go to the repo's Actions tab → "Update river conditions" → "Run workflow" (don't wait up to 30 minutes for the first scheduled run).

- [ ] **Step 3: Confirm river.json landed on GitHub**

Run: `curl -s https://raw.githubusercontent.com/jahart/barge-tracker/main/river.json`
Expected: real JSON with a plausible `stageFt`, a `trend`, a `floodCategory`, and a fresh `updated` timestamp.

- [ ] **Step 4: Confirm the live page shows it**

Open `https://jahart.github.io/barge-tracker/` (or fetch it directly) and confirm the river-conditions panel shows the real stage value and flood category instead of "River data unavailable."

---

## Self-Review Notes

- **Spec coverage:** data sources (Task 2), `river.json` shape (Task 2), GitHub Actions workflow incl. always-commit and fail-loudly behavior (Task 3), UI stat-box removal (Task 5), trend arrow (Task 6), flood-category banner reusing the existing visual escalation (Tasks 4 & 6), error handling unchanged (Task 6, verified in Task 7 Step 5).
- **Type consistency:** `computeTrend(oldestFt, newestFt)` signature (Task 1) matches its call site in `update-river-conditions.mjs` (Task 2). The `river.json` field names (`stageFt`, `trend`, `floodCategory`, `updated`) are identical across the script (Task 2) and the client-side reader (Task 6). CSS class names `minor`/`moderate`/`major` (Task 4) match exactly what `setFloodCategory` (Task 6) adds via `classList.add(category)`, and match NWS's own `floodCategory` string values verbatim — no translation table needed beyond the display-text map.
- **No placeholders:** none found.
