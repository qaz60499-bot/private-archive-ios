import { useEffect, useRef } from 'react'

type NavigatorWithConnection = Navigator & { connection?: { saveData?: boolean } }

const vertexShader = `
  uniform float uTime;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec3 vPosition;

  void main() {
    vec3 displaced = position;
    float waveA = sin(position.y * 5.4 + uTime * .72);
    float waveB = sin(position.x * 7.1 - uTime * .46);
    float waveC = sin((position.z + position.x) * 4.2 + uTime * .31);
    displaced += normal * (waveA + waveB + waveC) * .014;

    vec4 mvPosition = modelViewMatrix * vec4(displaced, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vViewDir = normalize(-mvPosition.xyz);
    vPosition = displaced;
    gl_Position = projectionMatrix * mvPosition;
  }
`

const fragmentShader = `
  precision highp float;
  uniform float uTime;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec3 vPosition;

  float hash(vec3 p) {
    p = fract(p * .1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  void main() {
    float fresnel = pow(1.0 - max(dot(normalize(vNormal), normalize(vViewDir)), 0.0), 2.25);
    float verticalBand = .5 + .5 * sin(vPosition.y * 8.2 + uTime * .32);
    float diagonalBand = .5 + .5 * sin((vPosition.x - vPosition.z) * 6.4 - uTime * .23);
    float grain = hash(vPosition * 37.0 + floor(uTime * 2.0));

    vec3 paper = vec3(.91, .88, .78);
    vec3 sage = vec3(.27, .34, .25);
    vec3 amber = vec3(.67, .43, .22);
    vec3 oxide = vec3(.42, .19, .14);

    vec3 color = mix(sage, paper, fresnel * .68);
    color = mix(color, amber, verticalBand * .11);
    color = mix(color, oxide, diagonalBand * .045);
    color += (grain - .5) * .035;

    float alpha = .12 + fresnel * .42 + verticalBand * .045;
    gl_FragColor = vec4(color, alpha);
  }
`

