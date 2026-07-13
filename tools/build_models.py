#!/usr/bin/env python3
"""Generate the two production robot MJCFs from vendored sources.

Outputs (into ../public/assets/robots):
  g1_basic.xml    - Unitree G1 Basic, 23 DOF, fixed rubber hands.
                    Kinematics/inertia/joint limits from Unitree's official
                    g1_23dof_rev_1_0.xml; physics setup (position actuators
                    with PD gains, armature, capsule collision scheme, IMU
                    sites/sensors, solver options) ported from the
                    walker-policy-matched 29-DOF model so the shared
                    locomotion policy transfers.
  g1_edu_u6.xml   - Unitree G1 EDU U6, 41 actuated DOF: the policy-matched
                    29-DOF body plus two Inspire RH56DFTP five-finger hands
                    (6 DOF / 12 joints per hand, coupled joints modelled as
                    MuJoCo equality constraints, fingertip touch sensors).

Sources (tools/vendor):
  lucky_g1_29dof.xml        - 29-DOF G1 matched to walker.onnx (luckyrobots
                              g1-manipulation-challenge). Dex-3 hands are
                              stripped and replaced here.
  g1_23dof_rev_1_0.xml      - official Unitree G1 23-DOF MJCF (unitree_ros).
  inspire_ftp_converted.xml - MuJoCo-converted g1_29dof_rev_1_0_with_
                              inspire_hand_FTP.urdf (unitree_ros), the source
                              of the Inspire hand subtrees.

Run:  python3 tools/build_models.py
"""

import copy
import os
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
VENDOR = os.path.join(HERE, "vendor")
OUT = os.path.join(HERE, "..", "public", "assets", "robots")

# ---------------------------------------------------------------------------
# Shared physics constants (must match walker.onnx training setup)
# ---------------------------------------------------------------------------

# armature by joint name fragment (from the policy-matched model)
ARMATURE = [
    ("wrist_pitch", 0.00425), ("wrist_yaw", 0.00425),
    ("hip_roll", 0.02510), ("knee", 0.02510),
    ("hip_pitch", 0.01018), ("hip_yaw", 0.01018), ("waist_yaw", 0.01018),
    ("ankle", 0.00722), ("waist_roll", 0.00722), ("waist_pitch", 0.00722),
    ("shoulder", 0.00361), ("elbow", 0.00361), ("wrist_roll", 0.00361),
]

# position-actuator PD gains by joint name fragment (order matters)
PD_GAINS = [
    ("hip_roll", (99.098, 6.309)), ("knee", (99.098, 6.309)),
    ("hip_pitch", (40.179, 2.558)), ("hip_yaw", (40.179, 2.558)),
    ("waist_yaw", (40.179, 2.558)),
    ("ankle", (28.501, 1.814)), ("waist_roll", (28.501, 1.814)),
    ("waist_pitch", (28.501, 1.814)),
    ("wrist_pitch", (16.778, 1.068)), ("wrist_yaw", (16.778, 1.068)),
    ("shoulder", (14.251, 0.907)), ("elbow", (14.251, 0.907)),
    ("wrist_roll", (14.251, 0.907)),
]

SIM_OPTION = dict(
    integrator="implicitfast", timestep="0.005", impratio="1.0",
    cone="pyramidal", jacobian="auto", solver="Newton", iterations="10",
    tolerance="1e-08", ls_iterations="20", ls_tolerance="0.01",
    gravity="0 0 -9.81",
)


def lookup(table, joint_name):
    for frag, val in table:
        if frag in joint_name:
            return val
    raise KeyError(joint_name)


def indent(elem, level=0):
    pad = "\n" + level * "  "
    if len(elem):
        if not elem.text or not elem.text.strip():
            elem.text = pad + "  "
        for child in elem:
            indent(child, level + 1)
            if not child.tail or not child.tail.strip():
                child.tail = pad + "  "
        if not elem[-1].tail or not elem[-1].tail.strip():
            elem[-1].tail = pad
    elif level and (not elem.tail or not elem.tail.strip()):
        elem.tail = pad


def find_body(root, name):
    for body in root.iter("body"):
        if body.get("name") == name:
            return body
    raise KeyError(name)


