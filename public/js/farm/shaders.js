// Small material patches shared by the farm viewer: wind sway and anti-tiling variation.

export const wind = { uTime: { value: 0 } };

function chainCacheKey(material, key) {
  const prev = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${prev ? prev() : ''}|${key}`;
}

/** Sway vertices by their height above the mesh origin (metres). */
export function addWind(material, amount, power = 2.0, keepNormals = false) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (sh, r) => {
    prev?.call(material, sh, r);
    sh.uniforms.uTime = wind.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 swayOrigin = (modelMatrix * instanceMatrix[3]).xyz;
        #else
          vec3 swayOrigin = modelMatrix[3].xyz;
        #endif
        float swayH = max(position.y, 0.0);
        float swayA = ${amount.toFixed(4)} * pow(swayH, ${power.toFixed(2)});
        float swayP = uTime * 1.6 + swayOrigin.x * 0.21 + swayOrigin.z * 0.17;
        transformed.x += swayA * (sin(swayP) + 0.35 * sin(swayP * 2.7 + position.x * 2.0));
        transformed.z += swayA * 0.6 * cos(swayP * 0.8 + position.z * 1.7);`);
    if (keepNormals) {
      // foliage cards carry "crown" normals: don't flip them on back faces
      sh.fragmentShader = sh.fragmentShader.replace(
        'float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;', 'float faceDirection = 1.0;');
    }
  };
  chainCacheKey(material, `wind${amount}${power}${keepNormals}`);
}

export const NOISE_GLSL = `
  float mvHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float mvNoise(vec3 x) {
    vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(mvHash(i), mvHash(i + vec3(1,0,0)), f.x), mix(mvHash(i + vec3(0,1,0)), mvHash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(mvHash(i + vec3(0,0,1)), mvHash(i + vec3(1,0,1)), f.x), mix(mvHash(i + vec3(0,1,1)), mvHash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }`;

/** Multiply albedo by low-frequency world-space noise so repeating textures don't line up. */
export function addMacro(material, amount) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (sh, r) => {
    prev?.call(material, sh, r);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMacroPos;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 macroP = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          macroP = instanceMatrix * macroP;
        #endif
        vMacroPos = (modelMatrix * macroP).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vMacroPos;${NOISE_GLSL}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        float macroN = mvNoise(vMacroPos * 0.45) * 0.6 + mvNoise(vMacroPos * 1.7 + 7.3) * 0.4;
        diffuseColor.rgb *= mix(1.0 - ${amount.toFixed(3)}, 1.0 + ${(amount * 0.6).toFixed(3)}, macroN);`);
  };
  chainCacheKey(material, `macro${amount}`);
}

const MACRO = {
  barn_wood: 0.22, siding: 0.12, roof_metal: 0.25, silo_metal: 0.18, shingles: 0.2, stone: 0.15, trim: 0.08,
  old_wood: 0.15, galv: 0.15, brick: 0.15, concrete: 0.15, straw: 0.15, bark: 0.1, rock: 0.2, stucco: 0.12,
  roof_gray: 0.2, palm_trunk: 0.1,
};
const FOLIAGE = { leaves: [0.0035, 1.6], olive_leaves: [0.004, 1.6], citrus_leaves: [0.004, 1.6],
  corn_leaf: [0.022, 2.0], banana_leaf: [0.012, 1.5], palm_frond: [0.0025, 1.4] };

/** Per-material tweaks by Blender material name. Returns special roles (e.g. water). */
export function tuneMaterial(mat, renderer) {
  if (mat.userData.tuned) return mat.userData.role;
  mat.userData.tuned = true;
  const name = mat.name;
  let role = null;
  if (FOLIAGE[name] || name === 'mesh_fence') {
    mat.alphaTest = 0.45;
    mat.side = 2; // DoubleSide
    mat.transparent = false;
    if (FOLIAGE[name]) addWind(mat, FOLIAGE[name][0], FOLIAGE[name][1], name !== 'corn_leaf' && name !== 'banana_leaf');
  } else if (name === 'glass') {
    mat.envMapIntensity = 1.6;
  } else if (name === 'greenhouse_film') {
    mat.transparent = true;
    mat.opacity = 0.32;
    mat.depthWrite = false;
    mat.side = 2;
    mat.roughness = 0.2;
    mat.envMapIntensity = 1.2;
    role = 'transparent';
  } else if (name === 'pond_water' || name === 'fish_water') {
    if (name === 'pond_water') mat.color.setRGB(0.035, 0.07, 0.06);
    else { mat.transparent = true; mat.opacity = 0.82; }
    mat.roughness = 0.05;
    mat.metalness = 0;
    mat.envMapIntensity = 1.4;
    role = 'water';
  }
  if (MACRO[name]) addMacro(mat, MACRO[name]);
  const aniso = renderer.capabilities.getMaxAnisotropy();
  for (const key of ['map', 'normalMap', 'roughnessMap']) if (mat[key]) mat[key].anisotropy = aniso;
  mat.userData.role = role;
  return role;
}
