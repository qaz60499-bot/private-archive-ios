import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'

type NavigatorWithConnection = Navigator & { connection?: { saveData?: boolean } }

const sceneByRoute: Record<string, number> = {
  '/': 0,
  '/discover': 1,
  '/people': 2,
  '/places': 3,
  '/albums': 4,
  '/videos': 5,
  '/files': 6,
  '/favorites': 7,
  '/queue': 8,
  '/settings': 9,
}

const vertexShader = `
  void main() {
    gl_Position = vec4(position, 1.0);
  }
`

const fragmentShader = `
  precision highp float;
  uniform vec2 uResolution;
  uniform vec2 uPointer;
  uniform float uTime;
  uniform float uScene;
  uniform float uScroll;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x), mix(hash(i + vec2(0., 1.)), hash(i + vec2(1.)), f.x), f.y);
  }

  float fbm(vec2 p) {
    float value = 0.;
    float amplitude = .55;
    mat2 rotation = mat2(.82, -.57, .57, .82);
    for (int i = 0; i < 4; i++) {
      value += amplitude * noise(p);
      p = rotation * p * 2.03 + 7.1;
      amplitude *= .48;
    }
    return value;
  }

  float softCircle(vec2 uv, vec2 center, float radius, float softness) {
    return 1. - smoothstep(radius - softness, radius + softness, length(uv - center));
  }

  float softRing(vec2 uv, vec2 center, float radius, float width) {
    float d = abs(length(uv - center) - radius);
    return 1. - smoothstep(width * .3, width, d);
  }

  float registrationMark(vec2 uv, vec2 center) {
    vec2 q = abs(uv - center);
    float vertical = (1. - smoothstep(.0025, .006, q.x)) * (1. - smoothstep(.015, .075, q.y));
    float horizontal = (1. - smoothstep(.0025, .006, q.y)) * (1. - smoothstep(.015, .075, q.x));
    float ring = softRing(uv, center, .026, .006);
    return max(max(vertical, horizontal), ring * .7);
  }

  float frameLine(vec2 uv, vec2 center, vec2 size, float angle) {
    float c = cos(angle), s = sin(angle);
    vec2 q = mat2(c, -s, s, c) * (uv - center);
    vec2 d = abs(q) - size;
    float outer = smoothstep(.012, 0., min(abs(d.x), abs(d.y)));
    float gate = step(abs(q.x), size.x + .02) * step(abs(q.y), size.y + .02);
    return outer * gate;
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution.xy;
    vec2 p = uv - .5;
    p.x *= uResolution.x / max(uResolution.y, 1.);
    float scene = uScene;
    float t = uTime * .055;
    float scroll = clamp(uScroll, 0., 1.);
    p.y += (scroll - .5) * .065;

    float phase = scene * .73;
    vec2 drift = vec2(sin(t * .8 + phase), cos(t * .64 - phase)) * .13 + uPointer * .07;
    float cloudA = fbm(p * 1.65 + drift + vec2(t * .07, -t * .04));
    float cloudB = fbm(p * 2.35 - drift * 1.3 + vec2(-t * .035, t * .06));
    float reaction = smoothstep(.2, .92, cloudA * .72 + cloudB * .5);

    vec3 paper = vec3(.945, .932, .885);
    vec3 sage = vec3(.31, .38, .29);
    vec3 amber = vec3(.72, .47, .24);
    vec3 oxide = vec3(.46, .20, .16);
    vec3 silver = vec3(.48, .52, .49);
    vec3 violet = vec3(.35, .30, .40);

    float paletteBand = fract(scene * .173 + .08);
    vec3 primary = mix(sage, amber, smoothstep(.08, .34, paletteBand));
    primary = mix(primary, oxide, smoothstep(.34, .62, paletteBand));
    primary = mix(primary, violet, smoothstep(.66, .94, paletteBand));
    primary = mix(primary, silver, smoothstep(.82, 1., abs(sin(scene * .61))));
    vec3 secondary = mix(amber, sage, .5 + .5 * sin(scene * .91 + 1.2));

    vec2 lightCenter = vec2(.35 + .24 * sin(phase + t * .42), .22 + .18 * cos(phase * 1.4 - t * .35));
    vec2 darkCenter = vec2(-.38 + .2 * cos(phase * .8), -.22 + .16 * sin(t * .27 + phase));
    float exposure = softCircle(p, lightCenter, .38 + .08 * sin(t + phase), .28);
    float halation = softRing(p, lightCenter, .25 + .025 * sin(t * .8 + phase), .11);
    float stain = softCircle(p, darkCenter, .46, .34) * (.45 + cloudB * .55);

    vec3 color = paper;
    color = mix(color, primary, reaction * .22 + stain * .12);
    color = mix(color, secondary, exposure * (.08 + cloudA * .11));
    color = mix(color, amber, halation * (.035 + scroll * .035));
    color += vec3(.035, .026, .012) * smoothstep(.42, .85, cloudB);

    float frameA = frameLine(p, vec2(.18, .08) + drift * .3, vec2(.31, .21), -.07 + sin(phase) * .04);
    float frameB = frameLine(p, vec2(-.31, -.2) - drift * .22, vec2(.21, .14), .08 + cos(phase) * .05);
    float frameC = frameLine(p, vec2(.48, -.31), vec2(.16, .24), -.035);
    color = mix(color, sage, (frameA * .09 + frameB * .065 + frameC * .045));

    float registration = registrationMark(p, vec2(-.53, .31)) + registrationMark(p, vec2(.56, -.28));
    color = mix(color, oxide, registration * .055);

    float rayGate = 1. - smoothstep(-.2, .9, p.x);
    float ray = exp(-abs(p.y + .18 * p.x - .12 * sin(t + phase) - (scroll - .5) * .08) * 9.) * rayGate;
    color = mix(color, amber, ray * .055);

    float grain = hash(gl_FragCoord.xy + floor(uTime * 3.));
    color += (grain - .5) * .026;
    float vignette = smoothstep(.95, .2, length(p * vec2(.68, .9)));
    color = mix(paper * .96, color, .72 + vignette * .28);

    gl_FragColor = vec4(color, .86);
  }
`

