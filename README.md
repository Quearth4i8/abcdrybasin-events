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

## 3D farm (`/farm`)

An interactive, editable 3D model of an integrated climate-smart farm (Three.js) at **`/farm`**
(not linked from the site yet). It starts with a built-in layout: walled compound, roads, house,
poultry and goat zones, raised vegetable beds with drip lines, fish ponds with aerators, hydroponic
greenhouses, solar panels, water tower and tanks, compost, herb spiral, beehives and an
agroforestry orchard (olive, citrus, banana, date palm).

**Editing.** Logged-in admins see an **Edit farm** button (anyone can try the editor with
`/farm/?edit`, but only admins can save):

- *Add*: pick an object in the left panel (searchable), click the ground to place it
  (`R` rotates, Shift+click keeps placing, `Esc` cancels).
- *Select*: click an object, Shift+click to add more, Ctrl+A for all. Drag the gizmo, or type
  exact X / Z / rotation / scale. `W` move · `E` rotate · `R` scale · Snap = 0.5 m / 15°.
- *Duplicate* (Ctrl+D), *Delete* (Del), *Select all of this type*, *Repeat in a row* (N copies).
- *Paint ground*: grass, dirt/mulch, plowed soil, asphalt road, gravel with an adjustable brush.
- Undo / redo (Ctrl+Z / Ctrl+Shift+Z), **Save** (Ctrl+S) for everyone, export/import JSON,
  reset to the default farm.

The saved layout is stored in `DATA_DIR/farm-layout.json` (served at `GET /api/farm`, saved with
`PUT /api/admin/farm`). It is not part of the admin JSON backup; use *Export layout* in the editor.

**How it is built.**

- `tools/farm/build_farm.py` — Blender script that generates the textures (color, roughness/metal,
  normal maps), materials and a library of ~50 placeable assets → `public/farm/assets.glb`.
- `tools/farm/optimize.mjs` — meshopt compression (run automatically by the build when Node.js is available).
- `public/farm/index.html`, `public/js/farm/*.js` — viewer and editor: sky, sun shadows, image-based
  lighting, ambient occlusion, painted terrain, instanced wind-blown grass, GPU-instanced objects,
  spinning windmill/turbine/aerators, time-of-day slider.

Rebuild the assets after changing the script (needs Blender 4.2+ and `npm install`):

```bash
npm run farm:build                                   # blender -b -P tools/farm/build_farm.py
blender -b -P tools/farm/build_farm.py -- --blend tools/farm/out/farm-assets.blend
```

To add a new object, write a builder function decorated with `@asset("id", "Label", "Category")`
in the script and rebuild; it appears in the editor automatically. Viewer URL options:
`?quality=low` (default on phones), `?pr=0.5` (lower resolution), `?grass=20000`,
`?cam=x,y,z&target=x,y,z`.
