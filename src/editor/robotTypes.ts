/** Monaco extra-lib typings for the sandbox `robot` API, generated per robot
 *  variant so autocomplete only offers what the loaded robot really has. */

const COMMON = `
/** The simulated Unitree G1. All motion methods are async — await them. */
declare const robot: {
  /**
   * Walk forward the given distance in meters (negative walks backward).
   * The learned balance policy does the stepping — the robot genuinely
   * balances and can fall. Optional speed in m/s (default 0.75).
   */
  walkForward(meters: number, speed?: number): Promise<void>;
  /** Walk backward the given distance in meters. */
  walkBackward(meters: number, speed?: number): Promise<void>;
  /** Turn in place by degrees. Positive = left (counter-clockwise). */
  turn(degrees: number): Promise<void>;
  /** Stop walking and stand still, balanced by the policy. */
  stand(): Promise<void>;
  /**
   * Stream a velocity command to the balance policy without waiting:
   * vx forward m/s, vy left m/s, yawRate rad/s (positive = left).
   */
  setVelocity(vx: number, vy: number, yawRate: number): void;

  /** Snap a joint's target to an angle in degrees (arms instantly; leg/waist
   *  joints are taken away from the balance policy — the robot may fall). */
  setJoint(name: JointName, degrees: number): void;
  /** Smoothly move a joint to an angle in degrees over a duration in seconds. */
  moveJoint(name: JointName, degrees: number, seconds: number): Promise<void>;
  /** Current joint angle in degrees. */
  getJoint(name: JointName): Promise<number>;
  /** Names of every joint on this robot. */
  listJoints(): Promise<string[]>;
  /** Names of every sensor (IMU gyro/accelerometer, touch, base_* virtuals). */
  listSensors(): Promise<string[]>;
  /** Read a sensor: scalars return a number, vector sensors an array. */
  getSensor(name: string): Promise<number | number[]>;
  /** World pose of the robot's pelvis. */
  getPose(): Promise<{ position: number[]; quaternion: number[]; yawDeg: number }>;
  /** Pause the program for simulated seconds (respects sim speed). */
  wait(seconds: number): Promise<void>;
__HANDS__};

/** Log values to the studio console. */
declare function print(...args: unknown[]): void;
`;

const HANDS_EDU = `
  /** Set one finger's curl: 0 = fully open, 1 = fully curled. */
  setFinger(hand: 'left' | 'right', finger: FingerName, amount: number): void;
  /** Close the whole hand into a power grasp (strength 0..1, default 0.85).
   *  Resolves once the fingers settle (e.g. around an object). */
  grasp(hand: 'left' | 'right', strength?: number): Promise<void>;
  /** Open the hand. */
  release(hand: 'left' | 'right'): Promise<void>;
  /** Fingertip contact force in newtons from the touch sensor. */
  getFingerForce(hand: 'left' | 'right', finger: FingerName): Promise<number>;
`;

const HANDS_BASIC = `
  /** ⚠ G1 Basic has fixed hands — this throws. Switch to G1 EDU U6. */
  setFinger(hand: 'left' | 'right', finger: string, amount: number): void;
  /** ⚠ G1 Basic has fixed hands — this throws. Switch to G1 EDU U6. */
  grasp(hand: 'left' | 'right', strength?: number): Promise<void>;
  /** ⚠ G1 Basic has fixed hands — this throws. Switch to G1 EDU U6. */
  release(hand: 'left' | 'right'): Promise<void>;
  /** ⚠ G1 Basic has fixed hands — this throws. Switch to G1 EDU U6. */
  getFingerForce(hand: 'left' | 'right', finger: string): Promise<number>;
`;

export function buildRobotTypings(jointNames: string[], hasHands: boolean): string {
  const jointUnion = jointNames.length
    ? jointNames.map((n) => `'${n}'`).join(" | ")
    : "string";
  return (
    `declare type JointName = ${jointUnion};\n` +
    `declare type FingerName = 'thumb' | 'index' | 'middle' | 'ring' | 'little';\n` +
    COMMON.replace("__HANDS__", hasHands ? HANDS_EDU : HANDS_BASIC)
  );
}
