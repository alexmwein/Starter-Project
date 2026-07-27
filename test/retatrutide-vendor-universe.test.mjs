import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const DATA_PATH = new URL(
  "../biologix-strategy-board/research/retatrutide-vendor-universe-data.js",
  import.meta.url,
);
const PAGE_PATH = new URL(
  "../biologix-strategy-board/research/operating-blueprint.html",
  import.meta.url,
);

async function loadDataset() {
  const source = await readFile(DATA_PATH, "utf8");
  const context = { window: {} };
  vm.runInNewContext(source, context, { filename: DATA_PATH.pathname });
  return context.window.NOLI_RETATRUTIDE_VENDOR_UNIVERSE;
}

test("vendor universe preserves its evidence counts and minimum useful coverage", async () => {
  const data = await loadDataset();

  assert.ok(data.generatedAt);
  assert.ok(data.vendors.length >= 600);
  assert.equal(data.stats.total, data.vendors.length);
  assert.equal(
    data.stats.linkedWebsites,
    data.vendors.filter((vendor) => vendor.url).length,
  );
  assert.equal(
    data.stats.checkoutAudited,
    data.vendors.filter((vendor) => vendor.payments.length > 0).length,
  );
  assert.equal(data.stats.confirmedRetailStorefronts, 84);
  assert.equal(data.stats.probableRetailStorefronts, 28);
  assert.ok(data.stats.checkoutAudited >= 40);
});

test("payment observations remain explicitly bounded evidence", async () => {
  const data = await loadDataset();
  const sparta = data.vendors.find((vendor) => vendor.domain === "spartalabs.net");
  const bluum = data.vendors.find((vendor) => vendor.domain === "bluumpeptides.com");

  assert.match(sparta.paymentEvidence, /checkout/i);
  assert.match(sparta.paymentNote, /tested runtime/i);
  assert.equal(bluum.platform, "Shopify");
  assert.match(bluum.paymentEvidence, /payment policy/i);
  assert.ok(
    data.vendors
      .filter((vendor) => vendor.payments.length)
      .every((vendor) => vendor.paymentEvidence),
  );
});

test("central page loads the searchable universe and keeps full evidence on-page", async () => {
  const html = await readFile(PAGE_PATH, "utf8");

  assert.match(html, /retatrutide-vendor-universe-data\.js/);
  assert.match(html, /retatrutide-vendor-universe\.js/);
  assert.match(html, /id="vendor-radar"/);
  assert.match(html, /Sparta Labs case file/);
  assert.match(html, /Bluum Peptides case file/);
  assert.doesNotMatch(html, /Biologix-Market-Operating-Evidence\.pdf/);
});
