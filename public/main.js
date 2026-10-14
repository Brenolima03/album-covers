const grid = document.getElementById("grid");
const count = document.getElementById("count");
const status = document.getElementById("status");
const search = document.getElementById("search");
const sort = document.getElementById("sort");

const dialog = document.getElementById("dialog");
const form = document.getElementById("form");
const preview = document.getElementById("preview");
const formError = document.getElementById("form-error");
const submitButton = document.getElementById("submit");

const details = document.getElementById("details");
const detailsContent = document.getElementById("details-content");

let covers = [];
let formOpenedAt = 0;
let allowSimilar = false; // set true after the user confirms a near-duplicate

// ---------- rendering ----------

// "1999-05-01" -> "01/05/1999"
function formatDate(isoDate) {
  if (!isoDate) return "";
  const [year, month, day] = isoDate.split("-");
  return `${day}/${month}/${year}`;
}

// Everything goes through textContent / element properties, never innerHTML,
// so nobody can inject HTML or scripts through the form.
function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// Image that falls back to a placeholder if the link stops working.
function coverImage(cover, { lazy = false } = {}) {
  const img = el("img", {
    src: cover.imageUrl,
    alt: `${cover.title} by ${cover.artist}`,
    referrerPolicy: "no-referrer",
  });
  if (lazy) img.loading = "lazy";
  img.addEventListener("error", () => {
    img.replaceWith(el("div", { className: "broken", textContent: cover.title }));
  });
  return img;
}

// The grid only shows thumbnails. Details open in a modal on click.
function renderCover(cover) {
  const button = el("button", {
    type: "button",
    className: "thumb",
    title: `${cover.title} by ${cover.artist}`,
  }, [coverImage(cover, { lazy: true })]);
  button.addEventListener("click", () => openDetails(cover));
  return el("li", {}, [button]);
}

// ---------- cover details modal ----------

function openDetails(cover) {
  const info = [
    el("h2", { id: "details-title", textContent: cover.title }),
    el("p", { className: "details-artist", textContent: cover.artist }),
  ];

  const facts = [];
  if (cover.releaseDate) {
    facts.push(el("dt", { textContent: "Released" }), el("dd", { textContent: formatDate(cover.releaseDate) }));
  }
  facts.push(el("dt", { textContent: "Added" }), el("dd", { textContent: formatDate(cover.createdAt.slice(0, 10)) }));
  info.push(el("dl", {}, facts));

  if (cover.notes) {
    info.push(el("p", { className: "details-notes", textContent: cover.notes }));
  }
  if (/^https?:\/\//i.test(cover.imageUrl)) {
    info.push(el("a", {
      href: cover.imageUrl,
      target: "_blank",
      rel: "noopener noreferrer",
      textContent: "Open original image",
    }));
  }

  detailsContent.replaceChildren(
    el("div", { className: "details-image" }, [coverImage(cover)]),
    el("div", { className: "details-info" }, info),
  );
  details.showModal();
}

document.getElementById("details-close").addEventListener("click", () => details.close());

// Clicking the dark area around the modal closes it.
details.addEventListener("click", (event) => {
  if (event.target === details) details.close();
});

// All sorting happens here in the browser, over the list already in memory,
// so changing the sort or typing in search never calls the server.
const comparators = {
  newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
  oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
  artist: (a, b) =>
    a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title),
  album: (a, b) =>
    a.title.localeCompare(b.title) || a.artist.localeCompare(b.artist),
  // Covers without a release date go last.
  release_newest: (a, b) =>
    (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "") ||
    b.createdAt.localeCompare(a.createdAt),
  release_oldest: (a, b) =>
    (a.releaseDate || "9999").localeCompare(b.releaseDate || "9999") ||
    b.createdAt.localeCompare(a.createdAt),
};

