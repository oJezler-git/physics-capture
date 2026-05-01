import { useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { Grid, Line, OrbitControls } from '@react-three/drei';
import type { BallResult, Point3D, Reconstruction3D } from '../types';

interface ThreeDSceneProps {
  balls: BallResult[];
  currentFrame: number;
  reconstruction3d?: Reconstruction3D;
}

const BALL_COLORS = ['#10b981', '#3b82f6', '#f43f5e'];

const framePoint = (points: Point3D[] | undefined, frameIdx: number) =>
  points?.find((point) => point.frameIdx === frameIdx) ?? null;

const phoneRotationFromR = (rotation: number[][] | undefined): [number, number, number] => {
  if (!rotation || rotation.length < 3) return [0, 0, 0];
  const yaw = Math.atan2(rotation[1][0] ?? 0, rotation[0][0] ?? 1);
  const pitch = Math.atan2(
    -(rotation[2][0] ?? 0),
    Math.hypot(rotation[2][1] ?? 0, rotation[2][2] ?? 1),
  );
  const roll = Math.atan2(rotation[2][1] ?? 0, rotation[2][2] ?? 1);
  return [pitch, yaw, roll];
};

export const ThreeDScene = ({ balls, currentFrame, reconstruction3d }: ThreeDSceneProps) => {
  const phone1Position = useMemo(() => {
    const t = reconstruction3d?.stereoExtrinsics?.T;
    if (!t || t.length < 3) return [0.3, 0, 0] as [number, number, number];
    return [Number(t[0]) / 1000, Number(t[1]) / 1000, Number(t[2]) / 1000] as [
      number,
      number,
      number,
    ];
  }, [reconstruction3d?.stereoExtrinsics?.T]);

  const phone1Rotation = useMemo(
    () => phoneRotationFromR(reconstruction3d?.stereoExtrinsics?.R),
    [reconstruction3d?.stereoExtrinsics?.R],
  );

  return (
    <div className="surface-panel p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400">
          3D Reconstruction
        </h3>
        <span className="ui-pill text-[9px]">
          {reconstruction3d?.mode ?? 'SINGLE_CAMERA_PLANAR'}
        </span>
      </div>
      <div className="h-[380px] w-full overflow-hidden rounded-xl border border-[var(--line)] bg-[#0b1220]">
        <Canvas camera={{ position: [1.2, 1.0, 1.5], fov: 45 }}>
          <ambientLight intensity={0.6} />
          <directionalLight position={[2, 3, 1]} intensity={1.2} />
          <Grid args={[10, 10]} cellColor="#203047" sectionColor="#304c6e" fadeDistance={12} />
          <mesh position={[0, 0.04, 0]}>
            <boxGeometry args={[0.07, 0.14, 0.01]} />
            <meshStandardMaterial color="#e2e8f0" />
          </mesh>
          <mesh position={phone1Position} rotation={phone1Rotation}>
            <boxGeometry args={[0.07, 0.14, 0.01]} />
            <meshStandardMaterial color="#94a3b8" />
          </mesh>
          <Line points={[[0, 0.04, 0], phone1Position]} color="#64748b" lineWidth={1} dashed />
          {balls.map((ball) => {
            const point = framePoint(ball.trajectory3d, currentFrame);
            const trail = (ball.trajectory3d ?? []).map(
              (p) => [p.x, p.y, p.z] as [number, number, number],
            );
            return (
              <group key={`ball-3d-${ball.ballId}`}>
                {trail.length >= 2 && (
                  <Line
                    points={trail}
                    color={BALL_COLORS[ball.ballId % BALL_COLORS.length]}
                    lineWidth={1}
                  />
                )}
                {point && (
                  <mesh position={[point.x, point.y, point.z]}>
                    <sphereGeometry args={[0.02, 24, 24]} />
                    <meshStandardMaterial
                      color={
                        point.flagged ? '#ef4444' : BALL_COLORS[ball.ballId % BALL_COLORS.length]
                      }
                      emissive={point.flagged ? '#7f1d1d' : '#000000'}
                    />
                  </mesh>
                )}
                {point && (
                  <mesh position={[point.x, point.y, point.z]}>
                    <sphereGeometry
                      args={[Math.max(point.x_unc, point.y_unc, point.z_unc), 16, 16]}
                    />
                    <meshStandardMaterial color="#e2e8f0" transparent opacity={0.15} />
                  </mesh>
                )}
              </group>
            );
          })}
          <OrbitControls makeDefault />
        </Canvas>
      </div>
    </div>
  );
};
