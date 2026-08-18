#!/usr/bin/env node

import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LINKEDIN_ORIGIN = 'https://www.linkedin.com';
const DEFAULT_CHROMIUM = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEFAULT_ARC_PROFILE = join(
  homedir(),
  'Library/Application Support/Arc/User Data/Profile 1',
);

const JOB_SEEDS = {
  '4452746983': {
    'amelia durr': ['amelialdurr@gmail.com', '+15129157914'],
    'katelyn mckeirnan': ['katemck007@gmail.com', '+18183188010'],
    'aine mcconville': ['ainemcconville@ymail.com', '+16263183719'],
    'rasmalai ingkasampan': ['cherryingkasampan@gmail.com', '+16198820923'],
    'maria jose valdes': ['marjorita04@gmail.com', '+17606204979'],
    'nathalia jimenez': ['nathalia.jimenez.parga@gmail.com', '+16197799365'],
    'bryanna lapiner': ['blapiner4@gmail.com', '+18184568762'],
    'ananya pranava p.': ['ananyapranavapratap1@gmail.com', null],
    'vishakha bhatia': ['bhatiavishakha40@gmail.com', '+919667509122'],
  },
};

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(
    'Usage: node scripts/linkedin-applicant-scraper.mjs JOB_ID ' +
      '[--output PATH] [--csv PATH] [--delay-ms 1200] [--headed] ' +
      '[--arc-profile PATH] [--chromium PATH] [--refresh-contacts] [--no-resumes]',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    jobId: null,
    output: null,
    csv: null,
    delayMs: 1200,
    headed: false,
    arcProfile: DEFAULT_ARC_PROFILE,
    chromium: DEFAULT_CHROMIUM,
    refreshContacts: false,
    resumes: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith('--') && !options.jobId) options.jobId = value;
    else if (value === '--output') options.output = argv[++i];
    else if (value === '--csv') options.csv = argv[++i];
    else if (value === '--delay-ms') options.delayMs = Number(argv[++i]);
    else if (value === '--headed') options.headed = true;
    else if (value === '--arc-profile') options.arcProfile = argv[++i];
    else if (value === '--chromium') options.chromium = argv[++i];
    else if (value === '--refresh-contacts') options.refreshContacts = true;
    else if (value === '--no-resumes') options.resumes = false;
    else usage(`unknown argument ${value}`);
  }

  if (!/^\d+$/.test(options.jobId || '')) usage('JOB_ID must be numeric');
  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
    usage('--delay-ms must be a non-negative number');
  }
  options.output = resolve(
    options.output || `.context/linkedin-applicants-${options.jobId}.json`,
  );
  options.csv = resolve(
    options.csv || options.output.replace(/\.json$/i, '') + '.csv',
  );
  return options;
}

function normalizeName(value) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizePhone(value) {
  if (!value) return null;
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7) return null;
  return `${trimmed.startsWith('+') ? '+' : ''}${digits}`;
}

function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  candidates.push('playwright', 'playwright-core');

  const npxRoot = join(homedir(), '.npm/_npx');
  if (existsSync(npxRoot)) {
    const cached = readdirSync(npxRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => [
        join(npxRoot, entry.name, 'node_modules/playwright'),
        join(npxRoot, entry.name, 'node_modules/playwright-core'),
      ])
      .filter(existsSync)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    candidates.push(...cached);
  }

  for (const candidate of candidates) {
    try {
      const loaded = require(candidate);
      if (loaded.chromium) return loaded;
    } catch {
      // Try the next installed Playwright location.
    }
  }
  throw new Error(
    'Playwright is not installed. Run `npm exec @playwright/mcp@latest -- --help` once, then retry.',
  );
}

