import * as THREE from 'three';

export interface CameraPose {
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

const identityPose: CameraPose = {
  position: [0, 0, 0],
  quaternion: [0, 0, 0, 1],
};

const isMatrix3 = (r: number[][]): boolean =>
  Array.isArray(r) &&
  r.length === 3 &&
  r.every((row) => Array.isArray(row) && row.length === 3 && row.every(Number.isFinite));

const isVector3 = (t: number[]): boolean =>
  Array.isArray(t) && t.length === 3 && t.every(Number.isFinite);

export const extrinsicsToCameraPose = (
  r?: number[][],
  t?: number[],
  translationScale = 0.001,
): CameraPose => {
  if (!r || !t || !isMatrix3(r) || !isVector3(t)) return identityPose;

  const R = new THREE.Matrix3().set(
    r[0][0],
    r[0][1],
    r[0][2],
    r[1][0],
    r[1][1],
    r[1][2],
    r[2][0],
    r[2][1],
    r[2][2],
  );

  const Rt = R.clone().transpose();
  const T = new THREE.Vector3(t[0], t[1], t[2]);
  const C = T.applyMatrix3(Rt).multiplyScalar(-translationScale);

  const Rwc = new THREE.Matrix3().set(
    Rt.elements[0],
    Rt.elements[1],
    Rt.elements[2],
    Rt.elements[3],
    Rt.elements[4],
    Rt.elements[5],
    Rt.elements[6],
    Rt.elements[7],
    Rt.elements[8],
  );

  const Rwc4 = new THREE.Matrix4().set(
    Rwc.elements[0],
    Rwc.elements[3],
    Rwc.elements[6],
    0,
    Rwc.elements[1],
    Rwc.elements[4],
    Rwc.elements[7],
    0,
    Rwc.elements[2],
    Rwc.elements[5],
    Rwc.elements[8],
    0,
    0,
    0,
    0,
    1,
  );

  const q = new THREE.Quaternion().setFromRotationMatrix(Rwc4);
  return {
    position: [C.x, C.y, C.z],
    quaternion: [q.x, q.y, q.z, q.w],
  };
};