def find_parent(root, child):
    for parent in root.iter():
        if child in list(parent):
            return parent
    raise KeyError(child)


def write(tree_root, path):
    indent(tree_root)
    ET.ElementTree(tree_root).write(path, encoding="unicode")
    print("wrote", path)


# ---------------------------------------------------------------------------
# G1 EDU U6: 29-DOF policy-matched body + Inspire RH56DFTP hands
# ---------------------------------------------------------------------------

INSPIRE_FINGER_ROOTS = ["thumb_1", "index_1", "middle_1", "ring_1", "little_1"]
INSPIRE_ACTUATED = ["thumb_1", "thumb_2", "index_1", "middle_1", "ring_1", "little_1"]
# URDF mimic couplings: (driven, driver, multiplier)
INSPIRE_COUPLINGS = [
    ("thumb_3", "thumb_2", 0.8024),
    ("thumb_4", "thumb_3", 0.9487),
    ("index_2", "index_1", 1.0843),
    ("middle_2", "middle_1", 1.0843),
    ("ring_2", "ring_1", 1.0843),
    ("little_2", "little_1", 1.0843),
]
# fingertip touch-sensor sites: body, local pos (from distal force-sensor pads)
INSPIRE_TIP_SITES = {
    "thumb_4": "-0.028987 0.017301 -0.0073513",
    "index_2": "-0.0086237 0.052572 0.0060954",
    "middle_2": "-0.0098294 0.056051 0.0061006",
    "ring_2": "-0.0086237 0.052572 0.0060954",
    "little_2": "-0.0063973 0.042707 0.0061154",
}


