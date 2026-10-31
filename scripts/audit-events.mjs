// Events Rust emits and the page listens for, but the bridge never forwards.
//
//   node scripts/audit-events.mjs
//
// `src/lib/bridge.ts` forwards native events to the page from a fixed list. An
// event that is emitted, listened for and not on the list simply never arrives in
// the real app - while the simulator, which emits straight onto the page's bus,
// shows everything working. Exits 1 if any are found.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const RUST = path.join(ROOT, 'src-tauri', 'src');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const listened = new Map();
for (const file of walk(SRC)) {
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\bon\(\s*'([a-z]+:[a-z:_-]+)'/g)) {
    if (!listened.has(m[1])) listened.set(m[1], []);
    listened.get(m[1]).push(path.relative(SRC, file));
  }
}

const bridge = fs.readFileSync(path.join(SRC, 'lib', 'bridge.ts'), 'utf8');
const from = bridge.indexOf('const events = [');
const to = bridge.indexOf('];', from);
const forwarded = new Set([...bridge.slice(from, to).matchAll(/'([a-z]+:[a-z:_-]+)'/g)].map((m) => m[1]));

const rust = fs
  .readdirSync(RUST)
  .filter((f) => f.endsWith('.rs'))
  .map((f) => fs.readFileSync(path.join(RUST, f), 'utf8'))
  .join('\n');
const emitted = new Set([...rust.matchAll(/emit\(\s*"([a-z]+:[a-z:_-]+)"/g)].map((m) => m[1]));
// Envelope kinds are turned into event names by a table in signaling.rs.
for (const m of rust.matchAll(/=> "([a-z]+:[a-z:_-]+)"/g)) emitted.add(m[1]);

const missing = [...listened.keys()].filter((e) => !forwarded.has(e) && emitted.has(e));
console.log(`forwarded ${forwarded.size} | listened for ${listened.size} | emitted by Rust ${emitted.size}`);
if (missing.length) {
  console.log('Listened for and emitted, but never forwarded:');
  for (const e of missing) console.log(`  ${e}   (${listened.get(e)[0]})`);
  process.exit(1);
}
console.log('Every event the page listens for and Rust emits is forwarded.');
