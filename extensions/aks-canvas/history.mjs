import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = join(process.env.COPILOT_HOME || join(homedir(), '.copilot'), 'extension-data', 'pixelrobots-aks-troubleshooting');

export function createHistory(directory = root) {
  return {
    async save(context, namespace, findings) {
      if (!context || !namespace || !Array.isArray(findings) || !findings.length) throw new Error('Select a context and namespace and add a finding before saving.');
      const record = { format: 'pixelrobots-aks-investigation', version: 1, id: randomUUID(), savedAt: new Date().toISOString(), context, namespace, findings };
      await mkdir(directory, { recursive: true });
      const destination = join(directory, `${record.id}.json`);
      const temporary = join(directory, `.${record.id}.${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temporary, destination);
      return record;
    },
    async list() {
      let names;
      try {
        names = await readdir(directory);
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
      const records = [];
      for (const name of names.filter(n => /^[0-9a-f-]{36}\.json$/.test(n))) {
        const record = JSON.parse(await readFile(join(directory, name), 'utf8'));
        if (record.format !== 'pixelrobots-aks-investigation' || record.version !== 1 || record.id !== name.slice(0, -5) || typeof record.savedAt !== 'string' || typeof record.context !== 'string' || typeof record.namespace !== 'string' || !Array.isArray(record.findings) || !record.findings.every(x => typeof x === 'string')) {
          throw new Error(`Invalid investigation record: ${name}`);
        }
        records.push(record);
      }
      return records.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    }
  };
}
