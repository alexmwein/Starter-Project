import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const DECK = new URL("../sales-decks/", import.meta.url);

async function source(name) {
  return readFile(new URL(name, DECK), "utf8");
}

test("brand deck keeps the 12-slide sales narrative and truthful proof scope", async () => {
  const html = await source("brands.html");
  const slides = html.match(/<section class="slide\b/g) || [];

  assert.equal(slides.length, 12);
  assert.match(html, /12\.8M<\/span> recorded public plays/);
  assert.match(html, /65 live Reels/);
  assert.match(html, /174\.5K median/);
  assert.match(html, /24 measured creator accounts/);
  assert.match(html, /These six posts alone:<\/strong> 2\.42M plays · 24\.9K likes/);
  assert.match(html, /<strong>51\/65<\/strong> over 100K/);
  assert.equal((html.match(/class="fitia-post-card(?: |")/g) || []).length, 6);
  assert.equal((html.match(/class="cal-post-card(?: |")/g) || []).length, 5);
  assert.match(html, /13\.4M recorded views\/plays/);
  assert.match(html, /Akram, Colby, Daria, Hannah, Kaylee, Kiara, and Sabrina/);
  assert.match(html, /44 posted workflow rows in 83 days/);
  assert.match(html, /Eight signed BeHard creators/);
  assert.match(html, /Brenda Gutierrez/);
  assert.match(html, /Anna Nelson/);
  assert.match(html, /Six agreements used recurring two-post monthly structures/);
  assert.match(html, /Agreement records are the unit, not 300 unique active creators/);
  assert.doesNotMatch(html, /class="fitia-metric/);
  assert.doesNotMatch(html, /data-evidence-state="illustrative"/);
});

test("brand protection story uses one risk case and creator-focused legal alignment", async () => {
  const html = await source("brands.html");
  const visibleHtml = html.replace(/<aside class="notes" hidden>[\s\S]*?<\/aside>/g, "");
  const slideClasses = [...html.matchAll(/<section class="([^"]*\bslide\b[^"]*)"/g)].map((match) => match[1]);
  const riskIndex = slideClasses.findIndex((value) => value.includes("ftc-risk-slide"));
  const legalIndex = slideClasses.findIndex((value) => value.includes("legal-protocol-slide"));
  const riskSlide = html.match(/<section class="slide case-study-slide ftc-risk-slide"[\s\S]*?<\/section>/)?.[0] || "";

  assert.equal((html.match(/\bftc-risk-slide\b/g) || []).length, 1);
  assert.equal((html.match(/\blegal-protocol-slide\b/g) || []).length, 1);
  assert.equal(riskIndex, 1);
  assert.equal(legalIndex, 2);
  assert.doesNotMatch(riskSlide, /Lord &amp; Taylor/);
  assert.match(riskSlide, /company anonymized/);
  assert.match(riskSlide, /The campaign worked/);
  assert.match(riskSlide, /20-year consent order/);
  assert.match(html, /OVO’s specialist legal partner separately contacts each contracted creator/);
  assert.match(html, /Every signed creator/);
  assert.match(html, /Delivery is monitored\. Exceptions are escalated/);
  assert.doesNotMatch(visibleHtml, /badmouth|talk(?:ing)? behind|gossip/i);
  assert.doesNotMatch(visibleHtml, /Four decisions/i);
});

test("proof rail and creator wall remain interactive and appropriately labeled", async () => {
  const [html, script, index, portal] = await Promise.all([
    source("brands.html"),
    source("deck.js"),
    source("index.html"),
    source("fitia-portal.html"),
  ]);

  assert.equal((html.match(/role="tab"/g) || []).length, 3);
  assert.equal((html.match(/role="tabpanel"/g) || []).length, 3);
  assert.equal((html.match(/instagram\.com\/(?:reel|p)\//g) || []).length, 11);
  assert.match(script, /\["1", "2", "3"\]\.includes\(key\)/);
  assert.match(script, /for \(let index = 0; index < 126; index \+= 1\)/);
  assert.match(script, /index < 6; index \+= 1/);
  assert.match(script, /prefers-reduced-motion: reduce/);
  assert.match(html, /First-party @joinovo campaign archive/);
  assert.match(html, /No public performance or conversion counter is presented/);
  assert.match(index, /brands\.html#11/);
  assert.match(portal, /brands\.html#11/);
  assert.doesNotMatch(portal, /brands\.html#10/);
});

test("every new case-study image is packaged locally", async () => {
  const images = [
    "assets/case-studies/fitia/juan-801k.jpg",
    "assets/case-studies/fitia/meghan-430k.jpg",
    "assets/case-studies/fitia/angel-383k.jpg",
    "assets/case-studies/fitia/mackenzie-302k.jpg",
    "assets/case-studies/fitia/nabiel-255k.jpg",
    "assets/case-studies/fitia/grant-246k.jpg",
    "assets/case-studies/cal-ai/colby-2430k.jpg",
    "assets/case-studies/cal-ai/daria-1590k.jpg",
    "assets/case-studies/cal-ai/daria-1480k.jpg",
    "assets/case-studies/cal-ai/daria-1031k.jpg",
    "assets/case-studies/cal-ai/daria-906k.jpg",
    "assets/case-studies/aybl/milan-leg-press.jpg",
    "assets/case-studies/aybl/milan-squat.jpg",
    "assets/case-studies/behard/giovanni.jpg",
    "assets/case-studies/behard/brenda-app.jpg",
    "assets/case-studies/behard/brenda-product.jpg",
  ];

  await Promise.all(images.map((image) => access(new URL(image, DECK))));
});