export function MemoryAperture({ count }: { count: number }) {
  const rootRef = useRef<HTMLElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const root = rootRef.current
    const canvas = canvasRef.current
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const saveData = (navigator as NavigatorWithConnection).connection?.saveData
    if (!root || !canvas || reduceMotion || saveData) {
      if (root) root.dataset.renderMode = 'static'
      return
    }

    let disposed = false
    let disposeScene: (() => void) | undefined
    const startTimer = window.setTimeout(() => {
      void import('three').then((THREE) => {
      if (disposed) return

      const mobile = window.matchMedia('(max-width: 767px)').matches
      let renderer: InstanceType<typeof THREE.WebGLRenderer>
      try {
        renderer = new THREE.WebGLRenderer({
          canvas,
          alpha: true,
          antialias: false,
          powerPreference: mobile ? 'low-power' : 'high-performance',
        })
      } catch {
        root.dataset.renderMode = 'static'
        canvas.dataset.unavailable = 'true'
        return
      }

      renderer.setClearColor(0x000000, 0)
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobile ? 1 : 1.25))
      renderer.outputColorSpace = THREE.SRGBColorSpace

      const scene = new THREE.Scene()
      const camera = new THREE.PerspectiveCamera(32, 1, .1, 30)
      // Keep enough projection margin for the full orbit family. The hero itself
      // owns overflow clipping, so the 3D scene should never meet a canvas edge.
      camera.position.set(0, 0, mobile ? 6.86 : 6.72)

      const sculpture = new THREE.Group()
      sculpture.rotation.set(-.08, -.22, .035)
      scene.add(sculpture)

      const shaderUniforms = { uTime: { value: 0 } }
      const shellGeometry = new THREE.IcosahedronGeometry(mobile ? 1.05 : 1.16, mobile ? 3 : 4)
      const shellMaterial = new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: shaderUniforms,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
      const shell = new THREE.Mesh(shellGeometry, shellMaterial)
      sculpture.add(shell)

      const wireMaterial = new THREE.MeshBasicMaterial({ color: 0x5f6d58, wireframe: true, transparent: true, opacity: mobile ? .115 : .12 })
      const wireShell = new THREE.Mesh(shellGeometry, wireMaterial)
      wireShell.scale.setScalar(1.012)
      sculpture.add(wireShell)

      const coreGeometry = new THREE.SphereGeometry(mobile ? .65 : .7, mobile ? 24 : 28, mobile ? 16 : 20)
      const coreMaterial = new THREE.MeshPhysicalMaterial({
        color: 0xb78b51,
        roughness: .34,
        metalness: .04,
        clearcoat: 1,
        clearcoatRoughness: .4,
        transparent: true,
        opacity: mobile ? .34 : .26,
        emissive: 0x6f3a1f,
        emissiveIntensity: .22,
        depthWrite: false,
      })
      const core = new THREE.Mesh(coreGeometry, coreMaterial)
      sculpture.add(core)

      // Write only the core's depth so orbit segments disappear naturally when
      // they travel behind the sphere instead of looking clipped by a flat layer.
      const coreOccluderMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, depthTest: true })
      const coreOccluder = new THREE.Mesh(coreGeometry, coreOccluderMaterial)
      coreOccluder.scale.setScalar(.965)
      sculpture.add(coreOccluder)

      const apertureGeometry = new THREE.CircleGeometry(mobile ? .78 : .86, 7)
      const apertureEdges = new THREE.EdgesGeometry(apertureGeometry)
      apertureGeometry.dispose()
      const apertureMaterial = new THREE.LineBasicMaterial({ color: 0x7a5d3d, transparent: true, opacity: .25 })
      const aperture = new THREE.LineSegments(apertureEdges, apertureMaterial)
      aperture.position.z = .74
      aperture.rotation.z = .18
      sculpture.add(aperture)

      const orbitMaterial = new THREE.MeshBasicMaterial({ color: 0x687760, transparent: true, opacity: mobile ? .27 : .3, depthWrite: false, depthTest: true })
      const orbitCount = mobile ? 3 : 4
      const orbits: InstanceType<typeof THREE.Mesh>[] = []
      const orbitBases: Array<{ x: number; y: number; z: number }> = []
      for (let index = 0; index < orbitCount; index += 1) {
        const orbitGeometry = new THREE.TorusGeometry(1.4 + index * .105, mobile ? .006 : .008, 5, mobile ? 72 : 120)
        const orbit = new THREE.Mesh(orbitGeometry, orbitMaterial)
        const base = { x: .42 + index * .37, y: -.22 + index * .31, z: index * .47 }
        orbit.rotation.set(base.x, base.y, base.z)
        sculpture.add(orbit)
        orbits.push(orbit)
        orbitBases.push(base)
      }

      const particleCount = mobile ? 360 : 760
      const particlePositions = new Float32Array(particleCount * 3)
      for (let index = 0; index < particleCount; index += 1) {
        const radius = 1.55 + Math.random() * 1.35
        const theta = Math.random() * Math.PI * 2
        const phi = Math.acos(2 * Math.random() - 1)
        particlePositions[index * 3] = radius * Math.sin(phi) * Math.cos(theta)
        particlePositions[index * 3 + 1] = radius * Math.cos(phi) * .74
        particlePositions[index * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta)
      }
      const particleGeometry = new THREE.BufferGeometry()
      particleGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3))
      const particleMaterial = new THREE.PointsMaterial({
        color: 0x6b745f,
        size: mobile ? .016 : .02,
        transparent: true,
        opacity: mobile ? .29 : .32,
        sizeAttenuation: true,
        depthWrite: false,
      })
      const particles = new THREE.Points(particleGeometry, particleMaterial)
      sculpture.add(particles)

      const frameMaterial = new THREE.LineBasicMaterial({ color: 0x7c7566, transparent: true, opacity: mobile ? .17 : .2 })
      const frames: InstanceType<typeof THREE.LineSegments>[] = []
      const frameBaseY: number[] = []
      const frameCount = mobile ? 3 : 5
      for (let index = 0; index < frameCount; index += 1) {
        const plane = new THREE.PlaneGeometry(.44 + (index % 2) * .13, .3 + (index % 3) * .05)
        const edges = new THREE.EdgesGeometry(plane)
        plane.dispose()
        const frame = new THREE.LineSegments(edges, frameMaterial)
        const angle = (index / frameCount) * Math.PI * 2 + .4
        const radius = mobile ? 1.65 : 2.05 + (index % 2) * .18
        frame.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius * .56, (index % 2 ? -.42 : .46))
        frame.rotation.set(.18 * (index % 2 ? 1 : -1), angle * .18, angle + Math.PI * .5)
        sculpture.add(frame)
        frames.push(frame)
        frameBaseY.push(frame.position.y)
      }

      const ambient = new THREE.AmbientLight(0xf3e8cf, 1.2)
      const warmLight = new THREE.PointLight(0xd69b5d, 5.5, 10)
      warmLight.position.set(2.3, 1.2, 3.8)
      const sageLight = new THREE.PointLight(0x718069, 3.2, 9)
      sageLight.position.set(-2.7, -1.1, 2.2)
      scene.add(ambient, warmLight, sageLight)

      const pointerTarget = new THREE.Vector2()
      const pointer = new THREE.Vector2()
      let scrollTarget = 0
      let scroll = 0
      let scrollVelocityTarget = 0
      let scrollVelocity = 0
      let previousScrollY = window.scrollY
      let previousScrollAt = performance.now()
      let lastScrollEventAt = -Infinity
      let scrollActive = false
      let visible = true
      let previous = 0
      const frameInterval = 1000 / (mobile ? 28 : 42)

      const setScrollActive = (active: boolean) => {
        if (!mobile || scrollActive === active) return
        scrollActive = active
        root.dataset.scrollActive = String(active)
      }

      const resize = () => {
        const width = canvas.clientWidth
        const height = canvas.clientHeight
        if (!width || !height) return
        renderer.setSize(width, height, false)
        camera.aspect = width / height
        camera.updateProjectionMatrix()
      }

      const onPointerMove = (event: PointerEvent) => {
        const bounds = root.getBoundingClientRect()
        if (!bounds.width || !bounds.height) return
        pointerTarget.set(
          ((event.clientX - bounds.left) / bounds.width - .5) * 2,
          -(((event.clientY - bounds.top) / bounds.height - .5) * 2),
        )
        if (!mobile) root.dataset.interactionState = 'engaged'
      }
      const onPointerLeave = () => {
        pointerTarget.set(0, 0)
        if (!mobile) root.dataset.interactionState = 'settling'
      }
      const onScroll = () => {
        const bounds = root.getBoundingClientRect()
        scrollTarget = Math.min(Math.max(-bounds.top / Math.max(bounds.height * .82, 1), 0), 1)

        const now = performance.now()
        const currentScrollY = window.scrollY
        const deltaY = currentScrollY - previousScrollY
        const deltaMs = Math.max(12, Math.min(now - previousScrollAt, 80))
        // Normalise px/ms rather than raw scrollY so a quick finger flick gives
        // a stronger, short-lived push than a slow drag over the same distance.
        const velocity = (deltaY / deltaMs) / (mobile ? 1.25 : 1.8)
        scrollVelocityTarget = Math.max(-1, Math.min(1, velocity))
        previousScrollY = currentScrollY
        previousScrollAt = now
        if (Math.abs(deltaY) > .5) {
          lastScrollEventAt = now
          setScrollActive(true)
        }
      }

      const render = (time: number) => {
        const delta = time - previous
        if (delta < frameInterval) return
        previous = time - (delta % frameInterval)
        const seconds = time / 1000

        pointer.lerp(pointerTarget, mobile ? .035 : .048)
        scroll += (scrollTarget - scroll) * (mobile ? .075 : .045)
        scrollVelocity += (scrollVelocityTarget - scrollVelocity) * (mobile ? .16 : .09)
        scrollVelocityTarget *= mobile ? .86 : .82
        shaderUniforms.uTime.value = seconds

        const pointerX = mobile ? 0 : pointer.x
        const pointerY = mobile ? 0 : pointer.y
        const inertia = mobile ? scrollVelocity : scrollVelocity * .32
        const rotationDamping = mobile ? .085 : .04
        const targetRotationY = -.22 + pointerX * .29 + scroll * .38 + inertia * .24
        const targetRotationX = -.08 - pointerY * .18 - scroll * .13 - inertia * .13
        const targetRotationZ = .035 + Math.sin(seconds * .17) * .014 + inertia * .06
        sculpture.rotation.y += (targetRotationY - sculpture.rotation.y) * rotationDamping
        sculpture.rotation.x += (targetRotationX - sculpture.rotation.x) * rotationDamping
        sculpture.rotation.z += (targetRotationZ - sculpture.rotation.z) * (mobile ? .11 : .045)
        sculpture.position.x += ((pointerX * .06 + inertia * .045) - sculpture.position.x) * (mobile ? .075 : .038)
        sculpture.position.y += ((pointerY * .038 - scroll * .12 + inertia * .05) - sculpture.position.y) * (mobile ? .07 : .04)

        const pulse = 1 + Math.sin(seconds * .82) * .01 + Math.abs(inertia) * .012
        core.scale.setScalar(pulse)
        core.rotation.y += ((-scroll * .022 - inertia * .035) - core.rotation.y) * .035
        core.rotation.x += ((inertia * .018) - core.rotation.x) * .035
        core.position.x += ((pointerX * .032 + inertia * .012) - core.position.x) * .04
        core.position.y += ((pointerY * .022 + inertia * .018) - core.position.y) * .04
        coreOccluder.scale.setScalar(.965 * pulse)
        coreOccluder.rotation.copy(core.rotation)
        coreOccluder.position.copy(core.position)

        const apertureScale = 1 + Math.sin(seconds * .58) * .008 + Math.abs(inertia) * .018
        aperture.rotation.z += ((.18 + seconds * .032 - scroll * .32 - inertia * .18) - aperture.rotation.z) * (mobile ? .11 : .055)
        aperture.scale.setScalar(apertureScale)

        const shellTargetY = pointerX * .065 + scroll * .075 + inertia * .105
        const shellTargetX = -pointerY * .048 - scroll * .018 - inertia * .06
        shell.rotation.y += (shellTargetY - shell.rotation.y) * (mobile ? .072 : .055)
        shell.rotation.x += (shellTargetX - shell.rotation.x) * (mobile ? .07 : .052)

        const wireTargetY = pointerX * .1 + scroll * .11 + inertia * .16
        const wireTargetX = -pointerY * .072 - scroll * .028 - inertia * .09
        wireShell.rotation.y += (wireTargetY - wireShell.rotation.y) * (mobile ? .055 : .045)
        wireShell.rotation.x += (wireTargetX - wireShell.rotation.x) * (mobile ? .052 : .042)

        particles.rotation.y += ((seconds * .018 + pointerX * .1 + scroll * .16 + inertia * .19) - particles.rotation.y) * .07
        particles.rotation.x += ((-.08 + seconds * .009 - pointerY * .05 + inertia * .085) - particles.rotation.x) * .065
        particles.position.x += ((inertia * .035) - particles.position.x) * .06
        particles.position.y += ((inertia * .026) - particles.position.y) * .055

        orbits.forEach((orbit, index) => {
          const direction = index % 2 ? -1 : 1
          const base = orbitBases[index]
          const layer = 1 + index * .18
          const velocityLayer = 1 + index * .16
          const targetX = base.x - pointerY * .09 * layer + scroll * .09 * direction + inertia * .11 * velocityLayer
          const targetY = base.y + pointerX * .13 * layer + scroll * .13 * direction - inertia * .14 * direction * velocityLayer
          const targetZ = base.z + direction * seconds * (.018 + index * .004) * (mobile ? .68 : 1) + scroll * .2 * direction + inertia * .2 * velocityLayer
          const orbitDamping = mobile ? .1 - index * .008 : .065 - index * .004
          orbit.rotation.x += (targetX - orbit.rotation.x) * orbitDamping
          orbit.rotation.y += (targetY - orbit.rotation.y) * orbitDamping
          orbit.rotation.z += (targetZ - orbit.rotation.z) * orbitDamping
        })
        frames.forEach((frame, index) => {
          frame.position.y = frameBaseY[index] + Math.sin(seconds * .45 + index * 1.4) * .008 + inertia * (index % 2 ? -.018 : .018)
        })

        if (mobile) {
          const active = Math.abs(scrollVelocity) > .025 || time - lastScrollEventAt < 140
          setScrollActive(active)
        }

        renderer.render(scene, camera)
      }

      const syncLoop = () => {
        if (visible && !document.hidden) renderer.setAnimationLoop(render)
        else renderer.setAnimationLoop(null)
      }
      const onVisibilityChange = () => {
        previous = performance.now()
        syncLoop()
      }
      const onContextLost = (event: Event) => {
        event.preventDefault()
        root.dataset.renderMode = 'static'
        canvas.dataset.unavailable = 'true'
        renderer.setAnimationLoop(null)
      }

      const resizeObserver = new ResizeObserver(resize)
      const intersectionObserver = new IntersectionObserver((entries) => {
        visible = entries.some((entry) => entry.isIntersecting)
        previous = performance.now()
        syncLoop()
      }, { rootMargin: '20% 0px 20% 0px', threshold: .01 })

      resizeObserver.observe(canvas)
      intersectionObserver.observe(root)
      root.addEventListener('pointermove', onPointerMove, { passive: true })
      root.addEventListener('pointerleave', onPointerLeave)
      window.addEventListener('scroll', onScroll, { passive: true })
      document.addEventListener('visibilitychange', onVisibilityChange)
      canvas.addEventListener('webglcontextlost', onContextLost)

      resize()
      onScroll()
      root.dataset.renderMode = 'webgl'
      root.dataset.interactionMode = mobile ? 'scroll' : 'pointer'
      if (mobile) root.dataset.scrollActive = 'false'
      else root.dataset.interactionState = 'idle'
      canvas.dataset.ready = 'true'
      syncLoop()

      disposeScene = () => {
        renderer.setAnimationLoop(null)
        resizeObserver.disconnect()
        intersectionObserver.disconnect()
        root.removeEventListener('pointermove', onPointerMove)
        root.removeEventListener('pointerleave', onPointerLeave)
        window.removeEventListener('scroll', onScroll)
        document.removeEventListener('visibilitychange', onVisibilityChange)
        canvas.removeEventListener('webglcontextlost', onContextLost)

        shellGeometry.dispose()
        shellMaterial.dispose()
        wireMaterial.dispose()
        coreGeometry.dispose()
        coreMaterial.dispose()
        coreOccluderMaterial.dispose()
        apertureEdges.dispose()
        apertureMaterial.dispose()
        orbitMaterial.dispose()
        orbits.forEach((orbit) => orbit.geometry.dispose())
        particleGeometry.dispose()
        particleMaterial.dispose()
        frameMaterial.dispose()
        frames.forEach((frame) => frame.geometry.dispose())
        renderer.dispose()
      }
      }).catch(() => {
        root.dataset.renderMode = 'static'
        canvas.dataset.unavailable = 'true'
      })
    }, window.matchMedia('(max-width: 767px)').matches ? 900 : 650)

    return () => {
      disposed = true
      window.clearTimeout(startTimer)
      disposeScene?.()
    }
  }, [])

  return (
    <header className="memory-aperture" ref={rootRef}>
      <div className="memory-aperture-copy">
        <p className="eyebrow">PRIVATE ARCHIVE / 01</p>
        <h1 aria-label="时间留下的形状"><span aria-hidden="true">时间留下的</span><em aria-hidden="true">形状</em></h1>
        <p>让真实的拍摄时间，慢慢显影成值得重看的记忆。</p>
        <p className="memory-aperture-count" aria-label={`当前档案 ${count} 项`}><strong>{String(count).padStart(2, '0')}</strong><span>项记忆</span></p>
      </div>
      <div className="memory-aperture-stage" aria-hidden="true">
        <div className="memory-aperture-fallback">
          <i className="memory-fallback-core" />
          <i className="memory-fallback-ring ring-a" />
          <i className="memory-fallback-ring ring-b" />
          <i className="memory-fallback-ring ring-c" />
          <span className="memory-fallback-halo" />
          <span className="memory-fallback-node node-a" />
          <span className="memory-fallback-node node-b" />
          <span className="memory-fallback-node node-c" />
        </div>
        <canvas ref={canvasRef} />
        <span className="memory-aperture-axis axis-x" />
        <span className="memory-aperture-axis axis-y" />
      </div>
    </header>
  )
}
