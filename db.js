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
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

// Turn a database row into the shape the frontend expects.
function toCover(row) {
  return {
    id: row.id,
    imageUrl: row.image_url,
    title: row.title,
    artist: row.artist,
    // release_date comes back as a Date; keep just YYYY-MM-DD, or null.
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

// $1, $2... are parameters: the values never become part of the SQL text,
// so there's no way to inject SQL through them.
export async function addCover({ imageUrl, title, artist, releaseDate, notes }) {
  const { rows } = await pool.query(
    `INSERT INTO covers (image_url, title, artist, release_date, notes)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [imageUrl, title, artist, releaseDate, notes]
  );
  return toCover(rows[0]);
}
