# ABCDryBASIN — Seminar on Climate Smart Technologies

Event website for the ABCDryBASIN seminar (Bizerte, 14–16 December 2026), built from the
official program PDF, with a full admin panel to manage every piece of content.

- **`/`** — public site: the poster page (headline, highlights, dates, location,
  registration link with auto-generated QR code, partner logos) and the program page
  (logo header, days, sessions, speakers and breaks), styled to match the PDF.
- **`/admin`** — admin dashboard (login required).

## Run it

```bash
npm install
npm start            # http://localhost:3000  ·  admin at http://localhost:3000/admin
```

Default login: **admin / admin123**. The dashboard shows a warning until you change it
under *Account & backup*. To set credentials on first start instead:

```bash
ADMIN_USER=maha ADMIN_PASSWORD='a-strong-password' npm start
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | Where `db.json` and uploaded images are stored |
| `ADMIN_USER` / `ADMIN_PASSWORD` | `admin` / `admin123` | Initial credentials (only used when `db.json` is first created) |

## What the admin can manage

- **Event details** — titles, dates, time, location, registration link, contact email,
  QR code on/off, event logo and poster photo (upload or drag & drop).
- **Program** — add, rename, reorder, duplicate and delete days; add sessions and breaks,
  edit times/titles/speakers, move a session to another day, duplicate, delete, and
  drag & drop to reorder.
- **Highlights** — the four bold statements on the poster (add, edit, reorder, delete).
- **Partners & logos** — upload logos, links, choose whether each appears in the program
  header and/or poster footer, drag to reorder.
- **Account & backup** — change username/password, download a JSON backup, import a
  backup, or reset everything to the original program.

## How it works

- Node.js + Express server (`server.js`), content stored in `data/db.json`
  (created from `data/seed.json` on first run; uploads in `data/uploads/`).
- Plain HTML/CSS/JS front end in `public/` — no build step.
- Passwords are hashed with scrypt; sessions are signed HttpOnly, SameSite=Strict cookies
  (12 h); login is rate-limited; uploads accept PNG/JPG/WEBP/GIF only (max 8 MB).

When deploying, keep `DATA_DIR` on persistent storage so edits and uploads survive restarts.
