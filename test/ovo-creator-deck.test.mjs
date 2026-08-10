import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const DECK = new URL("../sales-decks/", import.meta.url);

async function raw(name) {
  return readFile(new URL(name, DECK));
}

async function source(name) {
  return raw(name).then((buffer) => buffer.toString("utf8"));
}

async function digest(name) {
  return createHash("sha256").update(await raw(name)).digest("hex");
}

function slideTitles(html) {
  return [...html.matchAll(/<section class="[^"]*\bslide\b[^"]*" data-title="([^"]+)"/g)].map((match) => match[1]);
}

test("default creator deck is the exact pre-rebuild 13-slide presentation", async () => {
  const html = await source("creator.html");

  assert.deepEqual(slideTitles(html), [
    "Your private OVO proposal",
    "Your OVO profile preview",
    "300+ signed creator partnerships",
    "The signal is already there",
    "Why OVO invited you",
    "Two campaigns we sell first",
    "The OVO outbound engine",
    "OVO client proof",
    "Your first 30 days",
    "What hammering means",
    "You keep the final yes",
    "Simple economics",
    "Put the machine behind it",
  ]);
  assert.equal(slideTitles(html).length, 13);
  assert.match(html, /<span data-total-slides>13<\/span>/);
  assert.match(html, /href="deck\.css"/);
  assert.match(html, /src="personalize\.js" defer/);
  assert.match(html, /300\+ signed creator partnerships/);
  assert.match(html, /The OVO outbound engine/);
  assert.match(html, /What hammering means/);
  assert.doesNotMatch(html, /creator-read-layout|20 days between signed agreements/);
});

test("default creator presentation assets remain byte-identical to the approved old deck", async () => {
  const expected = {
    "creator.html": "b9844463787512158ecb58b97c7d1b3887ee1a7fa983a3a91a9ce06f54e074f8",
    "deck.css": "b36f2ac3594c9b5be0eb947b8aef8092119cdb6da1199ed9e141d4410f0b995f",
    "personalize.js": "244f955e08773a3a5ef4b2b906ad14c0fe7e89dac889923cbd5a3ad1d4f39d64",
    "index.html": "14c418619edef798fbc04f21f5c356d688fe63d2697c917a14df948675488130",
    "finalized.json": "11a065e301b524f882380f5fc9ba6ed235862fe30ee3e080966df778514be7cb",
    "assets/previews/creator.webp": "2f9cb6fda24914a6db8b26b5800ff30c86f175da2d5f4ff58abf4054718aea49",
  };

  for (const [name, sha256] of Object.entries(expected)) {
    assert.equal(await digest(name), sha256, `${name} drifted from the approved pre-rebuild version`);
  }
});

test("August 2026 rebuild remains available only as an isolated archive", async () => {
  const [html, css, script, index] = await Promise.all([
    source("creator-2026-08-archive.html"),
    source("creator-2026-08-archive.css"),
    source("creator-2026-08-archive-personalize.js"),
    source("index.html"),
  ]);

  assert.deepEqual(slideTitles(html), [
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
  assert.match(html, /<span data-total-slides>10<\/span>/);
  assert.match(html, /<meta name="robots" content="noindex,nofollow,noarchive">/);
  assert.match(html, /href="creator-2026-08-archive\.css"/);
  assert.match(html, /src="creator-2026-08-archive-personalize\.js" defer/);
  assert.match(html, /src="deck\.js" defer/);
  assert.doesNotMatch(html, /href="deck\.css"/);
  assert.doesNotMatch(html, /src="personalize\.js"/);
  assert.match(html, /20 days between signed agreements/);
  assert.match(css, /\.creator-read-layout\[data-post-count="0"\]/);
  assert.match(script, /readLayout\.dataset\.postCount = String\(posts\.length\)/);
  assert.doesNotMatch(index, /creator-2026-08-archive/);
});

test("presentation room and proposal manifest point only to the restored deck", async () => {
  const [index, finalizedSource] = await Promise.all([
    source("index.html"),
    source("finalized.json"),
  ]);
  const finalized = JSON.parse(finalizedSource);
  const creator = finalized.presentations.find((presentation) => presentation.screen === "creator-partnership");

  assert.match(index, /href="creator\.html#1"/);
  assert.match(index, /13 slides · Personalized creator close/);
  assert.match(index, /Live public profile, OVO contact-email preview, three real roster examples/);
  assert.doesNotMatch(index, /creator-2026-08-archive/);
  assert.equal(creator.html_file, "creator.html");
  assert.equal(creator.slides, 13);
  assert.equal(finalized.personalized_url_shape, "/creator.html?ig=<handle>&exp=<unix>&sig=<hmac>&p=<signed-proposal>#1");
});

test("archived rebuild assets preserve the shipped revision", async () => {
  const expected = {
    "creator-2026-08-archive.html": "f24a5894806618806301e78826d4b037a0ab7f0be94be9912d573f5dd8a6e92c",
    "creator-2026-08-archive.css": "0d1205a900dc21c1d9266b03c1095655c6aa0e544d53744c8d53aec4f4e06774",
    "creator-2026-08-archive-personalize.js": "fe1090b849ab7e7ff3b5da95bd1488565b577bafa5754f3118836231f7fcfc72",
    "assets/previews/creator-2026-08-archive.webp": "4e558ad819b78e5bf910aab74186e168e9c700a1fbbe6fd978aa55fb68d059b8",
  };

  for (const [name, sha256] of Object.entries(expected)) {
    assert.equal(await digest(name), sha256, `${name} drifted from the archived shipped revision`);
  }
});
