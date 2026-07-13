export const DEFAULT_JS = `// Welcome! This G1 balances with a real learned policy under MuJoCo physics.
// Press ▶ Run and watch it go. It can fall — that's physics.

print('Robot has', (await robot.listJoints()).length, 'joints');

await robot.walkForward(2);
await robot.turn(90);
await robot.walkForward(1);
await robot.stand();

print('Done! Position:', (await robot.getPose()).position);
`;

export interface Snippet {
  id: string;
  label: string;
  eduOnly?: boolean;
  code: string;
}

export const SNIPPETS: Snippet[] = [
  {
    id: "square",
    label: "Walk a square",
    code: `// Walk a 1.5 m square. RL policies drift a little — watch it accumulate!
for (let i = 0; i < 4; i++) {
  await robot.walkForward(1.5);
  await robot.turn(90);
  print('corner', i + 1, 'done');
}
await robot.stand();
`,
  },
  {
    id: "wave",
    label: "Wave hello",
    code: `// Wave with the right arm while the policy keeps balance.
await robot.moveJoint('right_shoulder_roll_joint', -110, 0.8);
await robot.moveJoint('right_elbow_joint', 90, 0.5);
for (let i = 0; i < 4; i++) {
  await robot.moveJoint('right_elbow_joint', 45, 0.3);
  await robot.moveJoint('right_elbow_joint', 100, 0.3);
}
await robot.moveJoint('right_shoulder_roll_joint', -13, 0.8);
await robot.moveJoint('right_elbow_joint', 34, 0.5);
print('👋');
`,
  },
  {
    id: "joystick",
    label: "Joystick weave",
    code: `// Stream velocity commands directly to the balance policy.
robot.setVelocity(0.6, 0, 0.5);   // forward + curving left
await robot.wait(3);
robot.setVelocity(0.6, 0, -0.5);  // forward + curving right
await robot.wait(3);
await robot.stand();
const pose = await robot.getPose();
print('yaw is now', pose.yawDeg.toFixed(0), 'degrees');
`,
  },
  {
    id: "sensors",
    label: "Read the IMU",
    code: `// Sample the pelvis IMU while walking.
robot.setVelocity(0.8, 0, 0);
for (let i = 0; i < 10; i++) {
  await robot.wait(0.3);
  const gyro = await robot.getSensor('imu-pelvis-angular-velocity');
  print('gyro rad/s:', gyro.map(v => v.toFixed(2)).join(', '));
}
await robot.stand();
`,
  },
  {
    id: "squat",
    label: "Squat (risky!)",
    code: `// Take the knees away from the balance policy. Educational: it will
// probably end on the floor. Reset ↺ brings it back.
print('taking direct control of the legs…');
robot.setJoint('left_knee_joint', 90);
robot.setJoint('right_knee_joint', 90);
await robot.wait(2);
print('…still standing? Give balance back:');
await robot.stand();
`,
  },
  {
    id: "grab",
    label: "Grab pose + grasp",
    eduOnly: true,
    code: `// G1 EDU U6: reach out with the right arm and close the Inspire hand.
await robot.moveJoint('right_shoulder_pitch_joint', -45, 1);
await robot.moveJoint('right_elbow_joint', 60, 0.8);
await robot.wait(0.5);

print('closing hand…');
await robot.grasp('right', 0.9);
for (const finger of ['thumb', 'index', 'middle']) {
  print(finger, 'force:', (await robot.getFingerForce('right', finger)).toFixed(2), 'N');
}
await robot.wait(1);
await robot.release('right');
print('released');
`,
  },
  {
    id: "fingers",
    label: "Finger piano",
    eduOnly: true,
    code: `// Curl each finger of the left Inspire hand in sequence.
const fingers = ['index', 'middle', 'ring', 'little', 'thumb'];
for (const f of fingers) {
  robot.setFinger('left', f, 1);
  await robot.wait(0.4);
  robot.setFinger('left', f, 0);
}
print('🎹 done');
`,
  },
];