def build_edu():
    lucky = ET.parse(os.path.join(VENDOR, "lucky_g1_29dof.xml")).getroot()
    ftp = ET.parse(os.path.join(VENDOR, "inspire_ftp_converted.xml")).getroot()

    lucky.set("model", "g1_edu_u6")
    lucky.find("compiler").set("meshdir", "meshes")

    # -- assets: point body meshes at the shared STL pool, drop Dex-3 hand
    #    meshes, add Inspire hand meshes
    asset = lucky.find("asset")
    for mesh in list(asset.findall("mesh")):
        name = mesh.get("name")
        if "hand_" in name:  # Dex-3 palm/finger meshes
            asset.remove(mesh)
        else:
            mesh.set("file", mesh.get("file").replace(".obj", ".STL"))
    ftp_meshes = {m.get("name"): m for m in ftp.find("asset").findall("mesh")}
    inspire_mesh_names = sorted(
        n for n in ftp_meshes
        if any(k in n for k in
               ("base_link", "palm_force", "thumb", "index", "middle", "ring", "little"))
        and n.split("_", 1)[0] in ("left", "right"))
    for name in inspire_mesh_names:
        m = ftp_meshes[name]
        ET.SubElement(asset, "mesh", name=name,
                      file=os.path.basename(m.get("file")))

    # -- graft hands: replace Dex-3 subtree in each wrist_yaw body
    for side in ("left", "right"):
        wrist = find_body(lucky, f"{side}_wrist_yaw_link")
        ftp_wrist = find_body(ftp, f"{side}_wrist_yaw_link")

        # wrist inertial now includes the Inspire base/palm (URDF fixed-joint merge)
        wrist.remove(wrist.find("inertial"))
        for geom in list(wrist.findall("geom")):
            if "hand_palm" in (geom.get("mesh") or ""):
                geom.remove if False else wrist.remove(geom)
        for body in list(wrist.findall("body")):
            wrist.remove(body)  # Dex-3 thumb/index/middle subtrees

        wrist.insert(0, copy.deepcopy(ftp_wrist.find("inertial")))
        for geom in ftp_wrist.findall("geom"):
            mesh = geom.get("mesh") or ""
            if mesh == f"{side}_wrist_yaw_link":
                continue  # lucky already has the wrist link visual
            g = copy.deepcopy(geom)
            if g.get("contype") == "0":       # visual duplicate
                g.set("group", "2")
            else:                              # collision mesh
                if "force_sensor" in mesh:     # skip collision for sensor pads
                    continue
                g.set("group", "3")
            wrist.append(g)
        for root_name in INSPIRE_FINGER_ROOTS:
            sub = copy.deepcopy(find_body(ftp_wrist, f"{side}_{root_name}"))
            for j in sub.iter("joint"):
                j.set("damping", "0.05")
                j.set("frictionloss", "0.01")
            for g in sub.iter("geom"):
                mesh = g.get("mesh") or ""
                if g.get("contype") == "0":
                    g.set("group", "2")
                elif "force_sensor" in mesh:
                    g.set("contype", "0"), g.set("conaffinity", "0")
                    g.set("group", "2"), g.set("density", "0")
                else:
                    g.set("group", "3")
            wrist.append(sub)
        # fingertip touch sites
        for body_frag, pos in INSPIRE_TIP_SITES.items():
            tip = find_body(wrist, f"{side}_{body_frag}")
            ET.SubElement(tip, "site", name=f"{side}_{body_frag}_tip",
                          pos=pos, size="0.012", type="sphere")

    # -- actuators: drop Dex-3, add 6 per Inspire hand
    act = lucky.find("actuator")
    for pos in list(act.findall("position")):
        if "hand_" in pos.get("name"):
            act.remove(pos)
    for side in ("left", "right"):
        for frag in INSPIRE_ACTUATED:
            joint = f"{side}_{frag}_joint"
            kp = "3.0" if "thumb" in frag else "2.0"
            ET.SubElement(act, "position", name=joint, joint=joint,
                          kp=kp, kv="0.1", forcerange="-3 3")

    # -- equality couplings for the 12 passive joints
    equality = ET.SubElement(lucky, "equality")
    for side in ("left", "right"):
        for driven, driver, mult in INSPIRE_COUPLINGS:
            ET.SubElement(equality, "joint",
                          joint1=f"{side}_{driven}_joint",
                          joint2=f"{side}_{driver}_joint",
                          polycoef=f"0 {mult} 0 0 0",
                          solref="0.005 1",
                          solimp="0.99 0.999 0.0001 0.5 2")

    # -- touch sensors on fingertips
    sensor = lucky.find("sensor")
    for side in ("left", "right"):
        for body_frag in INSPIRE_TIP_SITES:
            finger = body_frag.rsplit("_", 1)[0]
            ET.SubElement(sensor, "touch",
                          name=f"{side}_{finger}_touch",
                          site=f"{side}_{body_frag}_tip")

    # spawn pose is set at runtime
    find_body(lucky, "pelvis").set("pos", "0 0 0.79")
    write(lucky, os.path.join(OUT, "g1_edu_u6.xml"))


# ---------------------------------------------------------------------------
# G1 Basic: official 23-DOF model + policy-matched physics setup
# ---------------------------------------------------------------------------

