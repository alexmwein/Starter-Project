import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const DECK = new URL("../sales-decks/", import.meta.url);

async function source(name) {
  return readFile(new URL(name, DECK), "utf8");
}

test("creator deck ships the approved 10-slide proof-led sales spine", async () => {
  const html = await source("creator.html");
  const slideTitles = [...html.matchAll(/<section class="[^"]*\bslide\b[^"]*" data-title="([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(slideTitles, [
    "Your private OVO proposal",
    "Why OVO chose you",
    "20 days between signed agreements",
    "Repeat programs. Public proof",
    "Two commercial lanes to open first",
    "We grow deal value",
    "Your first 30 days",
    "You keep the final yes",
    "Clear economics. Written terms",
    "If the fit is mutual",
  ]);
  const slideCount = [...html.matchAll(/<section class="([^"]+)"/g)]
    .filter((match) => match[1].split(/\s+/).includes("slide"))
    .length;
  assert.equal(slideCount, 10);
  assert.match(html, /<span data-total-slides>10<\/span>/);
  assert.doesNotMatch(html, /<section class="slide[^\n]*data-title="What hammering actually means"/);
});

test("creator proof is source-linked, bounded, and conversion-free", async () => {
  const html = await source("creator.html");

  assert.match(html, /20 days<\/span> between signed agreements/);
  assert.match(html, /2\.18M<\/strong><span>recorded public plays/);
  assert.match(html, /28\.3K<\/strong><span>recorded likes/);
  assert.match(html, /instagram\.com\/reel\/DaPRQJiBE-m\//);
  assert.match(html, /Two signed agreements/);
  assert.match(html, /10\.13M<\/dt><dd>recorded views \/ plays/);
  assert.match(html, /instagram\.com\/p\/DNukqna3Poa\//);
  assert.match(html, /Six-month agreement record/);
  assert.match(html, /3\.13M<\/dt><dd>recorded public views/);
  assert.match(html, /instagram\.com\/reel\/DIotuaoP9aX\//);
  assert.match(html, /No revenue or conversion attribution/);
  assert.match(html, /not reach, installs, conversions, revenue or ROAS/);
  assert.doesNotMatch(html, /\$42K|attributed revenue|conversion rate|ROAS of/i);
});

test("creator economics match the canonical Creator Services Agreement", async () => {
  const html = await source("creator.html");
  const economics = html.match(/<section class="slide first-thirty-slide economics-slide creator-economics-slide"[\s\S]*?<aside class="notes" hidden>/)?.[0] || "";

  assert.match(economics, /Campaign Service Fee/);
  assert.match(economics, /<strong>20%<\/strong>/);
  assert.match(economics, /creator compensation shown in each OVO SOW you choose to accept/);
  assert.match(economics, /No default category exclusivity/);
  assert.match(economics, /12-month initial term, then month-to-month/);
  assert.match(economics, /net 30 after OVO receives client funds/);
  assert.match(economics, /Paid media and whitelisting require separate terms and additional compensation/);
  assert.match(html, /You have no obligation to accept it/);
  assert.match(html, /You keep content ownership/);
  assert.match(html, /No campaign, income level or closing date is guaranteed/);
  assert.doesNotMatch(economics, /commission|fire us anytime|manager|talent representative/i);
});

test("creator personalization degrades cleanly from three posts to profile-only", async () => {
  const [html, script, css] = await Promise.all([
    source("creator.html"),
    source("personalize.js"),
    source("deck.css"),
  ]);

  assert.match(html, /data-creator-read-layout data-post-count="0"/);
  assert.equal((html.match(/class="creator-read-post" data-post-card=/g) || []).length, 3);
  assert.match(html, /data-signal-metrics hidden/);
  assert.match(script, /readLayout\.dataset\.postCount = String\(posts\.length\)/);
  assert.match(script, /\.creator-read-post\[data-post-card\]/);
  assert.match(script, /readMetrics\.hidden = !hasPostMetrics/);
  assert.match(script, /Public Instagram snapshot · \$\{posts\.length\}-post sample/);
  assert.doesNotMatch(script, /@ovotalent\.com/);
  assert.match(css, /\.creator-read-layout\[data-post-count="2"\]/);
  assert.match(css, /\.creator-read-layout\[data-post-count="1"\]/);
  assert.match(css, /\.creator-read-layout\[data-post-count="0"\] \.creator-read-posts \{\s*display: none;/);
  assert.match(css, /@media \(max-width: 1024px\) and \(orientation: portrait\)/);
});

test("creator case-study images are packaged locally", async () => {
  const images = [
    "assets/case-studies/fitia/juan-801k.jpg",
    "assets/case-studies/cal-ai/daria-1590k.jpg",
    "assets/case-studies/cal-ai/colby-2430k.jpg",
  ];

  await Promise.all(images.map((image) => access(new URL(image, DECK))));
});
