import { Canvas, useFrame, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { simClient } from "../engine/SimClient";
import { useStore } from "../state/store";
import {
  GEOM_BOX, GEOM_CAPSULE, GEOM_CYLINDER, GEOM_ELLIPSOID, GEOM_MESH, GEOM_PLANE, GEOM_SPHERE,
} from "../lib/types";
import type { GeomSpec, SceneSpec } from "../lib/types";

/* ------------------------------------------------------------------ */
/* Geometry construction                                               */
/* ------------------------------------------------------------------ */

const Z_UP_FIX = new THREE.Matrix4().makeRotationX(Math.PI / 2);

function geomGeometry(g: GeomSpec, spec: SceneSpec): THREE.BufferGeometry | null {
  switch (g.type) {
    case GEOM_PLANE:
      return null; // rendered separately as the ground
    case GEOM_SPHERE:
      return new THREE.SphereGeometry(g.size[0], 24, 16);
    case GEOM_CAPSULE: {
      const geo = new THREE.CapsuleGeometry(g.size[0], g.size[1] * 2, 6, 16);
      geo.applyMatrix4(Z_UP_FIX); // MuJoCo capsule axis is Z, three's is Y
      return geo;
    }
    case GEOM_ELLIPSOID: {
      const geo = new THREE.SphereGeometry(1, 24, 16);
      geo.scale(g.size[0], g.size[1], g.size[2]);
      return geo;
    }
    case GEOM_CYLINDER: {
      const geo = new THREE.CylinderGeometry(g.size[0], g.size[0], g.size[1] * 2, 24);
      geo.applyMatrix4(Z_UP_FIX);
      return geo;
    }
    case GEOM_BOX:
      return new THREE.BoxGeometry(g.size[0] * 2, g.size[1] * 2, g.size[2] * 2);
    case GEOM_MESH: {
      const mesh = spec.meshes.find((m) => m.id === g.meshId);
      if (!mesh) return null;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(mesh.vertices, 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
      geo.setIndex(new THREE.BufferAttribute(mesh.faces, 1));
      return geo;
    }
    default:
      return null;
  }
}

interface BuiltScene {
  root: THREE.Group;
  bodyGroups: THREE.Group[];
  collisionMeshes: THREE.Object3D[];
  bodyMeshes: Map<number, THREE.Mesh[]>;
}

function buildScene(spec: SceneSpec): BuiltScene {
  const root = new THREE.Group();
  const bodyGroups: THREE.Group[] = [];
  const collisionMeshes: THREE.Object3D[] = [];
  const bodyMeshes = new Map<number, THREE.Mesh[]>();

  for (let b = 0; b < spec.nbody; b++) {
    const group = new THREE.Group();
    group.name = spec.bodies[b]?.name ?? `body_${b}`;
    bodyGroups.push(group);
    root.add(group);
  }

  for (const g of spec.geoms) {
    if (g.type === GEOM_PLANE) continue;
    const isCollision = g.group === 3;
    const geometry = geomGeometry(g, spec);
    if (!geometry) continue;
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(g.rgba[0], g.rgba[1], g.rgba[2]),
      roughness: 0.55,
      metalness: 0.25,
      transparent: isCollision || g.rgba[3] < 0.999,
      opacity: isCollision ? 0.3 : g.rgba[3],
    });
    if (isCollision) {
      material.color.set("#3ddc84");
      material.depthWrite = false;
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(g.pos[0], g.pos[1], g.pos[2]);
    mesh.quaternion.set(g.quat[1], g.quat[2], g.quat[3], g.quat[0]);
    mesh.castShadow = !isCollision;
    mesh.receiveShadow = !isCollision;
    mesh.userData.bodyId = g.bodyId;
    mesh.userData.collision = isCollision;
    mesh.visible = !isCollision;
    if (isCollision) collisionMeshes.push(mesh);
    else {
      const list = bodyMeshes.get(g.bodyId) ?? [];
      list.push(mesh);
      bodyMeshes.set(g.bodyId, list);
    }
    bodyGroups[g.bodyId].add(mesh);
  }

  return { root, bodyGroups, collisionMeshes, bodyMeshes };
}

/* ------------------------------------------------------------------ */
/* Live robot                                                          */
/* ------------------------------------------------------------------ */

function LiveScene({ spec }: { spec: SceneSpec }) {
  const built = useMemo(() => buildScene(spec), [spec]);
  const showCollision = useStore((s) => s.showCollision);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const followRef = useRef(true);

  useEffect(() => {
    for (const m of built.collisionMeshes) m.visible = showCollision;
  }, [built, showCollision]);

  // highlight the selected body's meshes
  useEffect(() => {
    const selectedBody =
      selection?.kind === "body"
        ? spec.bodies.find((b) => b.name === selection.name)?.id
        : selection?.kind === "joint"
          ? spec.joints.find((j) => j.name === selection.name)?.bodyId
          : undefined;
    for (const [bodyId, meshes] of built.bodyMeshes) {
      for (const mesh of meshes) {
        const mat = mesh.material as THREE.MeshStandardMaterial;
        if (bodyId === selectedBody) {
          mat.emissive.set("#38bdf8");
          mat.emissiveIntensity = 0.55;
        } else {
          mat.emissiveIntensity = 0;
        }
      }
    }
  }, [built, selection, spec]);

  useFrame(() => {
    const frame = simClient.readFrame();
    if (!frame) return;
    const { xpos, xquat } = frame;
    for (let b = 1; b < spec.nbody; b++) {
      const g = built.bodyGroups[b];
      g.position.set(xpos[b * 3], xpos[b * 3 + 1], xpos[b * 3 + 2]);
      g.quaternion.set(xquat[b * 4 + 1], xquat[b * 4 + 2], xquat[b * 4 + 3], xquat[b * 4]);
    }
    // gentle follow: keep the orbit target near the robot's pelvis
    const controls = controlsRef.current;
    if (controls && followRef.current) {
      const px = xpos[3], py = xpos[4];
      controls.target.x += (px - controls.target.x) * 0.04;
      controls.target.y += (py - controls.target.y) * 0.04;
      controls.target.z += (0.72 - controls.target.z) * 0.04;
      controls.update();
    }
  });

  const onPick = (ev: ThreeEvent<MouseEvent>) => {
    ev.stopPropagation();
    const bodyId = ev.object.userData.bodyId as number | undefined;
    if (bodyId === undefined || bodyId === 0) return;
    const body = spec.bodies[bodyId];
    const joint = spec.joints.find((j) => j.bodyId === bodyId);
    select(joint ? { kind: "joint", name: joint.name } : { kind: "body", name: body.name });
  };

  return (
    <>
      {/* eslint-disable-next-line react/no-unknown-property */}
      <primitive object={built.root} onClick={onPick} />
      <OrbitControls
        ref={controlsRef}
        makeDefault
        target={[0, 0, 0.72]}
        maxPolarAngle={Math.PI * 0.55}
        minDistance={0.6}
        maxDistance={14}
        enableDamping
        onStart={() => { followRef.current = false; }}
        onEnd={() => { followRef.current = true; }}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Ground + atmosphere                                                 */
/* ------------------------------------------------------------------ */

function Ground() {
  const gridTexture = useMemo(() => {
    const size = 512;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#23272f";
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = "#3a4150";
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, size, size);
    ctx.strokeStyle = "#2c313c";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath(); ctx.moveTo((size / 4) * i, 0); ctx.lineTo((size / 4) * i, size); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, (size / 4) * i); ctx.lineTo(size, (size / 4) * i); ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(40, 40);
    tex.anisotropy = 8;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);

  return (
    <mesh receiveShadow position={[0, 0, -0.002]}>
      {/* eslint-disable-next-line react/no-unknown-property */}
      <planeGeometry args={[80, 80]} />
      <meshStandardMaterial map={gridTexture} roughness={0.92} metalness={0} />
    </mesh>
  );
}

/* ------------------------------------------------------------------ */
/* Viewport                                                            */
/* ------------------------------------------------------------------ */

export function Viewport() {
  const spec = useStore((s) => s.spec);
  const select = useStore((s) => s.select);
  const [dpr] = useState<[number, number]>([1, 2]);

  return (
    <Canvas
      shadows
      dpr={dpr}
      camera={{ position: [2.8, -2.4, 1.7], fov: 42, near: 0.05, far: 120 }}
      onCreated={({ camera, scene }) => {
        camera.up.set(0, 0, 1);
        scene.background = new THREE.Color("#171a21");
        scene.fog = new THREE.Fog("#171a21", 18, 60);
      }}
      onPointerMissed={() => select(null)}
    >
      {/* eslint-disable-next-line react/no-unknown-property */}
      <hemisphereLight args={["#c8d5ff", "#33393f", 0.5]} />
      <directionalLight
        castShadow
        position={[4, -3, 6]}
        intensity={2.2}
        shadow-mapSize={[2048, 2048]}
        shadow-camera-near={1}
        shadow-camera-far={20}
        shadow-camera-left={-5}
        shadow-camera-right={5}
        shadow-camera-top={5}
        shadow-camera-bottom={-5}
        shadow-bias={-0.0002}
      />
      <directionalLight position={[-3, 4, 3]} intensity={0.5} />
      <Ground />
      {spec && <LiveScene spec={spec} />}
    </Canvas>
  );
}
