import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const root = process.cwd();
const read = (relativePath) => readFileSync(join(root, relativePath), "utf8");

const html = read("index.html");
const flow = read("operating-flow.html");
const scorecard = read("docs/ovo-operating-system/scorecard-spec.md");
const scriptStart = html.lastIndexOf("<script>");
const scriptEnd = html.indexOf("</script>", scriptStart);
assert(scriptStart >= 0 && scriptEnd > scriptStart, "index.html must contain its operating-system script");

const browserScript = html.slice(scriptStart + "<script>".length, scriptEnd);
const stateStart = browserScript.indexOf("let state = loadState();");
assert(stateStart > 0, "could not locate the dashboard contract definitions");

const definitions = browserScript.slice(0, stateStart);
const sandbox = {};
vm.runInNewContext(
  `${definitions}\n;globalThis.__contract = { defaultData, metricGroups, pipelines, weeklyChecks, evaluateMetricStatus, statusLabel };`,
  sandbox,
  { filename: "index.html#contract" }
);

const { defaultData, metricGroups, pipelines, weeklyChecks, evaluateMetricStatus, statusLabel } = sandbox.__contract;

const expectedMetricContract = scorecard
  .split("\n")
  .filter((line) => /^\| `[^`]+` \|/.test(line))
  .map((line) => {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    return {
      id: cells[0].replaceAll("`", ""),
      name: cells[1],
      owner: cells[3],
      source: cells[4],
      freshnessDays: Number.parseInt(cells[5], 10)
    };
  });

assert.equal(metricGroups.length, 6, "scorecard must keep six explicit metric groups");
assert.deepEqual(
  Array.from(pipelines, (pipeline) => pipeline.name),
  ["Brand opportunities", "Campaigns", "Creator relationships", "InnerDM cohorts", "Operator capacity"],
  "the five canonical pipelines must not drift"
);

const metricIds = new Set();
const legacyMetricIds = new Set();
for (const group of metricGroups) {
  const metrics = defaultData.metrics[group.key];
  assert(Array.isArray(metrics) && metrics.length > 0, `${group.name} must define metrics`);

  for (const metric of metrics) {
    assert(metric.id && !metricIds.has(metric.id), `metric ID must be present and unique: ${metric.id}`);
    metricIds.add(metric.id);
    assert(/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(metric.id), `${metric.id} must use the canonical snake-case ID format`);
    assert(Array.isArray(metric.legacyIds) && metric.legacyIds.length > 0, `${metric.id} must preserve at least one legacy browser-storage ID`);
    for (const legacyId of metric.legacyIds) {
      assert(!legacyMetricIds.has(legacyId), `legacy metric ID must be unique: ${legacyId}`);
      legacyMetricIds.add(legacyId);
    }
    assert(metric.name && metric.owner, `${metric.id} must have a name and accountable seat`);
    assert(metric.source, `${metric.id} must name its authoritative source`);
    assert(Number.isFinite(metric.freshnessDays) && metric.freshnessDays > 0, `${metric.id} must define positive freshness days`);
    assert.equal(metric.current, "", `${metric.id} must not ship with a live-looking default value`);
    assert.equal(metric.asOf, "", `${metric.id} must not ship with a fabricated as-of date`);
    assert(["min", "max", "range", "report"].includes(metric.direction), `${metric.id} has an unsupported threshold mode`);

    if (metric.direction === "min" || metric.direction === "max") {
      assert(Number.isFinite(metric.target), `${metric.id} must define a numeric target`);
      assert(Number.isFinite(metric.warning), `${metric.id} must define a numeric warning threshold`);
    }

    if (metric.direction === "range") {
      for (const field of ["greenMin", "greenMax", "yellowMin", "yellowMax"]) {
        assert(Number.isFinite(metric[field]), `${metric.id} must define ${field}`);
      }
      assert(metric.greenMin <= metric.greenMax, `${metric.id} has an inverted green range`);
      assert(metric.yellowMin <= metric.yellowMax, `${metric.id} has an inverted yellow range`);
    }

    if (metric.direction === "report") {
      assert(metric.targetLabel, `${metric.id} report-only metrics must explain their calibration state`);
    }
  }
}

const actualMetricContract = Array.from(metricGroups).flatMap((group) =>
  Array.from(defaultData.metrics[group.key], (metric) => ({
    id: metric.id,
    name: metric.name,
    owner: metric.owner,
    source: metric.source,
    freshnessDays: metric.freshnessDays
  }))
);
assert.equal(expectedMetricContract.length, 38, "canonical scorecard must define exactly 38 metrics");
assert.deepEqual(actualMetricContract, expectedMetricContract, "dashboard metric identity, ownership, source, and freshness must exactly match scorecard-spec.md");

const metricById = new Map(Array.from(metricGroups).flatMap((group) => Array.from(defaultData.metrics[group.key], (metric) => [metric.id, metric])));
const statusNow = Date.parse("2026-08-21T12:00:00Z");
const statusFor = (id, current, overrides = {}) => evaluateMetricStatus({
  ...metricById.get(id),
  current,
  asOf: "2026-08-21",
  ...overrides
}, statusNow);

