import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.PPROXY_HOME || path.join(os.homedir(), '.pproxy');
export const PATHS = {
    accounts: path.join(HOME, 'accounts.json'),
    settings: path.join(HOME, 'settings.json'),
    pid: path.join(HOME, 'pproxy.pid'),
    log: path.join(HOME, 'pproxy.log'),
};

export const DEFAULT_SETTINGS = {
    host: '127.0.0.1',
    port: 9032,
    strategy: 'round-robin',
    failover: true,
    apiKey: null,
    masterKey: null,
    defaultModel: 'gpt-5.4-nano',
    modelMap: {},
    usageRefreshSec: 300,
};

export function ensureHome () {
    fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
}

function readJson (file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        if (e.code === 'ENOENT') return fallback;
        throw new Error(`could not read ${file}: ${e.message}`);
    }
}

function writeJson (file, data) {
    ensureHome();
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
}

export function loadSettings () {
    return { ...DEFAULT_SETTINGS, ...readJson(PATHS.settings, {}) };
}

export function saveSettings (settings) {
    writeJson(PATHS.settings, settings);
}

export function loadAccounts () {
    return readJson(PATHS.accounts, []);
}

export function saveAccounts (accounts) {
    writeJson(PATHS.accounts, accounts);
}
