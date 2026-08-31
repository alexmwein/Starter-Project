import { execFile as nodeExecFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

export const SAFE_IMESSAGE_PATH = `${os.homedir()}/.local/bin/safe-imessage`;

const defaultExecFile = promisify(nodeExecFile);

export async function deliverNotifications(
  notifications,
  { execFile = defaultExecFile } = {},
) {
  for (const notification of notifications) {
    await execFile(
      SAFE_IMESSAGE_PATH,
      ['--recipient', 'alex', '--message', notification.message],
      { timeout: 30_000 },
    );
  }
}
