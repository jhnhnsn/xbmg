import { homedir } from 'node:os';
import { join } from 'node:path';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

function configDir() {
  if (process.env.XBMG_HOME) return process.env.XBMG_HOME;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'xbmediagrabber');
}

export function sessionPath() {
  return join(configDir(), 'session.json');
}

export async function loadSession() {
  try {
    return JSON.parse(await readFile(sessionPath(), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveSession(session) {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  const file = sessionPath();
  await writeFile(file, JSON.stringify(session, null, 2), { mode: 0o600 });
  await chmod(file, 0o600);
}

export async function clearSession() {
  await rm(sessionPath(), { force: true });
}
