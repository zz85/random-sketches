# Caustic

Light off water, after the Wallace sets in *Blade Runner 2049*. Three sets, each lit only by light thrown off rippling water:

- **Corridor**: the planked wooden passage with stairs climbing through receding, tilted portal frames, with thin bright lines running down the walls and over the steps.
- **Office**: Wallace's office: warm concrete, pilasters and a long shelf, a skylight, a desk and chairs, with broad, slow gold ribbons over the back wall and floor.
- **Hall**: the hall of water: a black flooded floor, a wooden platform with two leather chairs, stepping stones, a slit of light overhead and fine ripples on the curved walls.

![corridor](shot_corridor.jpg)
![office](shot_office.jpg)
![hall](shot_hall.jpg)

## Controls

- **Corridor / Office / Hall** (keys 1, 2, 3) switch sets.
- **Tour** plays slow camera moves with fade cuts. Space jumps to the next shot. Drag to look around yourself (orbit, zoom); Tour picks the moves up again.
- **Haze** puts haze in the beams. **GI** turns screen-space global illumination on or off. **Scope** shows the 2.39:1 bars. **Sound** plays a drone with water under it. `h` hides the UI.
- Query flags: `?set=hall`, `?webgl` (the WebGL 2 backend), `?phone` (the lighter path phones get), `?nohaze`, `?novol`, `?nogi`, `?notaa`, `?steps=N` (haze steps), `?free` (no tour), `?paused`.

## How it works

On set, Roger Deakins lit these walls with 10K Fresnels aimed into shallow troughs of water, so the light reflected off the moving surface onto the walls (eight 10K Fresnels with custom barn doors, per his forum and the ASC write-ups). The app copies that rig rather than simulating the light transport.

- **Caustic texture** (`caustics.js`): per set, a tileable float render target of the caustic of a water surface made of 12 travelling waves with integer wave vectors (so it tiles). A grid mesh is pushed along the surface gradient by the trough's depth, and each fragment writes source area over projected area from screen-space derivatives, in three draws at slightly different depths for a touch of dispersion. Depth, wave lengths and speed set the look: long and slow for the office's ribbons, short and sharp for the corridor's lines, fine for the hall.
- **Projected spot lights**: each "Fresnel" is a `SpotLight` whose `colorNode` samples that texture, turned and drifting, with shadow maps, so the ripples land on the walls with the beams and frames shadowing them, like in the film.
- **Global illumination**: SSGI (three's `ssgi` node) on an MRT scene pass, composited as `beauty * AO + albedo * GI`, then TRAA to resolve its noise. Every caustic beam also gets one unshadowed point light where it lands, a virtual point light for the first bounce off the wood or concrete, so the room fills in warm even with GI off (phones).
- **Haze**: a `VolumeNodeMaterial` box with 3D noise raymarched at half resolution with Bayer dither, lit by the same projected spots, blurred and added on top, for beams in the air.
- **Water**: the hall's floor is a `reflector()` with its UVs wobbled by noise and a dark base, so the walls and the slit come back broken up.
- **Look**: ACES tone mapping, bloom, a 25-tap horizontal anamorphic streak taken from the bloom, a little edge fringe, an amber grade with a lifted toe, vignette and grain.

## Tests

`node smoke.js` runs headless Chrome over CDP (zero deps): every set and shot on WebGL 2 with everything on, then every set on WebGPU without the haze, checking the caustic texture's statistics (mean about 1, high variance, bright peaks) and that the console has no errors. Screenshots go to `/tmp/caustic-shots`; `SHOTS=1` refreshes the ones above. SwiftShader's software WebGPU loses its device on the haze pass (many shadowed, projected lights sampled per raymarch step), so the WebGPU run leaves it out; if a real GPU loses the device, the page reloads with `?novol`. Not yet tried on real GPUs or phones.
