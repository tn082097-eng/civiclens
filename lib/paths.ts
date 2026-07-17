/**
 * Location-independent path roots for CivicLens.
 *
 * Every absolute path the project uses is derived here from the location of
 * this file, so the repo can live anywhere (it was relocated out of the Hermes
 * app dir; see the relocation plan). Nothing in here reads $HOME or hard-codes
 * an install location — `ROOT` is computed from `import.meta.url`.
 *
 *   lib/paths.ts  →  ROOT is one directory up from lib/.
 *
 * Run directly to print every resolved path:
 *   npx tsx lib/paths.ts
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

/** Repo root — the directory containing package.json, agents/, db/, lib/, render/. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ─── Generated / runtime data (Phase 3: consolidated under data/) ───────────
export const DATA_DIR  = join(ROOT, 'data');
export const CACHE_DIR = join(DATA_DIR, 'caches');

export const DB_PATH           = join(DATA_DIR, 'civiclens.duckdb');
export const PFD_CACHE         = join(CACHE_DIR, 'pfd-cache');
export const SENATE_CACHE      = join(CACHE_DIR, 'senate-ptr-cache');
export const LEGISLATORS_CACHE = join(CACHE_DIR, 'legislators-cache');
/** OpenSecrets responses are cached under the PFD cache root. */
export const OPENSECRETS_CACHE = join(PFD_CACHE, 'opensecrets');
export const USASPENDING_CACHE = join(CACHE_DIR, 'usaspending-cache');

// ─── Repo-relative working dirs (unchanged by the data/ move) ───────────────
export const PIPE_DIR   = join(ROOT, 'pipeline');
export const SKILLS_DIR = join(ROOT, 'skills');
export const SITE_DIR   = join(ROOT, 'site');
export const NAMES_PATH = join(ROOT, 'names.txt');

// ─── Secrets (Phase 3c: dedicated repo-local .env, was ~/.hermes/.env) ──────
export const ENV_PATH = join(ROOT, '.env');

// When run directly, print every resolved path for verification.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const entries: Record<string, string> = {
    ROOT, DATA_DIR, CACHE_DIR, DB_PATH, PFD_CACHE, SENATE_CACHE,
    LEGISLATORS_CACHE, OPENSECRETS_CACHE, USASPENDING_CACHE, PIPE_DIR, SKILLS_DIR,
    SITE_DIR, NAMES_PATH, ENV_PATH,
  };
  for (const [k, v] of Object.entries(entries)) console.log(`${k.padEnd(18)} ${v}`);
}