assert.equal(statusFor("exec_concentration", 49), "green");
assert.equal(statusFor("exec_concentration", 50), "yellow");
assert.equal(statusFor("exec_concentration", 70), "yellow");
assert.equal(statusFor("exec_concentration", 70.1), "red");
assert.equal(statusFor("idm_contribution", 1), "green");
assert.equal(statusFor("idm_contribution", 0), "yellow");
assert.equal(statusFor("idm_contribution", -1), "red");
assert.equal(statusFor("idm_chargebacks", 0.99), "green");
assert.equal(statusFor("idm_chargebacks", 1), "yellow");
assert.equal(statusFor("idm_chargebacks", 2), "red");
assert.equal(statusFor("ops_capacity_backed", 0), "unknown");
assert.equal(statusFor("ops_capacity_backed", 1), "green");
assert.equal(statusFor("ops_capacity_backed", 6), "red");
assert.equal(statusFor("ops_time_to_productive", 30), "green");
assert.equal(statusFor("ops_time_to_productive", 31), "red");
assert.equal(statusFor("ops_contribution_per", 1), "green");
assert.equal(statusFor("ops_contribution_per", 0), "red");
assert.equal(statusFor("idm_total_gmv", 5000), "green");
assert.equal(statusFor("idm_total_gmv", 4999), "red");
assert.equal(statusFor("exec_contribution", 1, { asOf: "2026-07-01" }), "stale");
assert.equal(statusFor("exec_contribution", 1, { source: "" }), "unknown");
assert.equal(statusFor("exec_contribution", 1), "reported");
assert.deepEqual(
  ["green", "yellow", "red", "unknown", "stale", "reported"].map(statusLabel),
  ["On track", "Watch", "Blocked", "Unknown", "Stale", "Reported"],
  "status labels must communicate meaning rather than raw color names"
);

for (const pipeline of pipelines) {
  assert(pipeline.owner && pipeline.purpose, `${pipeline.name} must have an owner and purpose`);
  assert(pipeline.stages.length >= 7, `${pipeline.name} must define the full operating path`);
  const stageNames = pipeline.stages.map(([name]) => name);
  assert.equal(new Set(stageNames).size, stageNames.length, `${pipeline.name} contains duplicate stages`);
}

assert(weeklyChecks.length >= 10, "weekly review must cover the full control surface");
assert(html.includes("Planning surface, not live truth"), "dashboard must disclose that it is not the live system of record");
assert(html.includes("./docs/ovo-operating-system/ARCHITECTURE.md"), "dashboard must link to the implementation architecture");
assert(html.includes('aria-controls="sidebar"') && html.includes('id="navBackdrop"'), "mobile navigation must expose its controlled region and backdrop");
assert(html.includes('sidebar.toggleAttribute("inert"') && html.includes('aria-expanded'), "closed mobile navigation must leave the focus and accessibility trees");
assert(html.includes('value="${escapeHtml(metric.current)}"'), "locally persisted metric values must be escaped before HTML interpolation");
assert(flow.includes('role="dialog"') && flow.includes('inspector.toggleAttribute("inert"'), "closed flow inspectors must leave the focus and accessibility trees");
assert.equal((flow.match(/class="filter(?: active)?"[^>]+aria-pressed=/g) || []).length, 6, "all flow filters must expose pressed state");
assert(flow.includes("Math.max(0.16") && flow.includes("available / canvasSize.width"), "fit-to-width must work at phone widths");
assert(flow.includes("prefers-reduced-motion"), "flow interactions must respect reduced-motion preferences");

for (const staleSeat of ["Closing AE", "$4K", "three acquisition engines"]) {
  assert(!flow.includes(staleSeat), `flow map still contains a noncanonical claim: ${staleSeat}`);
}
assert(flow.includes("approved contribution floor") && flow.includes("assigned Brand AE"), "flow map must use canonical contribution and Brand AE language");

for (const staleClaim of ["Fitia monthly contract", "Fitia provisional profit", "InnerDM strict MRR <span", "Academy historical sales"]) {
  assert(!html.includes(staleClaim), `dashboard still contains a live-looking stale claim: ${staleClaim}`);
}

const system = read("docs/ovo-operating-system/SYSTEM.md");
const readme = read("docs/ovo-operating-system/README.md");
const architecture = read("docs/ovo-operating-system/ARCHITECTURE.md");
const lifecycle = read("docs/ovo-operating-system/lifecycle-and-routing.md");
const compensation = read("docs/ovo-operating-system/kennedy-compensation-plan.md");

assert(system.includes("Status: canonical"), "SYSTEM.md must identify itself as canonical");
assert(system.includes("Collection is a financial state, not a sales stage"), "SYSTEM.md must preserve the object-boundary decision");
assert(readme.includes("`SYSTEM.md` wins"), "README must route conflicts to SYSTEM.md");
assert(architecture.includes("Status: implementation architecture under [SYSTEM.md](./SYSTEM.md)"), "architecture must remain subordinate to the operating contract");
assert(architecture.includes("## 2. Current implementation boundary"), "architecture must distinguish the local prototype from production truth");
assert(architecture.includes("One object, one lifecycle, many lenses"), "architecture must preserve one canonical record with multiple operator lenses");
assert(architecture.includes("## 11. Operator information architecture"), "architecture must define the production route and navigation model");
assert(lifecycle.includes("## 2. Brand opportunity pipeline") && lifecycle.includes("## 3. Campaign pipeline"), "sales and delivery lifecycles must remain separate");
assert(scorecard.includes("Neither is Green"), "scorecard must fail closed on missing or stale evidence");
assert(compensation.includes("noncanonical") && compensation.includes("not authorized"), "the conflicting compensation proposal must remain quarantined");

for (const document of [system, readme, lifecycle]) {
  assert(!document.includes("OVO owns every brand and creator relationship"), "relationship language must remain precise and non-exclusive");
}

console.log(`OVO operating-system contract valid: ${metricIds.size} metrics, ${pipelines.length} pipelines, ${weeklyChecks.length} weekly controls.`);
