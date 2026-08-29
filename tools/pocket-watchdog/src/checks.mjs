const GB = 1024 ** 3;
const DAY = 24 * 60 * 60 * 1000;

export const DISK_WARN_BYTES = 25 * GB;
export const DISK_CRITICAL_BYTES = 10 * GB;
export const SESSION_WARN_MS = 5 * DAY;
export const COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const LOAD_WARN = 25;

function roundedGb(bytes) {
  return Math.max(0, Math.floor(bytes / GB));
}

function issue(id, severity, check, message, recovery) {
  return Object.freeze({ id, severity, check, message, recovery });
}

function status(check, ok, detail) {
  return Object.freeze({ check, ok, detail });
}

function relayIssues(snapshot, issues, statuses) {
  const relay = snapshot.relay || {};
  const loopbackOk = relay.loopback?.ok === true;
  statuses.push(status('Relay loopback health', loopbackOk, loopbackOk ? 'healthy' : 'unreachable or unhealthy'));
  if (!loopbackOk) {
    issues.push(issue(
      'relay:loopback',
      'critical',
      'Relay loopback health',
      'Pocket: the local relay is down. Run npm run install:relay from tools/conductor-pocket, then npm run verify:live.',
      'Pocket recovered: the local relay is healthy again.',
    ));
  }

  const revisionOk =
    loopbackOk &&
    typeof relay.installedShellRevision === 'string' &&
    relay.installedShellRevision.length > 0 &&
    relay.loopback.shellRevision === relay.installedShellRevision;
  statuses.push(status('Served shell revision', revisionOk, revisionOk ? relay.installedShellRevision : 'served and installed revisions differ'));
  if (!revisionOk) {
    issues.push(issue(
      'relay:revision',
      'warn',
      'Served shell revision',
      'Pocket: the relay is serving the wrong phone shell. Reinstall the relay, then run npm run verify:live.',
      'Pocket recovered: the relay is serving the installed phone shell again.',
    ));
  }

  const tailnetOk = relay.tailnetStatus === 200;
  statuses.push(status('Tailnet origin', tailnetOk, `HTTP ${relay.tailnetStatus ?? 'unreachable'}`));
  if (!tailnetOk) {
    issues.push(issue(
      'relay:tailnet',
      'critical',
      'Tailnet origin',
      'Pocket: the private Pocket URL is not returning 200. Reconnect the dedicated Tailscale node, then run npm run verify:live.',
      'Pocket recovered: the private Pocket URL returns 200 again.',
    ));
  }

  const launchOk = relay.launchLoaded === true;
  statuses.push(status('Relay LaunchAgent', launchOk, launchOk ? 'loaded' : 'not loaded'));
  if (!launchOk) {
    issues.push(issue(
      'relay:launchd',
      'critical',
      'Relay LaunchAgent',
      'Pocket: the relay LaunchAgent is not loaded. Run npm run install:relay from tools/conductor-pocket.',
      'Pocket recovered: the relay LaunchAgent is loaded again.',
    ));
  }

  const funnelOk = relay.funnelEnabled === false;
  statuses.push(status('Tailscale Funnel', funnelOk, funnelOk ? 'disabled' : 'enabled or unreadable'));
  if (!funnelOk) {
    issues.push(issue(
      'relay:funnel',
      'critical',
      'Tailscale Funnel',
      'Pocket: Tailscale Funnel is enabled or could not be proven disabled. Disable Funnel for the dedicated Pocket node now.',
      'Pocket recovered: Tailscale Funnel is proven disabled again.',
    ));
  }

  const bindingOk = relay.bindHost === '127.0.0.1';
  statuses.push(status('Relay binding', bindingOk, relay.bindHost || 'unknown'));
  if (!bindingOk) {
    issues.push(issue(
      'relay:binding',
      'critical',
      'Relay binding',
      'Pocket: the relay is not bound only to loopback. Set bindHost to 127.0.0.1 and reinstall the relay.',
      'Pocket recovered: the relay is bound only to loopback again.',
    ));
  }
}

