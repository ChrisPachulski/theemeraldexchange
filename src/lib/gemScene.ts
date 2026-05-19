// Three-emerald brilliant-cut WebGL scene used by the animated favicon and any
// future in-app logo placement. One scene, one renderer — caller hands in a
// canvas and a desired aspect (3:1 for the wide mark, 1:1 for a square favicon
// crop). Phase-offset Y rotation makes the row read as a Mexican wave of
// highlights when the camera is fixed.

import * as THREE from 'three'

// Bright pole of the pulse — matches site --emerald oklch(0.62 0.180 158).
const GEM_COLOR_BRIGHT  = 0x26c891
const ATTEN_COLOR_BRIGHT = 0x1ab07a
// Deep pole of the pulse — forest-emerald, much darker. Light passing through
// the gem at this end of the cycle gets eaten more aggressively, so the body
// reads almost charcoal-green and the highlights are the only luminance.
const GEM_COLOR_DEEP    = 0x0c5e44
const ATTEN_COLOR_DEEP  = 0x062f22

function buildGemGeometry(): THREE.BufferGeometry {
  const N = 8
  const tableR = 0.30
  const starR = 0.46
  const girdleR = 0.58
  const yTable = 0.32
  const yStar = 0.18
  const yGirdle = 0.0
  const yLowerGirdle = -0.20
  const yCulet = -0.92

  const ang = (i: number) => (i / N) * Math.PI * 2 + Math.PI / N
  const angHalf = (i: number) => ((i + 0.5) / N) * Math.PI * 2 + Math.PI / N

  const tablePts: number[][] = []
  const starPts: number[][] = []
  const girdlePts: number[][] = []
  const lowerGirdlePts: number[][] = []
  for (let i = 0; i < N; i++) {
    tablePts.push([Math.cos(ang(i)) * tableR, yTable, Math.sin(ang(i)) * tableR])
    starPts.push([Math.cos(angHalf(i)) * starR, yStar, Math.sin(angHalf(i)) * starR])
    girdlePts.push([Math.cos(ang(i)) * girdleR, yGirdle, Math.sin(ang(i)) * girdleR])
    lowerGirdlePts.push([
      Math.cos(angHalf(i)) * girdleR * 0.94,
      yLowerGirdle,
      Math.sin(angHalf(i)) * girdleR * 0.94,
    ])
  }
  const culet: number[] = [0, yCulet, 0]

  const positions: number[] = []
  const indices: number[] = []
  let idx = 0
  const addFace = (a: number[], b: number[], c: number[]) => {
    positions.push(...a, ...b, ...c)
    indices.push(idx, idx + 1, idx + 2)
    idx += 3
  }

  // Table (fan-triangulated octagon)
  for (let i = 1; i < N - 1; i++) addFace(tablePts[0], tablePts[i], tablePts[i + 1])

  // Star facets (8 triangles between table edges and star points)
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N
    addFace(tablePts[i], starPts[i], tablePts[j])
  }

  // Bezel facets (8 kites, each split into 2 triangles meeting at girdle)
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N
    addFace(tablePts[j], starPts[i], girdlePts[j])
    addFace(tablePts[j], girdlePts[j], starPts[j])
  }

  // Upper girdle facets (16 paired triangles)
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N
    addFace(girdlePts[i], lowerGirdlePts[i], girdlePts[j])
    addFace(girdlePts[j], lowerGirdlePts[i], lowerGirdlePts[(i + N - 1) % N])
  }

  // Pavilion mains (8 triangles to culet)
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N
    addFace(lowerGirdlePts[i], culet, lowerGirdlePts[j])
  }

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setIndex(indices)
  // Each face owns unique vertex copies → flat per-face normals → hard facets.
  geom.computeVertexNormals()
  return geom
}

