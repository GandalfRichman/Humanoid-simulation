import type { RobotId, RobotInfo, SceneId } from "./types";

export const ROBOTS: Record<RobotId, RobotInfo> = {
  g1_basic: {
    id: "g1_basic",
    label: "G1 Basic",
    tagline: "23 DOF · fixed hands",
    dof: 23,
    hands: "Fixed rubber hands (non-articulated)",
    details: [
      "12 leg joints: hip pitch/roll/yaw, knee, ankle pitch/roll per leg",
      "10 arm joints: shoulder pitch/roll/yaw, elbow, wrist roll per arm",
      "1 waist yaw joint",
      "Model: official Unitree g1_23dof_rev_1_0 MJCF",
    ],
  },
  g1_edu_u6: {
    id: "g1_edu_u6",
    label: "G1 EDU U6",
    tagline: "41 DOF · Inspire RH56 hands",
    dof: 41,
    hands: "Inspire RH56DFTP five-finger hands (6 DOF / 12 joints each)",
    details: [
      "12 leg joints, 3 waist joints (yaw/roll/pitch)",
      "14 arm joints: adds wrist pitch + wrist yaw per arm",
      "2× Inspire RH56DFTP hands with coupled finger linkages and fingertip touch sensors",
      "Model: Unitree g1_29dof_rev_1_0 + Inspire FTP hand (converted from official URDF)",
    ],
  },
};

export const SCENES: Record<SceneId, { label: string; blurb: string }> = {
  flat: { label: "Open floor", blurb: "Endless flat ground — locomotion basics" },
  table: { label: "Table + block", blurb: "A table with a red cylinder to walk to and grab" },
  obstacles: { label: "Obstacle yard", blurb: "Steps, a ramp, a beam and loose props" },
};

export const ASSET_BASE = "/assets";

export const robotXmlUrl = (id: RobotId) => `${ASSET_BASE}/robots/${id}.xml`;
export const sceneXmlUrl = (id: SceneId) => `${ASSET_BASE}/scenes/${id}.xml`;
export const meshUrl = (file: string) => `${ASSET_BASE}/meshes/${file}`;
export const POLICY_URLS = {
  model: `${ASSET_BASE}/policies/walker.onnx`,
  data: `${ASSET_BASE}/policies/walker.onnx.data`,
  meta: `${ASSET_BASE}/policies/walker.meta.json`,
};