export function ArchiveAtmosphere() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneTargetRef = useRef(0)
  const location = useLocation()

  useEffect(() => {
    sceneTargetRef.current = sceneByRoute[location.pathname] ?? 0
    document.documentElement.dataset.archiveScene = String(sceneTargetRef.current)
  }, [location.pathname])

  useEffect(() => {
    const canvas = canvasRef.current
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const saveData = (navigator as NavigatorWithConnection).connection?.saveData
    const personalDesktop = document.documentElement.dataset.appSurface === 'personal-desktop'
    if (!canvas) return

    // The packaged personal SaaS prioritises instant archive access over ambient WebGL.
    // Its CSS atmosphere is already complete, so do not download or initialise Three.js.
    if (personalDesktop) {
      canvas.dataset.unavailable = 'true'
      return
    }

    if (reduceMotion || saveData) return

    let disposed = false
    let disposeScene: (() => void) | undefined
    const mobile = window.matchMedia('(max-width: 767px)').matches
    const startTimer = window.setTimeout(() => {
      void import('three').then((THREE) => {
      if (disposed) return
      let renderer: InstanceType<typeof THREE.WebGLRenderer>
      try {
        renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: 'low-power' })
      } catch {
        canvas.dataset.unavailable = 'true'
        return
      }

      renderer.setClearColor(0x000000, 0)
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobile ? .9 : 1.2))

      const scene = new THREE.Scene()
      const camera = new THREE.Camera()
      const geometry = new THREE.PlaneGeometry(2, 2)
      const uniforms = {
        uResolution: { value: new THREE.Vector2(1, 1) },
        uPointer: { value: new THREE.Vector2(0, 0) },
        uTime: { value: 0 },
        uScene: { value: sceneTargetRef.current },
        uScroll: { value: 0 },
      }
      const material = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms, transparent: true, depthTest: false, depthWrite: false })
      scene.add(new THREE.Mesh(geometry, material))

      const pointerTarget = new THREE.Vector2()
      let scrollTarget = 0
      let previous = 0
      let elapsed = 0
      const frameInterval = 1000 / (mobile ? 18 : 30)

      const resize = () => {
        const width = canvas.clientWidth
        const height = canvas.clientHeight
        if (!width || !height) return
        renderer.setSize(width, height, false)
        uniforms.uResolution.value.set(renderer.domElement.width, renderer.domElement.height)
      }
      const onPointerMove = (event: PointerEvent) => {
        pointerTarget.set(event.clientX / window.innerWidth - .5, .5 - event.clientY / window.innerHeight)
      }
      const onScroll = () => {
        const scrollRange = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1)
        scrollTarget = Math.min(window.scrollY / scrollRange, 1)
      }
      const render = (time: number) => {
        const delta = time - previous
        if (delta < frameInterval) return
        previous = time - (delta % frameInterval)
        elapsed += Math.min(delta, 80) / 1000
        uniforms.uTime.value = elapsed
        uniforms.uPointer.value.lerp(pointerTarget, mobile ? .02 : .045)
        uniforms.uScene.value += (sceneTargetRef.current - uniforms.uScene.value) * .025
        uniforms.uScroll.value += (scrollTarget - uniforms.uScroll.value) * (mobile ? .025 : .04)
        renderer.render(scene, camera)
      }
      const onVisibilityChange = () => {
        renderer.setAnimationLoop(document.hidden ? null : render)
        if (!document.hidden) previous = performance.now()
      }
      const onContextLost = (event: Event) => {
        event.preventDefault()
        canvas.dataset.unavailable = 'true'
        renderer.setAnimationLoop(null)
      }

      const resizeObserver = new ResizeObserver(resize)
      resizeObserver.observe(canvas)
      window.addEventListener('pointermove', onPointerMove, { passive: true })
      window.addEventListener('scroll', onScroll, { passive: true })
      document.addEventListener('visibilitychange', onVisibilityChange)
      canvas.addEventListener('webglcontextlost', onContextLost)
      resize()
      onScroll()
      renderer.setAnimationLoop(render)

      disposeScene = () => {
        renderer.setAnimationLoop(null)
        resizeObserver.disconnect()
        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('scroll', onScroll)
        document.removeEventListener('visibilitychange', onVisibilityChange)
        canvas.removeEventListener('webglcontextlost', onContextLost)
        geometry.dispose()
        material.dispose()
        renderer.dispose()
      }
      }).catch(() => { canvas.dataset.unavailable = 'true' })
    }, mobile ? 1400 : 1000)

    return () => {
      disposed = true
      window.clearTimeout(startTimer)
      disposeScene?.()
    }
  }, [])

  return (
    <div className="archive-atmosphere" aria-hidden="true">
      <div className="archive-atmosphere-fallback"><i /><i /><i /></div>
      <canvas ref={canvasRef} />
      <div className="route-exposure-veil" />
      <div className="archive-exposure-track"><span /><span /><span /></div>
    </div>
  )
}