function makeStudioEnvTex(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 1024
  c.height = 512
  const g = c.getContext('2d')!
  g.fillStyle = '#0a1612'
  g.fillRect(0, 0, c.width, c.height)
  const wash = g.createLinearGradient(0, c.height * 0.4, 0, c.height)
  wash.addColorStop(0, 'rgba(31,117,83,0)')
  wash.addColorStop(1, 'rgba(31,117,83,0.35)')
  g.fillStyle = wash
  g.fillRect(0, 0, c.width, c.height)
  // Four softbox highlights at jeweler-shoot positions
  const lights = [
    { x: 256, y: 140, r: 90, a: 1.0 },
    { x: 760, y: 110, r: 110, a: 1.0 },
    { x: 130, y: 380, r: 70, a: 0.85 },
    { x: 880, y: 360, r: 80, a: 0.9 },
  ]
  for (const L of lights) {
    const rg = g.createRadialGradient(L.x, L.y, 0, L.x, L.y, L.r)
    rg.addColorStop(0, `rgba(255,255,255,${L.a})`)
    rg.addColorStop(0.5, `rgba(255,255,255,${L.a * 0.4})`)
    rg.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = rg
    g.fillRect(L.x - L.r, L.y - L.r, L.r * 2, L.r * 2)
  }
  const tex = new THREE.CanvasTexture(c)
  tex.mapping = THREE.EquirectangularReflectionMapping
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export interface GemSceneOptions {
  canvas: HTMLCanvasElement
  width: number       // render-buffer width in CSS px (multiplied by pixel ratio)
  height: number      // render-buffer height
  pixelRatio?: number // defaults to min(devicePixelRatio, 2)
  fov?: number        // camera FOV; default 22
  gemCount?: 1 | 3    // single gem (square placements / favicon) or full row (default 3)
}

export class GemScene {
  readonly renderer: THREE.WebGLRenderer
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly gems: THREE.Mesh[]
  private mat: THREE.MeshPhysicalMaterial
  private geom: THREE.BufferGeometry
  private envTex: THREE.Texture
  private colorBright!: THREE.Color
  private colorDeep!: THREE.Color
  private attenBright!: THREE.Color
  private attenDeep!: THREE.Color
  private startedAt = 0
  private rafId = 0
  private running = false

  constructor(opts: GemSceneOptions) {
    const pr = opts.pixelRatio ?? Math.min(window.devicePixelRatio, 2)

    this.renderer = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    })
    this.renderer.setPixelRatio(pr)
    this.renderer.setSize(opts.width, opts.height, false)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.15
    this.renderer.outputColorSpace = THREE.SRGBColorSpace

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(opts.fov ?? 22, opts.width / opts.height, 0.1, 50)
    this.camera.position.set(0, 0.15, 5.2)
    this.camera.lookAt(0, 0, 0)

    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.envTex = pmrem.fromEquirectangular(makeStudioEnvTex()).texture
    this.scene.environment = this.envTex
    this.scene.environmentIntensity = 1.4
    pmrem.dispose()

    const key = new THREE.DirectionalLight(0xffffff, 2.6)
    key.position.set(2.4, 2.8, 3.2)
    this.scene.add(key)
    const rim = new THREE.DirectionalLight(0xcceedd, 1.4)
    rim.position.set(-2.6, 0.6, -2.0)
    this.scene.add(rim)
    this.scene.add(new THREE.AmbientLight(0x0e1f18, 0.4))

    this.mat = new THREE.MeshPhysicalMaterial({
      color: GEM_COLOR_BRIGHT,
      metalness: 0,
      roughness: 0.05,
      transmission: 0.82,
      thickness: 0.55,
      ior: 1.58,
      attenuationColor: new THREE.Color(ATTEN_COLOR_BRIGHT),
      attenuationDistance: 1.6,
      clearcoat: 1.0,
      clearcoatRoughness: 0.03,
      envMapIntensity: 2.1,
      // Small emissive: the gem reads as self-lit rather than dependent on
      // the studio lights. This is what gives it a glow that blends with the
      // emerald-graded kraken/resting videos in the background.
      emissive: new THREE.Color(0x0d6e4d),
      emissiveIntensity: 0.55,
      side: THREE.DoubleSide,
    })
    // Pre-built color endpoints for the per-frame pulse lerp.
    this.colorBright = new THREE.Color(GEM_COLOR_BRIGHT)
    this.colorDeep   = new THREE.Color(GEM_COLOR_DEEP)
    this.attenBright = new THREE.Color(ATTEN_COLOR_BRIGHT)
    this.attenDeep   = new THREE.Color(ATTEN_COLOR_DEEP)

    this.geom = buildGemGeometry()
    this.gems = []
    const count = opts.gemCount ?? 3
    if (count === 1) {
      // Single centred gem. Gem geometry runs from culet y=-0.92 to table
      // y=+0.32 (height 1.24), so lifting the mesh by +0.30 centres its
      // vertical extent on the origin. Camera frames tightly: ~85% fill,
      // margin enough that the X-nod rotation never clips an edge.
      const g = new THREE.Mesh(this.geom, this.mat)
      g.position.set(0, 0.30, 0)
      this.scene.add(g)
      this.gems.push(g)
      this.camera.position.set(0, 0, 3.0)
      this.camera.lookAt(0, 0, 0)
      this.camera.fov = opts.fov ?? 26
      this.camera.updateProjectionMatrix()
    } else {
      const xs = [-1.55, 0, 1.55]
      for (let i = 0; i < 3; i++) {
        const g = new THREE.Mesh(this.geom, this.mat)
        g.position.set(xs[i], 0.05, 0)
        this.scene.add(g)
        this.gems.push(g)
      }
    }
  }

  /** Re-aim the camera at a square crop centered on the row's middle gem. */
  setSquareCrop(enabled: boolean) {
    if (enabled) {
      // Zoom in to frame just the centre gem in a 1:1 viewport.
      this.camera.position.set(0, 0.05, 2.2)
      this.camera.fov = 28
    } else {
      this.camera.position.set(0, 0.15, 5.2)
      this.camera.fov = 22
    }
    this.camera.updateProjectionMatrix()
  }

  resize(width: number, height: number) {
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  /** Render one frame at time t (seconds). Lets the favicon runtime sample
   *  on its own clock instead of tying to requestAnimationFrame. */
  renderAt(tSeconds: number) {
    const omega = 0.55
    const single = this.gems.length === 1
    for (let i = 0; i < this.gems.length; i++) {
      this.gems[i].rotation.y = tSeconds * omega + (single ? 0 : i * ((Math.PI * 2) / 3))
      this.gems[i].rotation.x = Math.sin(tSeconds * 0.4 + i) * (single ? 0.025 : 0.04)
    }
    // Breath pulse on a slow 6s cycle. The gem body lerps between the bright
    // site-emerald and a deep forest emerald, while the emissive intensity
    // tracks the same wave so the glow rises with the colour. All EmeraldMark
    // instances share performance.now() as their clock, so every gem on the
    // page breathes in sync.
    const pulse = 0.5 + 0.5 * Math.sin(tSeconds * 1.047) // 2π / 6s
    this.mat.color.lerpColors(this.colorDeep, this.colorBright, pulse)
    this.mat.attenuationColor.lerpColors(this.attenDeep, this.attenBright, pulse)
    this.mat.emissiveIntensity = 0.20 + 0.65 * pulse
    this.renderer.render(this.scene, this.camera)
  }

  /** Run a self-paced RAF loop until stop() is called. */
  start() {
    if (this.running) return
    this.running = true
    this.startedAt = 0
    const tick = (now: number) => {
      if (!this.running) return
      if (!this.startedAt) this.startedAt = now
      const t = (now - this.startedAt) / 1000
      this.renderAt(t)
      this.rafId = requestAnimationFrame(tick)
    }
    this.rafId = requestAnimationFrame(tick)
  }

  stop() {
    this.running = false
    cancelAnimationFrame(this.rafId)
  }

  dispose() {
    this.stop()
    this.geom.dispose()
    this.mat.dispose()
    this.envTex.dispose()
    this.renderer.dispose()
  }
}