function render() {
  const query = search.value.trim().toLowerCase();
  const compare = comparators[sort.value] ?? comparators.newest;

  const visible = covers
    .filter((c) =>
      query ? `${c.title} ${c.artist}`.toLowerCase().includes(query) : true
    )
    .sort(compare);

  grid.replaceChildren(...visible.map(renderCover));
  count.textContent = covers.length === 1 ? "1 cover" : `${covers.length} covers`;

  if (covers.length === 0) {
    status.textContent = "No covers yet. Add the first one.";
  } else if (visible.length === 0) {
    status.textContent = `Nothing matches "${search.value.trim()}".`;
  } else {
    status.textContent = "";
  }
}

// ---------- local cache ----------

const CACHE_KEY = "album-covers:list";

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null; // storage disabled or corrupted; just skip the cache
  }
}

function writeCache(list) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(list));
  } catch {
    // ignore (private mode, quota exceeded, etc.)
  }
}

async function loadCovers() {
  // Show the cached list instantly so the page isn't blank while we fetch.
  const cached = readCache();
  if (cached?.length) {
    covers = cached;
    render();
  } else {
    status.textContent = "Loading covers…";
  }

  // Then refresh from the server and update only if something changed.
  try {
    const res = await fetch("/api/covers");
    if (!res.ok) throw new Error();
    const fresh = await res.json();
    if (JSON.stringify(fresh) !== JSON.stringify(covers)) {
      covers = fresh;
      writeCache(fresh);
      render();
    }
  } catch {
    if (!covers.length) {
      status.textContent = "Couldn't load the covers. Check your connection and refresh.";
    }
  }
}

search.addEventListener("input", render);
sort.addEventListener("change", render);

// ---------- add-a-cover dialog ----------

function resetConfirm() {
  allowSimilar = false;
  submitButton.textContent = "Add cover";
}

document.getElementById("open-form").addEventListener("click", () => {
  form.reset();
  formError.textContent = "";
  showPreview("");
  resetConfirm();
  formOpenedAt = Date.now();
  dialog.showModal();
});

// If the album or artist changes after a warning, it may be a different album,
// so drop the "add anyway" state and re-check on the next submit.
form.elements.title.addEventListener("input", resetConfirm);
form.elements.artist.addEventListener("input", resetConfirm);

document.getElementById("cancel").addEventListener("click", () => dialog.close());

// Clicking the dark area around the modal closes it.
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});

function showPreview(url) {
  if (!/^https?:\/\//i.test(url)) {
    preview.replaceChildren(el("span", { textContent: "Paste an image link to see it here" }));
    return;
  }
  const img = el("img", { src: url, alt: "Preview", referrerPolicy: "no-referrer" });
  img.addEventListener("error", () => {
    preview.replaceChildren(el("span", { textContent: "This link doesn't load as an image" }));
  });
  preview.replaceChildren(img);
}

form.elements.imageUrl.addEventListener("input", (e) => showPreview(e.target.value.trim()));

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  formError.textContent = "";

  const data = Object.fromEntries(new FormData(form));
  if (!data.imageUrl || !data.title || !data.artist) {
    formError.textContent = "Fill in the image link, album title and artist.";
    return;
  }
  if (data.confirmed !== "on") {
    formError.textContent = "Confirm that the details are accurate before adding the cover.";
    return;
  }
  data.fillTimeMs = Date.now() - formOpenedAt;
  if (allowSimilar) data.allowSimilar = "on";

  submitButton.disabled = true;
  try {
    const res = await fetch("/api/covers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const body = await res.json();
    if (!res.ok) {
      // A near-duplicate: show the warning and turn the button into a confirm.
      if (body.needsConfirmation) {
        allowSimilar = true;
        formError.textContent = body.error;
        submitButton.textContent = "Add anyway";
        return;
      }
      formError.textContent = body.error ?? "The cover wasn't added. Try again.";
      return;
    }
    covers.unshift(body);
    writeCache(covers);
    search.value = "";
    render();
    dialog.close();
  } catch {
    formError.textContent = "Couldn't reach the server. Check your connection and try again.";
  } finally {
    submitButton.disabled = false;
  }
});

loadCovers();