# capsule/sphere collision scheme from the policy-matched model, keyed by body
BASIC_COLLISIONS = {
    "pelvis": [dict(name="pelvis_collision", type="sphere", size="0.07", pos="0 0 -0.08")],
    "torso_link": [
        dict(name="torso_collision", type="capsule", size="0.09", fromto="0.01 0 0.08 0.01 0 0.2"),
        dict(name="head_collision", type="sphere", size="0.06", pos="0 0 .43"),
    ],
}
for _s in ("left", "right"):
    BASIC_COLLISIONS[f"{_s}_hip_roll_link"] = [
        dict(name=f"{_s}_hip_collision", type="capsule", size="0.06", fromto="0.02 0 0 0.02 0 -0.08")]
    BASIC_COLLISIONS[f"{_s}_hip_yaw_link"] = [
        dict(name=f"{_s}_thigh_collision", type="capsule", size="0.055", fromto="-0.0 0 -0.03 -0.06 0 -0.17")]
    BASIC_COLLISIONS[f"{_s}_knee_link"] = [
        dict(name=f"{_s}_shin_collision", type="capsule", size="0.045", fromto="0.01 0 0 0.01 0 -0.15"),
        dict(name=f"{_s}_linkage_brace_collision", type="capsule", size="0.03", fromto="0.01 0 -0.2 0.01 0 -0.28")]
    BASIC_COLLISIONS[f"{_s}_ankle_roll_link"] = [
        dict(name=f"{_s}_foot{i}_collision", type="capsule", size="0.01", fromto=ft)
        for i, ft in enumerate([
            "0.1 -0.026 -0.025 0.05 -0.027 -0.025",
            "-0.044 -0.018 -0.025 0.123 -0.018 -0.025",
            "-0.052 -0.01 -0.025 0.13 -0.01 -0.025",
            "-0.054 0 -0.025 0.132 0 -0.025",
            "-0.052 0.01 -0.025 0.13 0.01 -0.025",
            "-0.044 0.018 -0.025 0.123 0.018 -0.025",
            "0.1 0.026 -0.025 0.05 0.026 -0.025"], start=1)]
    BASIC_COLLISIONS[f"{_s}_shoulder_yaw_link"] = [
        dict(name=f"{_s}_shoulder_yaw_collision", type="capsule", size="0.035", fromto="0 0 -0.08 0 0 0.05")]
    BASIC_COLLISIONS[f"{_s}_elbow_link"] = [
        dict(name=f"{_s}_elbow_collision", type="capsule", size="0.035", fromto="-0.01 0 -0.01 0.08 0 -0.01")]
    # rubber hand: capsule spanning forearm + fixed hand (mesh runs along +x)
    BASIC_COLLISIONS[f"{_s}_wrist_roll_rubber_hand"] = [
        dict(name=f"{_s}_hand_collision", type="capsule", size="0.037", fromto="0.02 0 0 0.19 0 0")]


def build_basic():
    root = ET.parse(os.path.join(VENDOR, "g1_23dof_rev_1_0.xml")).getroot()
    root.set("model", "g1_basic")

    # strip the source file's bundled demo scene (floor, skybox, lights);
    # scenes are composed separately
    for tag in ("statistic", "visual"):
        for el in root.findall(tag):
            root.remove(el)
    for asset in root.findall("asset"):
        if asset.find("texture") is not None:
            root.remove(asset)
    for wb in root.findall("worldbody"):
        if wb.find("body") is None:  # the scene worldbody has only floor+light
            root.remove(wb)

    ET.SubElement(root, "option", **SIM_OPTION)

    # visual groups: keep group 1 visuals as-is; drop URDF-style mesh/primitive
    # collision duplicates (geoms without contype), then add the capsule scheme
    for body in root.iter("body"):
        for geom in list(body.findall("geom")):
            if geom.get("contype") is None:
                body.remove(geom)
        for spec in BASIC_COLLISIONS.get(body.get("name"), []):
            ET.SubElement(body, "geom", group="3",
                          rgba=".2 .6 .2 .3", **spec)

    # armature + policy-matched PD position actuators
    for joint in root.iter("joint"):
        name = joint.get("name")
        if name == "floating_base_joint":
            continue
        joint.set("armature", str(lookup(ARMATURE, name)))
        joint.set("frictionloss", "0.1")

    act = root.find("actuator")
    joint_order = [j.get("name") for j in root.iter("joint")
                   if j.get("name") != "floating_base_joint"]
    for motor in list(act):
        act.remove(motor)
    for name in joint_order:
        kp, kv = lookup(PD_GAINS, name)
        ET.SubElement(act, "position", name=name, joint=name,
                      kp=str(kp), kv=str(kv), inheritrange="1")

    # sites: feet (IMU sites and gyro/accelerometer sensors already exist in
    # the official 23-DOF model, at the same torso/pelvis locations as the
    # policy-matched 29-DOF model)
    for side in ("left", "right"):
        ankle = find_body(root, f"{side}_ankle_roll_link")
        ET.SubElement(ankle, "site", name=f"{side}_foot", pos="0.04 0 -0.037",
                      size="0.01", rgba="1 0 0 1", group="5")

    # contact excludes mirrored from the policy-matched model
    contact = ET.SubElement(root, "contact")
    for side in ("left", "right"):
        ET.SubElement(contact, "exclude", body1="pelvis",
                      body2=f"{side}_hip_roll_link")

    find_body(root, "pelvis").set("pos", "0 0 0.79")
    write(root, os.path.join(OUT, "g1_basic.xml"))


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    build_edu()
    build_basic()
