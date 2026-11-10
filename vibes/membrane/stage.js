// stage.js - Membrane: what both games share: the WebGPU renderer, the camera and its orbit, the studio (after
// Hollow's: cyclorama, plinth, morning sun through a window), the board and the egg cup, and the post chain
// (godrays from the sun's shadow map, bloom, AgX, vignette, grain). `offscreen` renders into a target the smoke
// test reads, since headless Chromium's software WebGPU loses its device on the first present to a canvas.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { pass, uniform, vec2, vec4, float, mix, smoothstep, length, screenUV, screenSize, hash, time, Fn } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { godrays } from 'three/addons/tsl/display/GodraysNode.js';
import { bilateralBlur } from 'three/addons/tsl/display/BilateralBlurNode.js';
import { buildCup, buildTable, buildStudio } from './scene.js';

export async function makeStage({ Q, phone, camPos = [0.5, 9.2, 13.4], target = [0, -1.2, 0] }) {
  const renderer = new THREE.WebGPURenderer({ canvas: document.getElementById('gl'), antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, phone ? 2 : 1.75));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.AgXToneMapping; renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  await renderer.init();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0b0a);
  const camera = new THREE.PerspectiveCamera(34, innerWidth / innerHeight, 0.3, 400);
  camera.position.set(...camPos);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(...target); controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.minDistance = 4; controls.maxDistance = 30; controls.maxPolarAngle = 1.45; controls.enablePan = false;
  controls.update();

  // a dim room for reflections in wet surfaces, and the studio: morning sun through a window, a cool sky fill
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.45;
  const studio = buildStudio(scene, { shadowSize: phone ? 2048 : 4096 });
  const sun = studio.key;
  scene.add(buildTable(), buildCup());

  const cv = renderer.domElement;
  const OFF = Q.has('offscreen');
  let off = null;
  if (OFF) {
    const W = innerWidth, H = innerHeight;
    off = { W, H, ldr: new THREE.RenderTarget(W, H) };
    off.c2d = document.createElement('canvas'); off.c2d.width = W; off.c2d.height = H;
    off.c2d.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none'; document.body.insertBefore(off.c2d, cv.nextSibling);
  }
  // ---- post, as in Hollow: the scene, raymarched godrays from the sun's shadow map (blurred), bloom, vignette, grain
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera, { samples: phone ? 0 : 4 });
  const col = scenePass.getTextureNode('output'), depth = scenePass.getTextureNode('depth');
  const rays = godrays(depth, camera, sun);
  rays.raymarchSteps.value = phone ? 32 : 48; rays.resolutionScale = phone ? 0.35 : 0.5;
  rays.density.value = 0.8; rays.maxDensity.value = 0.4; rays.distanceAttenuation.value = 0.5;
  const raysBlur = bilateralBlur(rays.getTextureNode(), null, 4, 0.5).getTextureNode();
  const glow = bloom(col, 0.12, 0.5, 0.9);
  const POST = { beam: uniform(new THREE.Color(0xfff0dc)), beamGain: uniform(0.22), vignette: uniform(0.45) };
  pipeline.outputNode = Fn(() => {
    const g = raysBlur.sample(screenUV).r;
    // haze in the beam scatters sunlight toward you; it adds, so the shade stays dark
    const room = col.rgb.mul(g.mul(-0.3).add(1)).add(POST.beam.mul(POST.beamGain).mul(g));
    const c = room.add(glow.rgb);
    const v = smoothstep(1.15, 0.25, length(screenUV.sub(0.5).mul(vec2(screenSize.x.div(screenSize.y), 1))));
    const px = screenUV.mul(screenSize).floor();
    const n = hash(px.x.add(px.y.mul(4111.0)).add(time.mul(60).floor().mul(7919.0).mod(65536))).sub(0.5).mul(0.006);
    return vec4(c.mul(mix(float(1).sub(POST.vignette), float(1), v)).add(n), 1);
  })();
  const draw = () => { renderer.setRenderTarget(OFF ? off.ldr : null); pipeline.render(); renderer.setRenderTarget(null); };
  const snapshot = async () => {
    draw();
    const px = await renderer.readRenderTargetPixelsAsync(off.ldr, 0, 0, off.W, off.H);
    off.c2d.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength), off.W, off.H), 0, 0);
  };
  addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
  return { renderer, scene, camera, controls, sun, studio, cv, draw, snapshot, OFF, POST, rays };
}
