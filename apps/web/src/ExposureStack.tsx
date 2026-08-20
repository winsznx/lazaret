import { Edges } from "@react-three/drei"
import { Canvas, useFrame } from "@react-three/fiber"
import { useReducedMotion } from "framer-motion"
import { useEffect, useMemo, useRef } from "react"
import * as THREE from "three"

const PLANES = 6
const PER_PLANE = 44
const GREY = new THREE.Color("#cfcfd4")
const EMBER = new THREE.Color("#ff5a00")

interface PointDatum {
  position: THREE.Vector3
  activation: number
  isRoot: boolean
}

function planeY(depth: number): number {
  return (2.5 - depth) * 0.62
}

function ExposurePoints(): JSX.Element {
  const meshRef = useRef<THREE.InstancedMesh>(null)
  const start = useRef(performance.now())

  const data = useMemo<PointDatum[]>(() => {
    const points: PointDatum[] = []
    for (let depth = 0; depth < PLANES; depth += 1) {
      for (let i = 0; i < PER_PLANE; i += 1) {
        points.push({
          position: new THREE.Vector3(
            (Math.random() - 0.5) * 3.7,
            planeY(depth) + (Math.random() - 0.5) * 0.06,
            (Math.random() - 0.5) * 2.7,
          ),
          activation: (depth / (PLANES - 1)) * 0.72 + Math.random() * 0.28,
          isRoot: depth === 0,
        })
      }
    }
    return points
  }, [])

  useEffect(() => {
    const mesh = meshRef.current
    if (mesh === null) return
    const dummy = new THREE.Object3D()
    data.forEach((point, index) => {
      dummy.position.copy(point.position)
      dummy.scale.setScalar(point.isRoot ? 1.5 : 1)
      dummy.updateMatrix()
      mesh.setMatrixAt(index, dummy.matrix)
      mesh.setColorAt(index, GREY)
    })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true
  }, [data])

  useFrame(() => {
    const mesh = meshRef.current
    if (mesh === null) return
    const elapsed = (performance.now() - start.current) / 1000
    const wave = Math.min(elapsed / 3.4, 1)
    data.forEach((point, index) => {
      const exposed = point.isRoot || wave >= point.activation
      mesh.setColorAt(index, exposed ? EMBER : GREY)
    })
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true
  })

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, PLANES * PER_PLANE]}>
      <sphereGeometry args={[0.045, 10, 10]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  )
}

function Planes(): JSX.Element {
  return (
    <>
      {Array.from({ length: PLANES }, (_unused, depth) => (
        <mesh key={depth} position={[0, planeY(depth), 0]}>
          <boxGeometry args={[4, 0.012, 3]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.34} toneMapped={false} />
          <Edges color="#09090b" threshold={15} />
        </mesh>
      ))}
    </>
  )
}

function Scene(): JSX.Element {
  const group = useRef<THREE.Group>(null)
  useFrame((state) => {
    const g = group.current
    if (g === null) return
    g.rotation.y += (state.pointer.x * 0.3 - g.rotation.y) * 0.05
    g.rotation.x += (0.32 - state.pointer.y * 0.12 - g.rotation.x) * 0.05
  })
  return (
    <group ref={group} rotation={[0.32, 0, 0]}>
      <Planes />
      <ExposurePoints />
    </group>
  )
}

function StaticFallback(): JSX.Element {
  const rows = Array.from({ length: PLANES }, (_unused, depth) => depth)
  return (
    <svg viewBox="0 0 400 340" width="100%" role="img" aria-label="Exposure stack">
      {rows.map((depth) => {
        const y = 40 + depth * 48
        return (
          <g key={depth}>
            <rect
              x={40}
              y={y}
              width={320}
              height={30}
              rx={8}
              fill="#ffffff"
              stroke="#09090b"
              strokeWidth={1}
            />
            {Array.from({ length: 18 }, (_u, i) => {
              const exposed = i / 18 <= 1 - depth / PLANES
              return (
                <circle
                  key={i}
                  cx={54 + i * 17}
                  cy={y + 15}
                  r={3}
                  fill={depth === 0 || exposed ? "#ff5a00" : "#cfcfd4"}
                />
              )
            })}
          </g>
        )
      })}
    </svg>
  )
}

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas")
    return (
      typeof WebGLRenderingContext !== "undefined" &&
      (canvas.getContext("webgl") !== null || canvas.getContext("experimental-webgl") !== null)
    )
  } catch {
    return false
  }
}

export function ExposureStack(): JSX.Element {
  const reduced = useReducedMotion()
  if (reduced === true || !webglAvailable()) {
    return (
      <div style={{ width: "100%", height: "100%", display: "grid", placeItems: "center" }}>
        <StaticFallback />
      </div>
    )
  }
  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ position: [0, 0.4, 6], fov: 42 }}
      style={{ width: "100%", height: "100%" }}
      gl={{ antialias: true, alpha: true }}
    >
      <Scene />
    </Canvas>
  )
}
