import { useRef, useState, useMemo } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Grid, Line, OrbitControls, Environment, ContactShadows, Text } from '@react-three/drei';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import * as THREE from 'three';
import type { BallResult, Point3D, Reconstruction3D } from '../types';
import { extrinsicsToCameraPose } from '../lib/cameraPose';

interface ThreeDSceneProps {
  balls: BallResult[];
  currentFrame: number;
  reconstruction3d?: Reconstruction3D;
  followBallId?: number | null;
}

const BALL_COLORS = ['#10b981', '#3b82f6', '#f43f5e'];
const CAMERA_FORWARD_Z = 0.18;
const CAMERA_HALF_W = 0.08;
const CAMERA_HALF_H = 0.05;

const framePoint = (points: Point3D[] | undefined, frameIdx: number) =>
  points?.find((point) => point.frameIdx === frameIdx) ?? null;

type CameraMode = 'off' | 'track' | 'follow';

const CameraRig = ({
  label,
  color,
  position,
  quaternion,
}: {
  label: string;
  color: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
}) => {
  const frustumPoints = useMemo(() => {
    const near = new THREE.Vector3(0, 0, 0);
    const p1 = new THREE.Vector3(-CAMERA_HALF_W, CAMERA_HALF_H, CAMERA_FORWARD_Z);
    const p2 = new THREE.Vector3(CAMERA_HALF_W, CAMERA_HALF_H, CAMERA_FORWARD_Z);
    const p3 = new THREE.Vector3(CAMERA_HALF_W, -CAMERA_HALF_H, CAMERA_FORWARD_Z);
    const p4 = new THREE.Vector3(-CAMERA_HALF_W, -CAMERA_HALF_H, CAMERA_FORWARD_Z);
    const edges: [number, number, number][][] = [
      [near.toArray() as [number, number, number], p1.toArray() as [number, number, number]],
      [near.toArray() as [number, number, number], p2.toArray() as [number, number, number]],
      [near.toArray() as [number, number, number], p3.toArray() as [number, number, number]],
      [near.toArray() as [number, number, number], p4.toArray() as [number, number, number]],
      [p1.toArray() as [number, number, number], p2.toArray() as [number, number, number]],
      [p2.toArray() as [number, number, number], p3.toArray() as [number, number, number]],
      [p3.toArray() as [number, number, number], p4.toArray() as [number, number, number]],
      [p4.toArray() as [number, number, number], p1.toArray() as [number, number, number]],
    ];
    return edges;
  }, []);

  return (
    <group position={position} quaternion={quaternion}>
      <mesh castShadow>
        <boxGeometry args={[0.06, 0.035, 0.02]} />
        <meshStandardMaterial color={color} metalness={0.4} roughness={0.3} />
      </mesh>
      {frustumPoints.map((segment, idx) => (
        <Line key={`${label}-frustum-${idx}`} points={segment} color={color} lineWidth={1} />
      ))}
      <Text
        position={[0, 0.06, 0]}
        fontSize={0.03}
        color={color}
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.004}
        outlineColor="#000000"
      >
        {label}
      </Text>
    </group>
  );
};

const TrailRenderer = ({ ball, currentFrame }: { ball: BallResult; currentFrame: number }) => {
  const trail = useMemo(
    () => (ball.trajectory3d ?? []).map((p) => [p.x, p.y, p.z] as [number, number, number]),
    [ball.trajectory3d],
  );

  const point = framePoint(ball.trajectory3d, currentFrame);
  const visibleTrail = trail.slice(0, currentFrame + 1);

  if (!point) return null;

  return (
    <group key={`ball-3d-${ball.ballId}`}>
      <Line
        points={visibleTrail}
        color={BALL_COLORS[ball.ballId % BALL_COLORS.length]}
        lineWidth={2}
        transparent
        opacity={0.6}
      />

      <group>
        <Line
          points={[
            [point.x, point.y, point.z],
            [point.x, 0, point.z],
          ]}
          color="#94a3b8"
          lineWidth={1}
          transparent
          opacity={0.3}
          dashed
        />
        <Line
          points={[
            [point.x - 0.05, 0, point.z],
            [point.x + 0.05, 0, point.z],
          ]}
          color="#38bdf8"
          lineWidth={1}
          transparent
          opacity={0.5}
        />
        <Line
          points={[
            [point.x, 0, point.z - 0.05],
            [point.x, 0, point.z + 0.05],
          ]}
          color="#38bdf8"
          lineWidth={1}
          transparent
          opacity={0.5}
        />

        <mesh position={[point.x, point.y, point.z]} castShadow>
          <sphereGeometry args={[0.02, 32, 32]} />
          <meshStandardMaterial
            color={point.flagged ? '#ef4444' : BALL_COLORS[ball.ballId % BALL_COLORS.length]}
            emissive={point.flagged ? '#7f1d1d' : '#000000'}
            metalness={0.1}
            roughness={0.3}
          />
        </mesh>
        <Text
          position={[point.x, point.y + 0.05, point.z]}
          fontSize={0.03}
          color="white"
          anchorX="center"
          anchorY="bottom"
          outlineWidth={0.005}
          outlineColor="#000000"
        >
          BALL {ball.ballId + 1}
        </Text>
      </group>
    </group>
  );
};

