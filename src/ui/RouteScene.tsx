import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { Opportunity } from '../core/arbitrage'

export default function RouteScene({ opportunity }: { opportunity?: Opportunity }) {
  const host = useRef<HTMLDivElement>(null)
  const reset = useRef<(() => void) | null>(null)
  const [fallback, setFallback] = useState(false)
  const [selected, setSelected] = useState(0)
  const key = opportunity?.symbols.join(',')
  useEffect(() => {
    setSelected(0); setFallback(false)
    const element = host.current
    if (!element || !opportunity) return
    let renderer: THREE.WebGLRenderer
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }) }
    catch { setFallback(true); return }
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(42, 1, .1, 100)
    const restore = () => { camera.position.set(0, 2.3, 6); controls.target.set(0, 0, 0); controls.update(); draw() }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    element.appendChild(renderer.domElement)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enablePan = false; controls.minDistance = 3; controls.maxDistance = 10
    const points = [new THREE.Vector3(-1.6, -.8, 0), new THREE.Vector3(0, 1.2, -.4), new THREE.Vector3(1.6, -.8, 0)]
    const meshes: THREE.Mesh[] = []
    const resources: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = []
    points.forEach((point, index) => {
      const geometry = new THREE.SphereGeometry(.16, 24, 16)
      const material = new THREE.MeshBasicMaterial({ color: 0x638bd7 })
      const mesh = new THREE.Mesh(geometry, material); mesh.position.copy(point); mesh.userData.index = index
      scene.add(mesh); meshes.push(mesh); resources.push(geometry, material)
      const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 128
      const ctx = canvas.getContext('2d')!
      ctx.font = '500 44px sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#dce6f4'
      ctx.fillText(opportunity.route[index], 256, 78)
      const texture = new THREE.CanvasTexture(canvas)
      const labelMaterial = new THREE.SpriteMaterial({ map: texture, transparent: true })
      const label = new THREE.Sprite(labelMaterial); label.position.copy(point).add(new THREE.Vector3(0, .35, 0)); label.scale.set(1.5, .375, 1)
      scene.add(label); resources.push(texture, labelMaterial)
      const next = points[(index + 1) % 3]; const direction = next.clone().sub(point)
      const arrow = new THREE.ArrowHelper(direction.clone().normalize(), point.clone(), direction.length() - .2, 0x7891b5, .22, .13)
      scene.add(arrow)
      resources.push(arrow.line.geometry, arrow.line.material as THREE.Material, arrow.cone.geometry, arrow.cone.material as THREE.Material)
    })
    function draw() { renderer.render(scene, camera) }
    function resize() { const width = element!.clientWidth; renderer.setSize(width, 300); camera.aspect = width / 300; camera.updateProjectionMatrix(); draw() }
    const observer = new ResizeObserver(resize); observer.observe(element)
    const raycaster = new THREE.Raycaster()
    const pick = (event: PointerEvent) => {
      const bounds = renderer.domElement.getBoundingClientRect()
      raycaster.setFromCamera(new THREE.Vector2((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1), camera)
      const hit = raycaster.intersectObjects(meshes)[0]
      if (hit) setSelected(Number(hit.object.userData.index))
    }
    renderer.domElement.addEventListener('pointerup', pick)
    controls.addEventListener('change', draw); reset.current = restore; restore(); resize()
    return () => { reset.current = null; observer.disconnect(); controls.dispose(); renderer.domElement.removeEventListener('pointerup', pick); resources.forEach(resource => resource.dispose()); renderer.dispose(); renderer.domElement.remove() }
  }, [key])
  return <section className="route-scene panel"><div className="panel-heading"><div><h2>Ruta en perspectiva</h2><p>Mejor señal del laboratorio · no representa una operación ejecutada</p></div>{opportunity && !fallback && <button className="secondary-button" onClick={() => reset.current?.()}>Restablecer vista</button>}</div>
    {!opportunity ? <div className="scene-empty">No hay una ruta validada para visualizar. El escáner sigue evaluando según su estado.</div> : <><div ref={host} className="scene-host" aria-label={`Ruta 3D: ${opportunity.route.join(' a ')}`}/>{fallback && <p className="paper-note">Vista 3D no disponible en este navegador. Podés consultar todos los tramos debajo.</p>}<div className="route-steps" aria-label="Seleccionar tramo">{opportunity.symbols.map((symbol, index) => <button key={symbol} aria-pressed={selected === index} onClick={() => setSelected(index)}><small>Tramo {index + 1}</small><strong>{opportunity.route[index]} → {opportunity.route[index + 1]}</strong><span>{symbol}</span></button>)}</div><p className="scene-caption">{opportunity.symbols[selected]} · entrada del ciclo {opportunity.input.toFixed(4)} {opportunity.route[0]} · salida estimada {opportunity.output.toFixed(6)} {opportunity.route[0]} · neto {(opportunity.netBps / 100).toFixed(3)} %. Arrastrá para girar; usá la rueda para acercar.</p></>}
  </section>
}
