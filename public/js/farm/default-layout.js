// The built-in farm: an integrated, climate-smart compound (used until an admin saves a layout).
// Coordinates in metres: x = east, z = south, ry = degrees counter-clockwise seen from above.
// Assets face +z ("south") at ry = 0.

const PAVING = 3, DIRT = 1, SOIL = 2, GRAVEL = 4;

function rng(seed) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

/** Pieces of a straight wall/fence from (x0,z0) to (x1,z1); last piece is stretched to fit. */
function run(out, asset, len, x0, z0, x1, z1) {
  const L = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.round(L / len));
  const seg = L / n;
  const ry = Math.atan2(-(z1 - z0), x1 - x0) * 180 / Math.PI;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    out.push({ asset, x: x0 + (x1 - x0) * t, z: z0 + (z1 - z0) * t, ry, sx: seg / len });
  }
}

export function defaultLayout(mask) {
  const o = [];
  const put = (asset, x, z, ry = 0, s = 1) => o.push({ asset, x, z, ry, sx: s, sy: s, sz: s });
  const r = rng(12345);

  // ---- ground paint
  mask.clear();
  mask.rect(PAVING, -58, -25, 58, -19);         // main east-west road
  mask.rect(PAVING, -3, -19, 3, 92);            // central road out through the gate
  mask.rect(PAVING, -31, -41, -18, -26);        // parking
  mask.rect(GRAVEL, -43, -38, -41, -25);        // path to the house
  mask.rect(GRAVEL, -2, -58, 27, -28);          // poultry yard
  mask.rect(DIRT, 30, -49, 58, -28);            // goat paddock
  mask.rect(GRAVEL, 30, -58, 58, -49);
  mask.rect(DIRT, -44, -15, -7, 12);            // vegetable garden
  mask.rect(GRAVEL, -58, -16, -46, 18);         // service strip
  mask.rect(GRAVEL, 6, -16, 58, 18);            // aquaculture walkways
  mask.rect(GRAVEL, -49, 26, -24, 55);          // greenhouse pad
  mask.rect(SOIL, -19, 34, -11, 49);            // corn
  for (const z of [28, 33, 38, 43, 48, 53]) mask.line(DIRT, [[8, z], [58, z]], 2.6); // mulched tree rows

  // ---- perimeter wall with the entrance gate on the south side
  run(o, 'wall', 10, -60, -60, 60, -60);
  run(o, 'wall', 10, 60, -60, 60, 60);
  run(o, 'wall', 10, -60, 60, -60, -60);
  run(o, 'wall', 10, -60, 60, -10, 60);
  run(o, 'wall', 10, 10, 60, 60, 60);
  run(o, 'wall', 10, -10, 60, -3.6, 60);
  run(o, 'wall', 10, 3.6, 60, 10, 60);
  put('gate', 0, 60);

  // ---- home: modern house, parking, garden
  put('house_modern', -42, -46);
  put('car', -24.5, -33, 0);
  put('storage_shed', -12, -33, 0);
  for (const [x, z] of [[-51, -38], [-47, -37.5], [-36, -37.5], [-33, -38.5], [-52, -55], [-32, -55]]) put(r() < 0.5 ? 'bush' : 'hedge_bush', x, z, r() * 360);
  put('date_palm', -55, -40, 20);
  put('date_palm', -29, -52, 80);
  put('tree_oak', -55, -29, 0);
  put('tree_citrus', -35, -30, 0);
  put('tree_lemon', -49, -30, 90);

  // ---- poultry: two houses, feed bins, netting fence
  put('poultry_house', 5, -44);
  put('poultry_house', 19, -44);
  put('feed_bin', 12, -52);
  put('feed_bin', 12, -45.5);
  run(o, 'fence_mesh', 5, -2, -58, -2, -28);
  run(o, 'fence_mesh', 5, -2, -28, 9, -28);
  run(o, 'fence_mesh', 5, 15, -28, 26.5, -28);
  run(o, 'fence_mesh', 5, 26.5, -28, 26.5, -58);
  put('chickens', 2, -30.5);
  put('chickens', 23, -30.5, 140);

  // ---- goats & sheep: open shed and paddock
  put('livestock_shed', 44, -53);
  run(o, 'fence_wood', 5, 30, -58, 30, -28);
  run(o, 'fence_wood', 5, 30, -28, 42, -28);
  run(o, 'fence_wood', 5, 47, -28, 59.5, -28);
  put('trough', 37, -41, 90);
  put('round_bale', 54, -37, 30);
  put('round_bale', 55.5, -33, 75);
  for (let i = 0; i < 9; i++) {
    put(i < 5 ? (i % 2 ? 'goat_brown' : 'goat') : 'sheep', 33 + r() * 22, -46 + r() * 15, r() * 360);
  }
  put('tree_oak', 36, -32, 0);

  // ---- vegetable garden: 3 rows of raised beds with drip irrigation
  const beds = ['bed_lettuce', 'bed_tomato', 'bed_cabbage', 'bed_greens', 'bed_flowers', 'bed_lettuce', 'bed_tomato', 'bed_greens', 'bed_cabbage'];
  let k = 0;
  for (const z of [-10, -1.5, 7]) {
    for (let x = -40; x <= -10; x += 2.5) put(beds[k++ % beds.length], x, z);
  }
  // service strip: pump house, rainwater tank, solar pumping, compost
  put('storage_shed', -53, -10, 90);
  put('water_tank', -53, -2);
  put('solar_array', -52, 6);
  put('compost', -52, 14.5);

  // ---- aquaculture: four fish ponds with aerators, feed store, wind turbine
  for (const [x, z] of [[15, -8], [33, -8], [15, 8], [33, 8]]) put('fish_pond', x, z);
  put('storage_shed', 52, -8, -90);
  put('water_tank', 52, 1.5);
  put('wind_turbine', 53, 12);
  put('bush', 46, 15);

  // ---- hydroponic greenhouses, water tower, more solar
  put('greenhouse', -42, 40);
  put('greenhouse', -30, 40);
  put('water_tower', -54.5, 30);
  put('water_tank', -54, 39.5);
  put('solar_array', -53, 51);

  // ---- permaculture corner: herb spiral, corn, bees, vine pergola
  put('herb_spiral', -15, 28);
  put('corn_plot', -15, 38);
  put('corn_plot', -15, 45);
  put('beehive', -19, 55, 0);
  put('beehive', -12, 55, 0);
  put('pergola', -8, 29, 0);

  // ---- agroforestry orchard: alternating rows of olive, citrus, banana and date palms
  for (let x = 12; x <= 54; x += 7) put('tree_olive', x, 28, r() * 360, 0.9 + r() * 0.2);
  for (let x = 10; x <= 56; x += 5) put('banana', x, 33, r() * 360, 0.9 + r() * 0.2);
  for (let x = 12; x <= 54; x += 6) put((x / 6) % 2 ? 'tree_citrus' : 'tree_lemon', x, 38, r() * 360, 0.9 + r() * 0.2);
  for (let x = 14; x <= 54; x += 10) put('date_palm', x, 43, r() * 360, 0.9 + r() * 0.2);
  for (let x = 19; x <= 54; x += 10) put('tree_citrus', x, 43, r() * 360);
  for (let x = 12; x <= 54; x += 7) put('tree_olive', x, 48, r() * 360, 0.9 + r() * 0.2);
  for (let x = 10; x <= 56; x += 6) put(x % 12 ? 'banana' : 'tree_lemon', x, 53, r() * 360);
  put('bed_flowers', 8.5, 57, 90);

  // ---- outside the walls: palms and shade trees, a few bales
  for (let i = 0; i < 46; i++) {
    const side = i % 4, t = r() * 150 - 75, d = 64 + r() * 18;
    let [x, z] = side === 0 ? [t, -d] : side === 1 ? [d, t] : side === 2 ? [t, d] : [-d, t];
    if (side === 2 && Math.abs(x) < 9) x += 18;
    put(r() < 0.45 ? 'date_palm' : r() < 0.6 ? 'tree_oak' : 'tree_olive', x, z, r() * 360, 0.85 + r() * 0.35);
  }
  for (let i = 0; i < 8; i++) put('round_bale', -80 + r() * 20, 10 + r() * 40, r() * 360);
  for (let i = 0; i < 10; i++) put(r() < 0.5 ? 'rock' : 'rock_small', (r() - 0.5) * 170, 66 + r() * 20, r() * 360);

  return o.map((x) => ({ sx: 1, sy: 1, sz: 1, ...x }));
}
