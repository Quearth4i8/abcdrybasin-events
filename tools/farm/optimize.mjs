// Post-process the raw Blender export for the web:
//  - objects sharing a mesh (corn, trees, bales...) -> EXT_mesh_gpu_instancing
//  - meshopt compression; normals/UVs/colours quantized, positions kept as float
//    so the viewer's wind shaders can use real heights in metres.
//
// usage: node tools/farm/optimize.mjs [in.glb] [out.glb]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, instance, prune, quantize, reorder } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const input = process.argv[2] || path.join(here, 'out', 'farm_raw.glb');
const output = process.argv[3] || path.join(here, '..', '..', 'public', 'farm', 'farm.glb');

await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

const doc = await io.read(input);
await doc.transform(
  dedup(),
  instance({ min: 3 }),
  reorder({ encoder: MeshoptEncoder }),
  quantize({ pattern: /^(NORMAL|TEXCOORD_\d+|COLOR_\d+)$/, quantizeNormal: 10, quantizeTexcoord: 12 }),
  prune({ keepLeaves: true }),
);
doc.createExtension(EXTMeshoptCompression)
  .setRequired(true)
  .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
await io.write(output, doc);

const mb = (f) => (statSync(f).size / 1e6).toFixed(1) + ' MB';
console.log(`optimized ${input} (${mb(input)}) -> ${output} (${mb(output)})`);