const SceneContent = ({
  mode,
  targetVec,
  balls,
  currentFrame,
  phone1Position,
  phone1Quaternion,
}: {
  mode: CameraMode;
  targetVec: THREE.Vector3 | null;
  balls: BallResult[];
  currentFrame: number;
  phone1Position: [number, number, number];
  phone1Quaternion: [number, number, number, number];
}) => {
  const { camera } = useThree();
  const controlsRef = useRef<any>(null);
  const offset = useMemo(() => new THREE.Vector3(0.3, 0.4, 0.3), []);

  useFrame((_, delta) => {
    if (!targetVec) return;
    if (mode === 'track' && controlsRef.current) {
      controlsRef.current.target.lerp(targetVec, Math.min(1, delta * 10));
      controlsRef.current.update();
    } else if (mode === 'follow') {
      const targetCameraPos = targetVec.clone().add(offset);
      camera.position.lerp(targetCameraPos, Math.min(1, delta * 5));
    }
  });

  return (
    <>
      <Environment preset="studio" />
      <ambientLight intensity={0.4} />
      <directionalLight position={[2, 3, 1]} intensity={0.8} castShadow />
      <Grid args={[10, 10]} cellColor="#203047" sectionColor="#304c6e" fadeDistance={12} />
      <ContactShadows resolution={1024} scale={10} blur={2} opacity={0.5} far={1} color="#000000" />
      <CameraRig label="CAM 0" color="#e2e8f0" position={[0, 0, 0]} quaternion={[0, 0, 0, 1]} />
      <CameraRig
        label="CAM 1"
        color="#94a3b8"
        position={phone1Position}
        quaternion={phone1Quaternion}
      />
      <Line points={[[0, 0, 0], phone1Position]} color="#64748b" lineWidth={1} dashed />
      {balls.map((ball) => (
        <TrailRenderer key={`ball-3d-${ball.ballId}`} ball={ball} currentFrame={currentFrame} />
      ))}
      <EffectComposer>
        <Bloom luminanceThreshold={0.5} mipmapBlur intensity={0.25} />
      </EffectComposer>
      <OrbitControls
        ref={controlsRef}
        makeDefault
        enableRotate={mode !== 'follow'}
        enablePan={mode !== 'follow'}
        enableZoom={true}
      />{' '}
    </>
  );
};

export const ThreeDScene = ({
  balls,
  currentFrame,
  reconstruction3d,
  followBallId = null,
}: ThreeDSceneProps) => {
  const [cameraMode, setCameraMode] = useState<CameraMode>('off');
  const targetBall =
    followBallId !== null ? balls.find((b) => b.ballId === followBallId) : balls[0];
  const currentPos = targetBall ? framePoint(targetBall.trajectory3d, currentFrame) : null;
  const targetVec = currentPos ? new THREE.Vector3(currentPos.x, currentPos.y, currentPos.z) : null;

  const phonePose = useMemo(
    () =>
      extrinsicsToCameraPose(
        reconstruction3d?.stereoExtrinsics?.R,
        reconstruction3d?.stereoExtrinsics?.T,
      ),
    [reconstruction3d?.stereoExtrinsics?.R, reconstruction3d?.stereoExtrinsics?.T],
  );

  return (
    <div className="surface-panel p-4 h-full flex flex-col">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400">
          3D Reconstruction
        </h3>
        <button
          onClick={() => {
            const modes: CameraMode[] = ['off', 'track', 'follow'];
            setCameraMode(modes[(modes.indexOf(cameraMode) + 1) % modes.length]);
          }}
          className="text-[10px] bg-slate-800 px-2 py-1 rounded"
        >
          MODE: {cameraMode.toUpperCase()}
        </button>
      </div>
      <div className="flex-1 overflow-hidden rounded-xl border border-[var(--line)] bg-[#0b1220]">
        <Canvas shadows={{ type: 1 }} camera={{ position: [1.2, 1.0, 1.5], fov: 45 }}>
          <SceneContent
            mode={cameraMode}
            targetVec={targetVec}
            balls={balls}
            currentFrame={currentFrame}
            phone1Position={phonePose.position}
            phone1Quaternion={phonePose.quaternion}
          />
        </Canvas>
      </div>
    </div>
  );
};
