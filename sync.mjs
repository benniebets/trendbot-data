// Vergelijkt de repo-data met wat al in de dashboard-database staat en maakt de schrijfopdrachten.
// Gebruik: node sync.mjs <map met database-dump> <uitvoermap>
// De dump-map bevat prices/<SYM>.json, volumes/<SYM>.json en meta/main.json (zoals ArtifactData list/get met out_dir ze wegschrijft).
import fs from 'node:fs';
import path from 'node:path';

const [dumpDir, outDir] = process.argv.slice(2);
if (!dumpDir || !outDir) { console.error('gebruik: node sync.mjs <dump> <uit>'); process.exit(2); }
const here = path.dirname(new URL(import.meta.url).pathname);
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const unwrap = o => (o && o.data && typeof o.data === 'object' && !Array.isArray(o.data) && !('d0' in o) && !('encLen' in o)) ? o.data : o;
const repo = { prices: read(path.join(here, 'data/prices.json')), volumes: read(path.join(here, 'data/volumes.json')), meta: read(path.join(here, 'data/meta.json')) };
const meta = unwrap(read(path.join(dumpDir, 'meta/main.json')));
fs.mkdirSync(outDir, { recursive: true });
const writes = [], summary = { appended: {}, created: [], lastClose: repo.meta.lastClose };
const encLen = meta.encLen || { prices: {}, volumes: {} };
const metaPatch = { spreads: Object.assign({}, meta.spreads || {}, repo.meta.spreads), steps: Object.assign({}, meta.steps || {}, repo.meta.steps), cgIds: Object.assign({}, meta.cgIds || {}, repo.meta.cgIds), coins: [...new Set([...(meta.coins || []), ...Object.keys(repo.prices)])], encLen: { prices: Object.assign({}, encLen.prices), volumes: Object.assign({}, encLen.volumes) } };

for (const kind of ['prices', 'volumes']) {
  const key = kind === 'prices' ? 'c' : 'v';
  for (const [sym, r] of Object.entries(repo[kind])) {
    const f = path.join(dumpDir, kind, sym + '.json');
    const file = path.join(outDir, `${kind}_${sym}.json`);
    if (!fs.existsSync(f)) {                         // nieuwe munt: hele reeks als tail
      const doc = kind === 'prices' ? { sym, d0: r.d0, enc: '', tail: r[key] } : { sym, d0: r.d0, enc: '', scale: 100, tail: r[key] };
      fs.writeFileSync(file, JSON.stringify(doc));
      writes.push({ op: 'set', collection: kind, doc_id: sym, file_path: file });
      metaPatch.encLen[kind][sym] = 0; summary.created.push(kind + '/' + sym);
      continue;
    }
    const d = unwrap(read(f));
    const tail = d.tail || [];
    const next = d.d0 + (encLen[kind][sym] || 0) + tail.length;   // eerste dag die nog ontbreekt
    const from = next - r.d0;
    if (from < 0 || from >= r[key].length) continue;
    const add = r[key].slice(from);
    fs.writeFileSync(file, JSON.stringify({ tail: tail.concat(add) }));
    writes.push({ op: 'update', collection: kind, doc_id: sym, file_path: file });
    summary.appended[kind + '/' + sym] = add.length;
  }
}
const now = new Date();
metaPatch.updatedAt = now.toLocaleString('nl-BE', { timeZone: 'Europe/Brussels', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
metaPatch.spreadsAt = metaPatch.updatedAt;
const mf = path.join(outDir, 'meta_main.json'); fs.writeFileSync(mf, JSON.stringify(metaPatch));
writes.push({ op: 'update', collection: 'meta', doc_id: 'main', file_path: mf });
fs.writeFileSync(path.join(outDir, 'writes.json'), JSON.stringify(writes, null, 1));
console.log(JSON.stringify({ writes: writes.length, ...summary }));