function sessionIssues(snapshot, now, issues, statuses) {
  for (const device of snapshot.devices || []) {
    const deadlines = [
      ['trusted grant', Date.parse(device.trustedUntil)],
      ['device session', Date.parse(device.sessionExpiresAt)],
    ].filter(([, deadline]) => Number.isFinite(deadline));
    if (deadlines.length === 0) {
      statuses.push(status(`Session: ${device.name}`, false, 'deadlines missing'));
      issues.push(issue(
        `session:${device.id}`,
        'critical',
        `Session: ${device.name}`,
        `Pocket: ${device.name}'s session deadlines are missing. Open Pocket and unlock with Face ID.`,
        `Pocket recovered: ${device.name}'s session deadlines are healthy again.`,
      ));
      continue;
    }
    deadlines.sort((left, right) => left[1] - right[1]);
    const [deadlineName, deadline] = deadlines[0];
    const remaining = deadline - now;
    const expired = remaining <= 0;
    const warns = remaining <= SESSION_WARN_MS;
    const days = Math.max(0, Math.ceil(remaining / DAY));
    statuses.push(status(
      `Session: ${device.name}`,
      !warns,
      expired ? `${deadlineName} expired` : `${days} days remaining`,
    ));
    if (!warns) continue;
    const message = expired
      ? `Pocket: ${device.name}'s ${deadlineName} expired. Open Pocket and unlock with Face ID.`
      : `Pocket: ${device.name}'s ${deadlineName} expires in ${days} ${days === 1 ? 'day' : 'days'}. Open Pocket and unlock with Face ID.`;
    issues.push(issue(
      `session:${device.id}`,
      expired ? 'critical' : 'warn',
      `Session: ${device.name}`,
      message,
      `Pocket recovered: ${device.name}'s session is healthy again.`,
    ));
  }
}

function sidebarIssues(snapshot, issues, statuses, unresolvedIssuePrefixes) {
  const sidebar = snapshot.sidebar || {};
  if (sidebar.ok !== true) {
    statuses.push(status('Conductor sidebar', false, 'not readable'));
    unresolvedIssuePrefixes.push('sidebar:');
    issues.push(issue(
      'sidebar:unreadable',
      'warn',
      'Conductor sidebar',
      'Pocket: the Conductor sidebar could not be checked. Unlock the Mac, leave Conductor open, then run pocket-doctor.',
      'Pocket recovered: the Conductor sidebar is readable again.',
    ));
    return;
  }
  const projects = new Map(
    (sidebar.projects || []).map((project) => [project.name, project]),
  );
  if ((sidebar.activeRepositories || []).length === 0) {
    statuses.push(status('Conductor sidebar', true, 'readable; no active Pocket workspaces'));
  }
  for (const name of sidebar.activeRepositories || []) {
    const project = projects.get(name);
    const collapsed = project?.collapsed === true;
    const readable = Boolean(project);
    statuses.push(status(`Sidebar: ${name}`, readable && !collapsed, !readable ? 'project row not visible' : collapsed ? 'collapsed' : 'expanded'));
    if (!readable) {
      issues.push(issue(
        `sidebar:missing:${name}`,
        'warn',
        `Sidebar: ${name}`,
        `Pocket: the ${name} project row is missing from Conductor. Open that project in Conductor, then run pocket-doctor.`,
        `Pocket recovered: the ${name} project row is visible in Conductor again.`,
      ));
      continue;
    }
    if (!collapsed) continue;
    issues.push(issue(
      `sidebar:${name}`,
      'warn',
      `Sidebar: ${name}`,
      `Pocket: the ${name} project is collapsed in Conductor. Expand ${name} in the sidebar before sending from Pocket.`,
      `Pocket recovered: the ${name} project is expanded in Conductor again.`,
    ));
  }
}

