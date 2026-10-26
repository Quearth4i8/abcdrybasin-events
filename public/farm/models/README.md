# Bundled farm models

Optional `.glb` models committed with the site. List them in `models.json`, e.g.:

```json
[
  { "id": "nft_pro", "label": "NFT rack (detailed)", "category": "Hydroponics", "file": "nft-pro.glb", "scale": 1 },
  { "id": "greenhouse", "label": "Greenhouse (detailed)", "category": "Hydroponics", "file": "greenhouse.glb", "scale": 1 }
]
```

Using the `id` of a built-in object (like `greenhouse`) replaces it everywhere. Models uploaded
in the editor are stored on the server instead (`DATA_DIR/farm-models/`) and override these.
