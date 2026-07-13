#!/usr/bin/env python3
"""Headless validation of the walker policy against both generated robots.

Replicates the exact control pipeline the web app uses (PolicyRunner):
  - 200 Hz physics (dt=0.005), policy every 4 steps (50 Hz)
  - obs (99) = [base lin vel (base frame), base ang vel, projected gravity,
                29 joint pos rel. default, 29 joint vel, 29 last action,
                command (vx, vy, yaw rate)]
  - action (29): joint targets = default + action * action_scale, written to
    position actuators; arm slots are overridden by user-held targets
    (default pose unless user code moves them)
  - G1 Basic (23 DOF): the 6 slots that have no joint (waist roll/pitch,
    wrist pitch/yaw) read as "at default, zero velocity" and their actions
    are dropped

Checks: standing balance, walking displacement, turning, and that a hard
shove makes the robot fall (it's a real policy, not an animation).

Run:  python3 tools/validate_policy.py
"""

import json
import os

import mujoco
import numpy as np
import onnxruntime as ort

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "..", "public", "assets")
CONFIG = json.load(open(os.path.join(HERE, "vendor", "model_config.json")))

POLICY_JOINTS = CONFIG["joint_names"]  # 29 slots, training order
DEFAULT_POSE = np.array([CONFIG["default_joint_pos"][n] for n in POLICY_JOINTS],
                        dtype=np.float32)
ACTION_SCALE = np.array([CONFIG["action_scales"][n] for n in POLICY_JOINTS],
                        dtype=np.float32)
ARM_FRAGS = ("shoulder", "elbow", "wrist")
DECIMATION = 4


def quat_rotate_inv(q, v):
    w, xyz = q[0], q[1:4]
    t = np.cross(xyz, v) * 2
    return v - w * t + np.cross(xyz, t)


class Pipeline:
    def __init__(self, robot_xml, scene_xml="flat.xml"):
        robots = os.path.join(ASSETS, "robots")
        scene = open(os.path.join(ASSETS, "scenes", scene_xml)).read()
        # compose the same VFS layout the web app builds
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        os.symlink(os.path.join(ASSETS, "meshes"),
                   os.path.join(self.tmp.name, "meshes"))
        with open(os.path.join(self.tmp.name, "robot.xml"), "w") as f:
            f.write(open(os.path.join(robots, robot_xml)).read())
        with open(os.path.join(self.tmp.name, "scene.xml"), "w") as f:
            f.write(scene)
        self.model = mujoco.MjModel.from_xml_path(
            os.path.join(self.tmp.name, "scene.xml"))
        self.data = mujoco.MjData(self.model)

        sess = ort.SessionOptions()
        sess.intra_op_num_threads = 1
        self.policy = ort.InferenceSession(
            os.path.join(ASSETS, "policies", "walker.onnx"), sess,
            providers=["CPUExecutionProvider"])
        self.in_name = self.policy.get_inputs()[0].name

        # per-slot plumbing; missing joints (Basic) get qpos/qvel/act = -1
        self.qpos_adr = np.full(29, -1, dtype=int)
        self.qvel_adr = np.full(29, -1, dtype=int)
        self.act_id = np.full(29, -1, dtype=int)
        for i, name in enumerate(POLICY_JOINTS):
            jid = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_JOINT, name)
            if jid >= 0:
                self.qpos_adr[i] = self.model.jnt_qposadr[jid]
                self.qvel_adr[i] = self.model.jnt_dofadr[jid]
            self.act_id[i] = mujoco.mj_name2id(
                self.model, mujoco.mjtObj.mjOBJ_ACTUATOR, name)
        self.present = self.qpos_adr >= 0
        self.arm_slots = np.array(
            [any(f in n for f in ARM_FRAGS) for n in POLICY_JOINTS])
        self.reset()

    def reset(self):
        mujoco.mj_resetData(self.model, self.data)
        self.data.qpos[2] = 0.78
        self.data.qpos[3:7] = [1, 0, 0, 0]
        for i in range(29):
            if self.present[i]:
                self.data.qpos[self.qpos_adr[i]] = DEFAULT_POSE[i]
        mujoco.mj_forward(self.model, self.data)
        self.last_action = np.zeros(29, dtype=np.float32)
        self.cmd = np.zeros(3, dtype=np.float32)
        self.user_arm_targets = DEFAULT_POSE.copy()  # what robot.setJoint edits
        self.step_count = 0
        self.targets = DEFAULT_POSE.copy()

    def obs(self):
        q = self.data.qpos[3:7]
        lin_vel = quat_rotate_inv(q, self.data.qvel[:3])
        ang_vel = self.data.qvel[3:6].copy()
        grav = quat_rotate_inv(q, np.array([0.0, 0.0, -1.0]))
        jp = np.zeros(29, dtype=np.float32)
        jv = np.zeros(29, dtype=np.float32)
        for i in range(29):
            if self.present[i]:
                jp[i] = self.data.qpos[self.qpos_adr[i]] - DEFAULT_POSE[i]
                jv[i] = self.data.qvel[self.qvel_adr[i]]
        return np.concatenate([lin_vel, ang_vel, grav, jp, jv,
                               self.last_action, self.cmd]).astype(np.float32)

    def control_step(self):
        action = self.policy.run(None, {self.in_name: self.obs()[None]})[0][0]
        self.last_action = action.copy()
        targets = DEFAULT_POSE + action * ACTION_SCALE
        targets[self.arm_slots] = self.user_arm_targets[self.arm_slots]
        self.targets = targets

    def step(self, seconds):
        n = int(seconds / self.model.opt.timestep)
        for _ in range(n):
            if self.step_count % DECIMATION == 0:
                self.control_step()
            for i in range(29):
                if self.act_id[i] >= 0:
                    self.data.ctrl[self.act_id[i]] = self.targets[i]
            mujoco.mj_step(self.model, self.data)
            self.step_count += 1

    @property
    def base_z(self):
        return self.data.qpos[2]

    @property
    def base_xy(self):
        return self.data.qpos[:2].copy()

    @property
    def yaw(self):
        w, x, y, z = self.data.qpos[3:7]
        return np.arctan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))


