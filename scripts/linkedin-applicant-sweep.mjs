#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const STATE = join(homedir(), '.local/state/linkedin-applicants');
const DELTAS = join(STATE, 'deltas');
const LOG = join(STATE, 'sweep.log');
const SCRAPER = fileURLToPath(new URL('./linkedin-applicant-scraper.mjs', import.meta.url));

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function oneLine(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function logJob(fields) {
  appendFileSync(LOG, `${fields.map(oneLine).join(' ')}\n`);
}

function runScraper(jobId, outputPath, csvPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [SCRAPER, jobId, '--output', outputPath, '--csv', csvPath],
      { stdio: 'inherit' },
    );
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`scraper exited ${code ?? `via ${signal}`}`));
    });
  });
}

function buildMessage(results) {
  const total = results.reduce((sum, result) => sum + result.records.length, 0);
  const groups = results.map(({ label, records }) => {
    const people = records.map((record) => {
      const email = record.email || 'no email';
      const phone = record.phone || 'no phone';
      return `${record.name || 'Unknown'} (${email}, ${phone})`;
    });
    return `${label}: ${people.join('; ')}`;
  });
  const message = `LinkedIn: ${total} new applicant(s) — ${groups.join('; ')}`;
  return message.length <= 1500 ? message : `${message.slice(0, 1497)}...`;
}

async function main() {
  mkdirSync(DELTAS, { recursive: true });
  const jobsConfig = readJson(join(STATE, 'jobs.json'));
  const config = readJson(join(STATE, 'config.json'));
  const jobs = Array.isArray(jobsConfig.jobs)
    ? jobsConfig.jobs.filter((job) => job.active)
    : [];
  const runAt = new Date();
  const scrapedAt = runAt.toISOString();
  const runstamp = scrapedAt.replace(/[-:.]/g, '');
  const newByJob = [];
  let succeeded = 0;

  for (const job of jobs) {
    const jobId = String(job.id || '');
    const label = String(job.label || jobId);
    const outputPath = join(STATE, `job-${jobId}.json`);
    const csvPath = join(STATE, `job-${jobId}.csv`);
    const previousPath = join(STATE, `job-${jobId}.previous.json`);
    const deltaPath = join(DELTAS, `${jobId}-${runstamp}.json`);
    const hadPrevious = existsSync(outputPath);
    let previous = [];

    try {
      if (!/^\d+$/.test(jobId)) throw new Error('job id must be numeric');
      if (hadPrevious) {
        copyFileSync(outputPath, previousPath);
        previous = readJson(previousPath);
        if (!Array.isArray(previous)) throw new Error('previous job JSON is not an array');
      }

      await runScraper(jobId, outputPath, csvPath);
      const current = readJson(outputPath);
      if (!Array.isArray(current)) throw new Error('scraper output is not an array');

      const previousIds = new Set(previous.map((record) => String(record.application_id)));
      const fresh = current
        .filter((record) => !previousIds.has(String(record.application_id)))
        .map((record) => ({ ...record, job_id: jobId, scraped_at: scrapedAt }));
      writeJson(deltaPath, fresh);

      let crm = 'skipped';
      if (fresh.length > 0 && config.crm_import_script) {
        const importScript = String(config.crm_import_script);
        if (existsSync(importScript)) {
          try {
            await execFileAsync(process.execPath, [importScript, deltaPath]);
            crm = 'ok';
          } catch (error) {
            crm = `failed:${oneLine(error.message || error)}`;
          }
        }
      }

      succeeded += 1;
      if (fresh.length > 0) newByJob.push({ label, records: fresh });
      logJob([
        scrapedAt,
        `job=${jobId}`,
        `label=${label}`,
        `total=${current.length}`,
        `new=${fresh.length}`,
        'status=ok',
        `crm=${crm}`,
      ]);
    } catch (error) {
      if (hadPrevious && existsSync(previousPath)) copyFileSync(previousPath, outputPath);
      else rmSync(outputPath, { force: true });
      logJob([
        scrapedAt,
        `job=${jobId || 'unknown'}`,
        `label=${label || 'unknown'}`,
        'status=failed',
        `error=${oneLine(error.stack || error.message || error)}`,
      ]);
    }
  }

  if (newByJob.length > 0) {
    const message = buildMessage(newByJob);
    try {
      const { stdout, stderr } = await execFileAsync('safe-imessage', [
        '--recipient',
        'alex',
        '--message',
        message,
      ]);
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
    } catch (error) {
      console.error(`safe-imessage failed: ${oneLine(error.message || error)}`);
    }
  }

  if (jobs.length > 0 && succeeded === 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
