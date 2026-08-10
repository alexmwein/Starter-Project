import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const DECK = new URL("../sales-decks/", import.meta.url);

async function source(name) {
  return readFile(new URL(name, DECK), "utf8");
}

test("brand deck keeps the 12-slide sales narrative and truthful proof scope", async () => {
  const html = await source("brands.html");
  const slides = html.match(/<section class="slide\b/g) || [];

  assert.equal(slides.length, 12);
  assert.match(html, /51 of 65/);
  assert.match(html, /174\.5K public views/);
  assert.match(html, /12\.8M/);
  assert.match(html, /13\.4M/);
  assert.match(html, /Seven signed creators, including Akram, Colby, and Daria/);
  assert.match(html, /Posted workflow rows recorded for Milan Manfredi and Samantha Baio/);
  assert.match(html, /Five executed creator partnerships across the wider AYBL program/);
  assert.match(html, /Eight creators signed in seven weeks/);
  assert.match(html, /Agreement records are the unit, not 300 unique active creators/);
  assert.doesNotMatch(html, /data-evidence-state="illustrative"/);
});

test("brand protection story uses one risk case and creator-focused legal alignment", async () => {
  const html = await source("brands.html");
  const visibleHtml = html.replace(/<aside class="notes" hidden>[\s\S]*?<\/aside>/g, "");
  const riskSlides = html.match(/class="slide case-study-slide"/g) || [];

  assert.equal(riskSlides.length, 1);
  assert.match(html, /OVO’s specialist legal partner separately contacts each contracted creator/);
  assert.match(html, /Every creator hears the terms/);
  assert.match(html, /documented agreement trail and a clear escalation path/);
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
  assert.match(script, /\["1", "2", "3"\]\.includes\(key\)/);
  assert.match(script, /for \(let index = 0; index < 126; index \+= 1\)/);
  assert.match(script, /index < 6; index \+= 1/);
  assert.match(script, /prefers-reduced-motion: reduce/);
  assert.match(index, /brands\.html#11/);
  assert.match(portal, /brands\.html#11/);
  assert.doesNotMatch(portal, /brands\.html#10/);
});