def check(label, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {label} {detail}")
    return ok


def validate(robot_xml):
    print(f"\n=== {robot_xml} ===")
    p = Pipeline(robot_xml)
    ok = True

    p.step(4.0)
    ok &= check("stands 4s", p.base_z > 0.55, f"(z={p.base_z:.3f})")

    p.cmd[:] = [1.0, 0, 0]
    start = p.base_xy
    p.step(6.0)
    dist = p.base_xy - start
    ok &= check("walks fwd 1 m/s for 6s", dist[0] > 3.0 and p.base_z > 0.55,
                f"(dx={dist[0]:.2f}m dy={dist[1]:.2f}m z={p.base_z:.3f})")

    p.cmd[:] = [0, 0, 0.8]
    yaw0 = p.yaw
    p.step(2.0)
    ok &= check("turns left", (p.yaw - yaw0) % (2 * np.pi) > 0.5,
                f"(dyaw={(p.yaw - yaw0) % (2 * np.pi):.2f} rad)")

    p.cmd[:] = 0
    p.step(2.0)
    ok &= check("stands after walking", p.base_z > 0.55, f"(z={p.base_z:.3f})")

    # a hard shove must knock it over: this is physics, not animation
    body = mujoco.mj_name2id(p.model, mujoco.mjtObj.mjOBJ_BODY, "torso_link") \
        if robot_xml == "g1_basic.xml" else \
        mujoco.mj_name2id(p.model, mujoco.mjtObj.mjOBJ_BODY, "torso_link_rev_1_0")
    p.data.xfrc_applied[body, :3] = [900.0, 0, 0]
    p.step(0.25)
    p.data.xfrc_applied[body, :3] = 0
    p.step(3.0)
    ok &= check("falls when shoved (900 N, 0.25 s)", p.base_z < 0.45,
                f"(z={p.base_z:.3f})")
    return ok


if __name__ == "__main__":
    all_ok = validate("g1_edu_u6.xml") & validate("g1_basic.xml")
    print("\nALL PASS" if all_ok else "\nSOME CHECKS FAILED")
    raise SystemExit(0 if all_ok else 1)