function codexIssues(snapshot, issues, statuses) {
  if (snapshot.codex?.readable === false) {
    statuses.push(status('Codex seat registry', false, 'not readable'));
    issues.push(issue(
      'codex:registry-unreadable',
      'critical',
      'Codex seat registry',
      'Pocket: the Codex seat registry could not be read. Restore ~/.codex-accounts and ~/.codex-routes, then run pocket-doctor.',
      'Pocket recovered: the Codex seat registry is readable again.',
    ));
    return;
  }
  const vault = new Set(snapshot.codex?.vaultSeats || []);
  const routes = snapshot.codex?.routes || [];
  const duplicates = routes.filter((route) => vault.has(route.name));
  const missing = routes.filter((route) => route.hasAuth !== true);
  statuses.push(status('Codex seat registry', duplicates.length === 0 && missing.length === 0, duplicates.length || missing.length ? `${duplicates.length} duplicate, ${missing.length} missing auth` : 'consistent'));
  for (const route of duplicates) {
    issues.push(issue(
      `codex:duplicate:${route.name}`,
      'critical',
      'Codex seat registry',
      `Pocket: Codex seat ${route.name} exists in both the vault and a managed route. Run codex-acct status, then remove the stale copy only after verifying the active route.`,
      `Pocket recovered: Codex seat ${route.name} no longer exists in both registries.`,
    ));
  }
  for (const route of missing) {
    issues.push(issue(
      `codex:missing-auth:${route.name}`,
      'critical',
      'Codex seat registry',
      `Pocket: Codex route ${route.name} is missing auth.json. Restore its routed authentication before opening Conductor chats.`,
      `Pocket recovered: Codex route ${route.name} has auth.json again.`,
    ));
  }
}

export function evaluateSnapshot(snapshot, now = Date.now()) {
  const issues = [];
  const statuses = [];
  const unresolvedIssuePrefixes = [];
  const free = Number(snapshot.diskFreeBytes);
  const diskOk = Number.isFinite(free) && free >= DISK_WARN_BYTES;
  statuses.push(status('Disk space', diskOk, Number.isFinite(free) ? `${roundedGb(free)} GB free` : 'unreadable'));
  if (!diskOk) {
    const critical = Number.isFinite(free) && free < DISK_CRITICAL_BYTES;
    issues.push(issue(
      'disk:free',
      critical ? 'critical' : 'warn',
      'Disk space',
      `Pocket: this Mac has ${Number.isFinite(free) ? roundedGb(free) : 'unknown'} GB free. Free at least 25 GB before relay or credential files can be corrupted.`,
      'Pocket recovered: this Mac has at least 25 GB free again.',
    ));
  }

  relayIssues(snapshot, issues, statuses);
  sessionIssues(snapshot, now, issues, statuses);
  sidebarIssues(snapshot, issues, statuses, unresolvedIssuePrefixes);
  codexIssues(snapshot, issues, statuses);

  const load = Number(snapshot.load5);
  const loadOk = Number.isFinite(load) && load <= LOAD_WARN;
  statuses.push(status('Mac 5-minute load', loadOk, Number.isFinite(load) ? load.toFixed(1) : 'unreadable'));
  if (!loadOk) {
    issues.push(issue(
      'load:high',
      'warn',
      'Mac 5-minute load',
      `Pocket: the Mac 5-minute load average is ${Number.isFinite(load) ? load.toFixed(1) : 'unreadable'}. Stop runaway image or browser processes before using Pocket.`,
      'Pocket recovered: the Mac 5-minute load average is back at or below 25.',
    ));
  }
  return Object.freeze({ statuses, issues, unresolvedIssuePrefixes });
}

export function planNotifications(
  previousState,
  issues,
  now = Date.now(),
  { unresolvedIssuePrefixes = [] } = {},
) {
  const previous = previousState?.issues || {};
  const current = new Map(issues.map((entry) => [entry.id, entry]));
  const notifications = [];
  const nextIssues = {};
  for (const entry of issues) {
    const old = previous[entry.id];
    if (!old || now - old.lastAlertAt >= COOLDOWN_MS) {
      notifications.push({ type: 'alert', id: entry.id, message: entry.message });
      nextIssues[entry.id] = {
        lastAlertAt: now,
        severity: entry.severity,
        recovery: entry.recovery,
      };
    } else {
      nextIssues[entry.id] = old;
    }
  }
  for (const [id, old] of Object.entries(previous)) {
    if (!current.has(id)) {
      if (unresolvedIssuePrefixes.some((prefix) => id.startsWith(prefix))) {
        nextIssues[id] = old;
        continue;
      }
      notifications.push({ type: 'recovery', id, message: old.recovery });
    }
  }
  return {
    notifications,
    nextState: { version: 1, issues: nextIssues },
  };
}
