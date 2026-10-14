import express from 'express';
import path from 'node:path';
import * as security from './security.js';
import { initDb, listCovers, imageExists, addCover, findDuplicate } from './db.js';

const port = Number(process.env.PORT) || 3000;

// ---------- validation ----------

function text(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

// ---------- app ----------

const app = express();
app.disable('x-powered-by');

// If the site runs behind a proxy (Nginx, Render, Railway, Cloudflare...),
// start it with TRUST_PROXY=1 to get the visitor's real IP. Otherwise
// everyone shares the proxy's IP and a single ban would block the whole site.
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
}

// Order matters: block banned IPs first, then bots, then apply rate limits.
app.use(security.securityHeaders);
app.use(security.blockBanned);
app.use(security.trapScanners);
app.use(security.rateLimit);
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(import.meta.dirname, 'public')));

app.get('/api/covers', async (req, res) => {
  try {
    res.json(await listCovers());
  } catch (err) {
    console.error('listCovers failed:', err);
    res.status(500).json({ error: "Couldn't load the covers." });
  }
});

app.post('/api/covers', security.guardNewCover, async (req, res) => {
  const body = req.body ?? {};
  const imageUrl = text(body.imageUrl, 2000);
  const title = text(body.title, 200);
  const artist = text(body.artist, 200);
  const releaseDate = text(body.releaseDate, 10);
  const notes = text(body.notes, 1000);

  if (!isHttpUrl(imageUrl)) {
    return res.status(400).json({ error: 'The image link must start with http:// or https://.' });
  }
  if (!title || !artist) {
    return res.status(400).json({ error: 'Album title and artist are required.' });
  }
  if (body.confirmed !== 'on') {
    return res.status(400).json({ error: 'Confirm that the details are accurate before adding the cover.' });
  }
  if (releaseDate && !isValidDate(releaseDate)) {
    return res.status(400).json({ error: 'Release date must be a valid date.' });
  }

  try {
    if (await imageExists(imageUrl)) {
      return res.status(409).json({ error: 'This image is already on the wall.' });
    }

    // Check for an existing album by normalized artist + title.
    const dup = await findDuplicate(artist, title);
    if (dup?.match === 'exact') {
      return res.status(409).json({
        error: `"${dup.cover.title}" by ${dup.cover.artist} is already on the wall.`,
      });
    }
    // Similar but not identical: ask the user to confirm, unless they already did.
    if (dup?.match === 'similar' && body.allowSimilar !== 'on') {
      return res.status(409).json({
        needsConfirmation: true,
        similarTo: { title: dup.cover.title, artist: dup.cover.artist },
        error: `This looks a lot like "${dup.cover.title}" by ${dup.cover.artist}. Add it anyway only if it's a different release.`,
      });
    }

    const cover = await addCover({
      imageUrl,
      title,
      artist,
      releaseDate: releaseDate || null,
      notes,
    });
    res.status(201).json(cover);
  } catch (err) {
    // A race could still hit the UNIQUE constraint; report it cleanly.
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This image is already on the wall.' });
    }
    console.error('addCover failed:', err);
    res.status(500).json({ error: "The cover wasn't added. Try again." });
  }
});

app.use(security.handleBadRequests);

await Promise.all([initDb(), security.loadBans()]);
app.listen(port, () => {
  console.log(`Album covers running at http://localhost:${port}`);
});
