import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  compileBriefs,
  evidenceForArtifact,
  generateBackgroundBriefs,
  parseHeadroom,
  parseModelPicks,
  parseWindowAssignment,
  pickSchema,
  selectEvidence,
  validatePicks,
} from '../tools/peptide-content-intel/generate_ai_briefs.mjs';

function video(overrides = {}) {
  return {
    id: '1001',
    h: 'creator-one',
    url: 'https://example.com/video/1001',
    on_topic: true,
    comp: false,
    gap: false,
    mature: true,
    out30: 4.2,
    plays: 4200,
    creator_lane: 'research_peptide',
    prof: 'speech_led',
    diff: 2,
    primary_source: 'transcript',
    tr: 'A source transcript with enough words to qualify as evidence for structural selection.',
    cap: '',
    os: [],
    ...overrides,
  };
}

test('parseWindowAssignment reads generated data without evaluating JavaScript', () => {
  const parsed = parseWindowAssignment('/* generated */\nwindow.PEPTIDE_VIDEOS = {"videos":[{"id":"1"}]};\n');
  assert.equal(parsed.videos[0].id, '1');
});

test('selectEvidence keeps safe, measured research-lane rows and caps creator concentration', () => {
  const dataset = {
    videos: [
      video({ id: '1', out30: 9 }),
      video({ id: '2', out30: 8 }),
      video({ id: '3', out30: 7 }),
      video({ id: '4', h: 'creator-two', out30: 6 }),
      video({ id: '5', h: 'blocked', comp: true, out30: 99 }),
      video({ id: '6', h: 'telehealth', creator_lane: 'telehealth', out30: 98 }),
    ],
  };
  const evidence = selectEvidence(dataset);
  assert.deepEqual(evidence.map((row) => row.id), ['video:1', 'video:2', 'video:4']);
});

test('model picks require exact evidence IDs and unique allowed angles', () => {
  const evidence = selectEvidence({ videos: [video()] });
  const picks = validatePicks({
    picks: [
      { angle: 'evidence-literacy', source_ids: ['video:1001', 'video:invented'] },
      { angle: 'evidence-literacy', source_ids: ['video:1001'] },
      { angle: 'not-allowed', source_ids: ['video:1001'] },
    ],
  }, evidence);
  assert.deepEqual(picks, [{ angle: 'evidence-literacy', sourceIds: ['video:1001'] }]);
});

test('the request schema constrains IDs and fenced JSON is still parsed safely', () => {
  const evidence = selectEvidence({ videos: [video()] });
  assert.deepEqual(pickSchema(evidence).properties.picks.items.properties.source_ids.items.enum, ['video:1001']);
  assert.deepEqual(parseModelPicks('```json\n{"picks":[]}\n```'), { picks: [] });
  assert.throws(() => parseModelPicks('not json'), /No complete JSON object/);
});

test('compiled briefs never copy unsafe source subject matter', () => {
  const evidence = selectEvidence({ videos: [video({ tr: 'KPV dosing vendor claims and personal outcome language are present in this source.' })] });
  const briefs = compileBriefs([{ angle: 'process-transparency', sourceIds: ['video:1001'] }], evidence);
  const rendered = JSON.stringify(briefs);
  assert.doesNotMatch(rendered, /KPV|dosing|vendor|personal outcome/i);
  assert.match(briefs[0].evidence_summary, /4\.2×/);
  assert.equal(briefs[0].review_required, 'Human compliance and creative review required before production.');
});

test('the browser artifact does not retain source transcript text', () => {
  const evidence = selectEvidence({ videos: [video({ tr: 'Untrusted source wording stays runtime-only.' })] });
  const artifactEvidence = evidenceForArtifact(evidence);
  assert.equal(artifactEvidence[0].text, undefined);
  assert.equal(artifactEvidence[0].id, 'video:1001');
});

test('headroom parser enforces both memory and per-core load limits', () => {
  const safe = parseHeadroom('System-wide memory free percentage: 58%\n{ 4.20 3.00 2.00 }\n12\n');
  const busy = parseHeadroom('System-wide memory free percentage: 58%\n{ 12.00 3.00 2.00 }\n12\n');
  assert.equal(safe.safe, true);
  assert.equal(safe.loadRatio, 0.35);
  assert.equal(busy.safe, false);
});

test('unchanged input exits before any Studio connection is required', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peptide-ai-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const inputFile = path.join(directory, 'videos-data.js');
  const outputFile = path.join(directory, 'ai-briefs.js');
  const source = `window.PEPTIDE_VIDEOS = ${JSON.stringify({ generated_at: '2026-08-21T00:00:00Z', videos: [video()] })};\n`;
  const digest = createHash('sha256').update(source).digest('hex');
  fs.writeFileSync(inputFile, source);
  fs.writeFileSync(outputFile, `window.PEPTIDE_AI_BRIEFS = ${JSON.stringify({ source_digest: digest })};\n`);
  const result = await generateBackgroundBriefs({ inputFile, outputFile });
  assert.equal(result.state, 'unchanged');
});

test('automation is Studio-only and the content page has no generation control', () => {
  const repository = path.resolve(import.meta.dirname, '..');
  const workflow = fs.readFileSync(path.join(repository, '.github/workflows/peptide-content-ai.yml'), 'utf8');
  const contentPage = path.join(repository, 'biologix-strategy-board/content-intel/index.html');
  assert.match(workflow, /runs-on: \[self-hosted, ovo-studio\]/);
  assert.doesNotMatch(workflow, /ubuntu-latest|macos-latest|windows-latest|setup-node|actions\/cache/);
  if (fs.existsSync(contentPage)) {
    const html = fs.readFileSync(contentPage, 'utf8');
    assert.match(html, /Background creative briefs/);
    assert.doesNotMatch(html, /Generate (brief|on Studio)|id="generate/i);
  }
});
