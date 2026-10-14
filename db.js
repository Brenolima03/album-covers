import pg from 'pg';

// Supabase gives you this connection string. Put it in an env var named
// DATABASE_URL (locally in a .env file, on Render in the dashboard).
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('DATABASE_URL is not set. Copy it from Supabase > Project Settings > Database.');
  process.exit(1);
}

// Supabase requires SSL. The pooler cert isn't in Node's trust store, so we
// accept it without strict verification, which is standard for Supabase.
const pool = new pg.Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

// Create the table on startup if it doesn't exist yet.
export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS covers (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      image_url    TEXT NOT NULL UNIQUE,
      title        TEXT NOT NULL,
      artist       TEXT NOT NULL,
      release_date DATE,
      notes        TEXT NOT NULL DEFAULT '',
      signature    TEXT NOT NULL DEFAULT '',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Add the column if the table already existed from before this feature.
  await pool.query(`ALTER TABLE covers ADD COLUMN IF NOT EXISTS signature TEXT NOT NULL DEFAULT ''`);
  await pool.query(`CREATE INDEX IF NOT EXISTS covers_signature_idx ON covers (signature)`);
  // Backfill signatures for any rows added before this feature existed.
  const { rows } = await pool.query(`SELECT id, title, artist FROM covers WHERE signature = ''`);
  for (const r of rows) {
    await pool.query('UPDATE covers SET signature = $1 WHERE id = $2', [
      signatureOf(r.artist, r.title),
      r.id,
    ]);
  }
}

// ---------- normalization ----------

// Build a comparable "signature" from artist + title. Lowercase, strip accents
// and punctuation, collapse spaces, drop a few leading noise words. Words like
// "deluxe", "live" and "remastered" are KEPT on purpose, so those count as
// different releases rather than duplicates.
const NOISE_WORDS = new Set(['the', 'a', 'an', 'o', 'os', 'as', 'um', 'uma']);

export function normalize(value) {
  return (value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')      // remove accents
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')          // punctuation -> space
    .trim()
    .split(' ')
    .filter((w) => w && !NOISE_WORDS.has(w))
    .join(' ');
}

export function signatureOf(artist, title) {
  return `${normalize(artist)}|${normalize(title)}`;
}

// Levenshtein distance, used to catch near-misses (typos) for the warning.
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

// Two signatures are "similar" if they're a small number of edits apart,
// scaled to length so short names aren't over-matched.
function isSimilar(a, b) {
  if (a === b) return true;
  const dist = editDistance(a, b);
  const threshold = Math.max(1, Math.floor(Math.max(a.length, b.length) * 0.15));
  return dist <= threshold;
}

// ---------- queries ----------

function toCover(row) {
  return {
    id: row.id,
    imageUrl: row.image_url,
    title: row.title,
    artist: row.artist,
    releaseDate: row.release_date
      ? row.release_date.toISOString().slice(0, 10)
      : null,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listCovers() {
  const { rows } = await pool.query(
    'SELECT * FROM covers ORDER BY created_at DESC'
  );
  return rows.map(toCover);
}

export async function imageExists(imageUrl) {
  const { rowCount } = await pool.query(
    'SELECT 1 FROM covers WHERE image_url = $1',
    [imageUrl]
  );
  return rowCount > 0;
}

// Returns { match: 'exact' | 'similar', cover } or null.
// 'exact'   -> same normalized artist + title: refuse the post.
// 'similar' -> close but not identical: warn and let the user confirm.
export async function findDuplicate(artist, title) {
  const sig = signatureOf(artist, title);

  // Exact signature match: one indexed lookup.
  const exact = await pool.query(
    'SELECT * FROM covers WHERE signature = $1 LIMIT 1',
    [sig]
  );
  if (exact.rowCount > 0) {
    return { match: 'exact', cover: toCover(exact.rows[0]) };
  }

  // Similar match: compare against existing signatures for typos / variants.
  const all = await pool.query('SELECT * FROM covers');
  for (const row of all.rows) {
    if (isSimilar(sig, row.signature)) {
      return { match: 'similar', cover: toCover(row) };
    }
  }
  return null;
}

export async function addCover({ imageUrl, title, artist, releaseDate, notes }) {
  const { rows } = await pool.query(
    `INSERT INTO covers (image_url, title, artist, release_date, notes, signature)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [imageUrl, title, artist, releaseDate, notes, signatureOf(artist, title)]
  );
  return toCover(rows[0]);
}