function readArcLinkedInCookie(arcProfile) {
  const sourceDb = join(arcProfile, 'Cookies');
  if (!existsSync(sourceDb)) throw new Error(`Arc cookie DB not found: ${sourceDb}`);

  const workDir = mkdtempSync(join(tmpdir(), 'ovo-linkedin-cookie-'));
  const copiedDb = join(workDir, 'Cookies');
  try {
    copyFileSync(sourceDb, copiedDb);
    const row = execFileSync(
      'sqlite3',
      [
        '-separator',
        '|',
        copiedDb,
        'SELECT host_key, hex(encrypted_value), value FROM cookies ' +
          "WHERE name='li_at' AND host_key LIKE '%linkedin.com' " +
          'ORDER BY expires_utc DESC LIMIT 1;',
      ],
      { encoding: 'utf8' },
    )
      .trim()
      .split('|');

    if (row.length < 3 || !row[0]) throw new Error('Arc Profile 1 has no LinkedIn li_at cookie');
    if (row[2]) return row[2];

    const password = execFileSync(
      'security',
      ['find-generic-password', '-s', 'Arc Safe Storage', '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const encrypted = Buffer.from(row[1], 'hex');
    if (encrypted.subarray(0, 3).toString('utf8') !== 'v10') {
      throw new Error('Arc LinkedIn cookie is not Chromium v10 encrypted');
    }

    const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    let plaintext = Buffer.concat([
      decipher.update(encrypted.subarray(3)),
      decipher.final(),
    ]);
    const hostDigest = createHash('sha256').update(row[0]).digest();
    if (plaintext.subarray(0, 32).equals(hostDigest)) plaintext = plaintext.subarray(32);

    const cookie = plaintext.toString('utf8');
    if (!cookie.startsWith('AQ')) {
      throw new Error('Arc li_at decryption did not produce a valid LinkedIn session cookie');
    }
    return cookie;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const pending = `${path}.pending`;
  writeFileSync(pending, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(pending, path);
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function atomicWriteCsv(path, applicants, jobId, jobTitle) {
  const headers = [
    'pipeline',
    'pipeline_stage',
    'job_title',
    'source',
    'source_job_id',
    'source_application_id',
    'name',
    'email',
    'phone',
    'school',
    'location',
    'school_location',
    'application_status',
    'linkedin_profile_url',
    'resume_file',
    'resume_filename',
  ];
  const rows = applicants.map((applicant) => [
    'Intern Applicants',
    applicant.application_status.replace(/\s+\d+\w*\s+ago$/i, ''),
    jobTitle,
    'LinkedIn',
    jobId,
    applicant.application_id,
    applicant.name,
    applicant.email,
    applicant.phone,
    applicant.school,
    applicant.location,
    applicant.school_location,
    applicant.application_status,
    applicant.linkedin_profile_url,
    applicant.resume_file,
    applicant.resume_filename,
  ]);
  mkdirSync(dirname(path), { recursive: true });
  const pending = `${path}.pending`;
  writeFileSync(
    pending,
    `${[headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}\n`,
    { mode: 0o600 },
  );
  renameSync(pending, path);
}

async function extractCandidateCards(page, jobId) {
  const candidates = await page
    .locator(`a[href*="applicationId="][href*="jobId=${jobId}"]`)
    .evaluateAll((anchors) =>
      anchors.map((anchor) => ({
        href: anchor.href,
        text: (anchor.innerText || '').trim(),
      })),
    );

  const byId = new Map();
  for (const candidate of candidates) {
    const applicationId = new URL(candidate.href).searchParams.get('applicationId');
    const lines = candidate.text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (!applicationId || lines.length < 3 || byId.has(applicationId)) continue;

    const meaningful = lines.filter(
      (line) =>
        !/^·?\s*\d+(?:st|nd|rd|th)$/i.test(line) &&
        !/^\d+\/\d+$/.test(line) &&
        !/^(must-have|preferred)$/i.test(line),
    );
    if (meaningful.length < 3) continue;
    byId.set(applicationId, {
      applicationId,
      name: meaningful[0],
      school: meaningful[1],
      location: meaningful[2],
    });
  }
  return [...byId.values()];
}

async function selectApplicant(page, applicant, delayMs) {
  const card = page
    .locator(`a[href*="applicationId=${applicant.applicationId}"]`)
    .filter({ hasText: applicant.name })
    .first();
  await card.scrollIntoViewIfNeeded();
  await card.click();
  await page.waitForFunction(
    (applicationId) => new URL(window.location.href).searchParams.get('applicationId') === applicationId,
    applicant.applicationId,
    { timeout: 10_000 },
  );
  await page.waitForFunction(
    ({ name }) => {
      const body = document.body.innerText;
      if (body.split(name).length - 1 < 2) return false;
      let index = body.indexOf(name);
      while (index !== -1) {
        const nearby = body.slice(index, index + 1_500);
        if (/\b(applied|shortlisted|screening|interview|offered|hired|rejected|archived|withdrawn)\b/i.test(nearby)) {
          return true;
        }
        index = body.indexOf(name, index + name.length);
      }
      return false;
    },
    { name: applicant.name },
    { timeout: 10_000 },
  );
  await page.waitForTimeout(Math.min(500, Math.max(200, Math.floor(delayMs / 3))));
}

async function readApplicationStatus(page, applicantName) {
  const body = await page.locator('body').innerText();
  const statuses = [];
  let index = body.indexOf(applicantName);
  while (index !== -1) {
    const statusLine = body
      .slice(index, index + 1_500)
      .split('\n')
      .map((line) => line.trim())
      .find((line) => /^(applied|shortlisted|screening|interview|offered|hired|rejected|archived|withdrawn)\b/i.test(line));
    if (statusLine) statuses.push(statusLine);
    index = body.indexOf(applicantName, index + applicantName.length);
  }
  return statuses.at(-1) || 'Unknown';
}

async function readContactInfo(page, delayMs) {
  await page.getByRole('button', { name: 'Contact', exact: true }).click();
  await page.waitForTimeout(500);

  const overlays = page
    .locator('[role="dialog"], [role="menu"], [role="listbox"]')
    .filter({ hasText: 'Mark as contacted' });
  const overlay = overlays.last();
  const overlayText = (await overlays.count())
    ? await overlay.innerText()
    : (await page.locator('body').innerText()).slice(-1200);

  const mailLinks = page.locator('a[href^="mailto:"]:visible');
  const email = (await mailLinks.count())
    ? decodeURIComponent((await mailLinks.last().getAttribute('href')).slice('mailto:'.length))
        .split('?')[0]
        .trim()
        .toLowerCase()
    : overlayText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() || null;
  const phone = normalizePhone(
    overlayText.match(/\+\d[\d\s().-]{5,}\d/)?.[0] || null,
  );

  await page.keyboard.press('Escape');
  await page.waitForTimeout(delayMs);
  return { email, phone };
}

function filenameFromContentDisposition(value) {
  if (!value) return null;
  const encoded = value.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return basename(decodeURIComponent(encoded.trim().replace(/^"|"$/g, '')));
    } catch {
      // Fall through to the plain filename parameter.
    }
  }
  const plain = value.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
  return plain ? basename((plain[1] || plain[2]).trim()) : null;
}

function extensionForResume(contentType, ...filenames) {
  const normalizedType = String(contentType || '').split(';')[0].trim().toLowerCase();
  const extensionsByType = {
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/rtf': 'rtf',
    'application/vnd.oasis.opendocument.text': 'odt',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'text/plain': 'txt',
  };
  if (extensionsByType[normalizedType]) return extensionsByType[normalizedType];
  const genericDownloadTypes = [
    'application/octet-stream',
    'application/download',
    'application/force-download',
    'application/x-download',
  ];
  if (
    normalizedType &&
    !genericDownloadTypes.includes(normalizedType)
  ) {
    return null;
  }

  for (const filename of filenames) {
    const extension = extname(String(filename || '')).slice(1).toLowerCase();
    if (/^(?:pdf|docx?|rtf|odt|txt)$/.test(extension)) return extension;
  }
  return null;
}

async function findResumeLinks(page) {
  const links = await page.locator('a[href]:visible').evaluateAll((anchors) =>
    anchors.map((anchor) => {
      let context = '';
      let container = anchor.parentElement;
      for (let depth = 0; container && depth < 7; depth += 1) {
        const text = (container.innerText || '').trim();
        if (/\bresume\b/i.test(text) && text.length <= 1_500) {
          context = text;
          break;
        }
        container = container.parentElement;
      }
      return {
        href: anchor.href,
        text: (anchor.innerText || '').trim(),
        ariaLabel: anchor.getAttribute('aria-label') || '',
        title: anchor.getAttribute('title') || '',
        download: anchor.getAttribute('download') || '',
        context,
        inResumeModule: Boolean(context),
      };
    }),
  );

  const ranked = links
    .map((link) => {
      const label = `${link.text} ${link.ariaLabel} ${link.title} ${link.download}`;
      const href = link.href.toLowerCase();
      const explicitResume = /\bresume\b/i.test(label);
      const resumeModule = link.inResumeModule;
      if (!explicitResume && !resumeModule) return { link, score: -1 };

      const downloadAction = /\b(download|view|open)\b/i.test(label);
      const fileExtension = /\.(?:pdf|docx?|rtf|odt|txt)(?:$|[?#])/i.test(link.href);
      const documentEndpoint = /(?:ambry|media|document|download|resume)/i.test(href);
      const hasDownloadSignal =
        explicitResume || downloadAction || link.download || fileExtension || documentEndpoint;
      if (resumeModule && !hasDownloadSignal) {
        return { link, score: -1 };
      }

      let score = resumeModule ? 100 : 0;
      if (explicitResume) score += 60;
      if (downloadAction) score += 30;
      if (link.download) score += 20;
      if (fileExtension) score += 20;
      if (documentEndpoint) score += 10;
      return { link, score };
    })
    .filter(({ score }) => score >= 60)
    .sort((a, b) => b.score - a.score);

  const seen = new Set();
  return ranked
    .map(({ link }) => link)
    .filter((link) => {
      if (seen.has(link.href)) return false;
      seen.add(link.href);
      return true;
    });
}

async function downloadApplicantResume(page, applicationId, outputPath) {
  const links = await findResumeLinks(page);
  if (!links.length) return null;
  if (!/^\d+$/.test(applicationId)) throw new Error('invalid application id for resume path');

  const failures = [];
  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];
    try {
      const response = await page.request.get(link.href, {
        failOnStatusCode: false,
        headers: { referer: page.url() },
        timeout: 30_000,
      });
      if (!response.ok()) {
        throw new Error(`HTTP ${response.status()}`);
      }

      const headers = response.headers();
      const contentType = headers['content-type'] || '';
      const dispositionName = filenameFromContentDisposition(headers['content-disposition']);
      const urlName = basename(new URL(link.href).pathname);
      const linkName = [link.download, link.text, link.ariaLabel, link.title]
        .map((value) => basename(String(value || '').trim()))
        .find((value) => extname(value));
      const extension = extensionForResume(contentType, dispositionName, linkName, urlName);
      if (!extension) {
        throw new Error(`unsupported content type ${contentType || 'unknown'}`);
      }

      const body = await response.body();
      if (!body.length) throw new Error('empty response');

      const originalName = dispositionName || linkName || (extname(urlName) ? urlName : null);
      const resumesDir = resolve(dirname(outputPath), 'resumes');
      const resumePath = join(resumesDir, `${applicationId}.${extension}`);
      const pending = `${resumePath}.pending`;

      mkdirSync(resumesDir, { recursive: true });
      try {
        writeFileSync(pending, body, { mode: 0o600 });
        renameSync(pending, resumePath);
      } finally {
        rmSync(pending, { force: true });
      }

      return {
        file: resumePath,
        filename: originalName || `resume.${extension}`,
      };
    } catch (error) {
      failures.push(`candidate ${index + 1}: ${error.message || String(error)}`);
    }
  }

  throw new Error(`no valid resume response (${failures.join('; ')})`);
}

async function goToNextPage(page, currentIds) {
  const next = page.getByRole('button', { name: 'Next', exact: true });
  if (!(await next.count()) || (await next.isDisabled())) return false;
  await next.click();
  await page.waitForFunction(
    (ids) => {
      const current = [...document.querySelectorAll('a[href*="applicationId="]')]
        .map((anchor) => new URL(anchor.href).searchParams.get('applicationId'))
        .filter(Boolean);
      return current.some((id) => !ids.includes(id));
    },
    currentIds,
    { timeout: 15_000 },
  );
  await page.waitForTimeout(600);
  return true;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let priorApplicants = [];
  if (existsSync(options.output)) {
    const parsed = JSON.parse(readFileSync(options.output, 'utf8'));
    if (Array.isArray(parsed)) priorApplicants = parsed;
  }
  const priorById = new Map(
    priorApplicants.map((applicant) => [applicant.application_id, applicant]),
  );
  const { chromium } = loadPlaywright();
  const liAt = readArcLinkedInCookie(options.arcProfile);
  if (!existsSync(options.chromium)) {
    throw new Error(`Chromium executable not found: ${options.chromium}`);
  }

  const browser = await chromium.launch({
    headless: !options.headed,
    executablePath: options.chromium,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      locale: 'en-US',
    });
    await context.addCookies([
      {
        name: 'li_at',
        value: liAt,
        domain: '.linkedin.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'None',
      },
    ]);

    const page = await context.newPage();
    await page.goto(
      `${LINKEDIN_ORIGIN}/hiring/applicants/?rating=ALL&jobId=${options.jobId}`,
      { waitUntil: 'domcontentloaded', timeout: 60_000 },
    );
    await page.waitForTimeout(3_000);
    if (!page.url().includes('/hiring/applicants/')) {
      throw new Error(`LinkedIn authentication failed; redirected to ${page.url()}`);
    }
    const initialLines = (await page.locator('body').innerText())
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const hiringPlanIndex = initialLines.indexOf('Hiring plan');
    const jobTitle = hiringPlanIndex > 0 ? initialLines[hiringPlanIndex - 1] : `LinkedIn job ${options.jobId}`;

    const applicants = [];
    const seen = new Set();
    let pageNumber = 1;
    while (pageNumber <= 100) {
      const cards = await extractCandidateCards(page, options.jobId);
      if (!cards.length) throw new Error(`No applicant cards found on page ${pageNumber}`);

      for (const card of cards) {
        if (seen.has(card.applicationId)) continue;
        await selectApplicant(page, card, options.delayMs);
        const applicationStatus = await readApplicationStatus(page, card.name);
        const seeded = JOB_SEEDS[options.jobId]?.[normalizeName(card.name)];
        const prior = priorById.get(card.applicationId);
        const contact = seeded
          ? { email: seeded[0], phone: seeded[1] }
          : prior && !options.refreshContacts
            ? { email: prior.email || null, phone: prior.phone || null }
          : await readContactInfo(page, options.delayMs);

        let resume = null;
        if (options.resumes) {
          try {
            resume = await downloadApplicantResume(page, card.applicationId, options.output);
          } catch (error) {
            console.error(
              `Resume download failed for application ${card.applicationId}: ` +
                (error.message || String(error)),
            );
          }
        }

        const profileLinks = page.locator('a[href*="/in/"]:visible');
        const profileUrl = (await profileLinks.count())
          ? (await profileLinks.last().getAttribute('href'))?.split('?')[0] || null
          : null;
        const applicant = {
          name: card.name,
          email: contact.email,
          phone: contact.phone,
          school_location: `${card.school} | ${card.location}`,
          application_status: applicationStatus,
          application_id: card.applicationId,
          school: card.school,
          location: card.location,
          linkedin_profile_url: profileUrl,
          resume_file: resume?.file || null,
          resume_filename: resume?.filename || null,
        };
        applicants.push(applicant);
        seen.add(card.applicationId);
        atomicWriteJson(options.output, applicants);
        atomicWriteCsv(options.csv, applicants, options.jobId, jobTitle);
        console.log(
          `[${applicants.length}] ${applicant.name}: ` +
            `${applicant.email ? 'email' : 'no email'}, ${applicant.phone ? 'phone' : 'no phone'}, ` +
            applicant.application_status,
        );
      }

      const moved = await goToNextPage(
        page,
        cards.map((card) => card.applicationId),
      );
      if (!moved) break;
      pageNumber += 1;
    }

    atomicWriteJson(options.output, applicants);
    atomicWriteCsv(options.csv, applicants, options.jobId, jobTitle);
    const withBoth = applicants.filter((applicant) => applicant.email && applicant.phone).length;
    console.log(`OUTPUT ${options.output}`);
    console.log(`TOTAL ${applicants.length}`);
    console.log(`EMAIL_AND_PHONE ${withBoth}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
