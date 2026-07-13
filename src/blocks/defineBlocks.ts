import * as Blockly from "blockly";
import { javascriptGenerator, Order } from "blockly/javascript";
import type { JointMeta } from "../lib/types";

/** Register robot blocks. Called once, then `refreshJointOptions` updates the
 *  joint dropdowns when a different robot loads. */

let currentJoints: JointMeta[] = [];
let currentHasHands = false;

export function refreshRobotBlocks(joints: JointMeta[], hasHands: boolean) {
  currentJoints = joints;
  currentHasHands = hasHands;
}

const jointOptions = (): [string, string][] => {
  const named = currentJoints
    .filter((j) => j.actuated && j.group !== "hand")
    .map((j) => [j.name.replace(/_joint$/, "").replaceAll("_", " "), j.name] as [string, string]);
  return named.length ? named : [["(load a robot)", "none"]];
};

const fingerOptions: [string, string][] = [
  ["thumb", "thumb"], ["index", "index"], ["middle", "middle"], ["ring", "ring"], ["little", "little"],
];
const handOptions: [string, string][] = [["right", "right"], ["left", "left"]];

const C_MOTION = 210;
const C_POSE = 160;
const C_SENSE = 40;
const C_HAND = 300;

export function defineRobotBlocks() {
  Blockly.Blocks["robot_walk"] = {
    init(this: Blockly.Block) {
      this.appendValueInput("METERS").setCheck("Number").appendField("walk");
      this.appendDummyInput().appendField(
        new Blockly.FieldDropdown([["forward", "FWD"], ["backward", "BACK"]]), "DIR",
      ).appendField("meters");
      this.setPreviousStatement(true);
      this.setNextStatement(true);
      this.setColour(C_MOTION);
      this.setTooltip("Walk a distance using the learned balance policy. The robot can fall!");
    },
  };
  javascriptGenerator.forBlock["robot_walk"] = (block, gen) => {
    const meters = gen.valueToCode(block, "METERS", Order.NONE) || "1";
    const fn = block.getFieldValue("DIR") === "BACK" ? "walkBackward" : "walkForward";
    return `await robot.${fn}(${meters});\n`;
  };

  Blockly.Blocks["robot_turn"] = {
    init(this: Blockly.Block) {
      this.appendValueInput("DEGREES").setCheck("Number").appendField("turn")
        .appendField(new Blockly.FieldDropdown([["left ↺", "LEFT"], ["right ↻", "RIGHT"]]), "DIR");
      this.appendDummyInput().appendField("degrees");
      this.setPreviousStatement(true);
      this.setNextStatement(true);
      this.setColour(C_MOTION);
      this.setTooltip("Turn in place by an angle.");
    },
  };
  javascriptGenerator.forBlock["robot_turn"] = (block, gen) => {
    const deg = gen.valueToCode(block, "DEGREES", Order.UNARY_NEGATION) || "90";
    const sign = block.getFieldValue("DIR") === "RIGHT" ? "-" : "";
    return `await robot.turn(${sign}${deg});\n`;
  };

  Blockly.Blocks["robot_stand"] = {
    init(this: Blockly.Block) {
      this.appendDummyInput().appendField("stand still");
      this.setPreviousStatement(true);
      this.setNextStatement(true);
      this.setColour(C_MOTION);
      this.setTooltip("Stop and balance in place.");
    },
  };
  javascriptGenerator.forBlock["robot_stand"] = () => "await robot.stand();\n";

  Blockly.Blocks["robot_set_velocity"] = {
    init(this: Blockly.Block) {
      this.appendValueInput("VX").setCheck("Number").appendField("set velocity  forward");
      this.appendValueInput("VY").setCheck("Number").appendField("left");
      this.appendValueInput("YAW").setCheck("Number").appendField("turn rate");
      this.setInputsInline(true);
      this.setPreviousStatement(true);
      this.setNextStatement(true);
      this.setColour(C_MOTION);
      this.setTooltip("Stream a velocity command (m/s, m/s, rad/s) to the balance policy.");
    },
  };
  javascriptGenerator.forBlock["robot_set_velocity"] = (block, gen) => {
    const vx = gen.valueToCode(block, "VX", Order.NONE) || "0";
    const vy = gen.valueToCode(block, "VY", Order.NONE) || "0";
    const yaw = gen.valueToCode(block, "YAW", Order.NONE) || "0";
    return `robot.setVelocity(${vx}, ${vy}, ${yaw});\n`;
  };

  Blockly.Blocks["robot_wait"] = {
    init(this: Blockly.Block) {
      this.appendValueInput("SECONDS").setCheck("Number").appendField("wait");
      this.appendDummyInput().appendField("seconds");
      this.setPreviousStatement(true);
      this.setNextStatement(true);
      this.setColour(C_MOTION);
      this.setTooltip("Pause the program (simulation time).");
    },
  };
  javascriptGenerator.forBlock["robot_wait"] = (block, gen) => {
    const s = gen.valueToCode(block, "SECONDS", Order.NONE) || "1";
    return `await robot.wait(${s});\n`;
  };

  Blockly.Blocks["robot_move_joint"] = {
    init(this: Blockly.Block) {
      this.appendValueInput("DEGREES").setCheck("Number")
        .appendField("move joint")
        .appendField(new Blockly.FieldDropdown(jointOptions), "JOINT")
        .appendField("to");
      this.appendValueInput("SECONDS").setCheck("Number").appendField("° over");
      this.appendDummyInput().appendField("s");
      this.setInputsInline(true);
      this.setPreviousStatement(true);
      this.setNextStatement(true);
      this.setColour(C_POSE);
      this.setTooltip("Smoothly move a joint to an angle.");
    },
  };
  javascriptGenerator.forBlock["robot_move_joint"] = (block, gen) => {
    const joint = block.getFieldValue("JOINT");
    const deg = gen.valueToCode(block, "DEGREES", Order.NONE) || "0";
    const sec = gen.valueToCode(block, "SECONDS", Order.NONE) || "1";
    return `await robot.moveJoint('${joint}', ${deg}, ${sec});\n`;
  };

  Blockly.Blocks["robot_get_joint"] = {
    init(this: Blockly.Block) {
      this.appendDummyInput().appendField("angle of")
        .appendField(new Blockly.FieldDropdown(jointOptions), "JOINT");
      this.setOutput(true, "Number");
      this.setColour(C_SENSE);
      this.setTooltip("Current joint angle in degrees.");
    },
  };
  javascriptGenerator.forBlock["robot_get_joint"] = (block) => [
    `(await robot.getJoint('${block.getFieldValue("JOINT")}'))`,
    Order.AWAIT,
  ];

  Blockly.Blocks["robot_get_sensor"] = {
    init(this: Blockly.Block) {
      this.appendDummyInput().appendField("sensor")
        .appendField(new Blockly.FieldTextInput("imu-pelvis-angular-velocity"), "SENSOR");
      this.setOutput(true);
      this.setColour(C_SENSE);
      this.setTooltip("Read a sensor by name (see the Inspector for names).");
    },
  };
  javascriptGenerator.forBlock["robot_get_sensor"] = (block) => [
    `(await robot.getSensor('${block.getFieldValue("SENSOR").replace(/'/g, "")}'))`,
    Order.AWAIT,
  ];

  Blockly.Blocks["robot_print"] = {
    init(this: Blockly.Block) {
      this.appendValueInput("VALUE").appendField("print");
      this.setPreviousStatement(true);
      this.setNextStatement(true);
      this.setColour(C_SENSE);
      this.setTooltip("Show a value in the console.");
    },
  };
  javascriptGenerator.forBlock["robot_print"] = (block, gen) => {
    const v = gen.valueToCode(block, "VALUE", Order.NONE) || "''";
    return `print(${v});\n`;
  };

  // ------------------------- hands (EDU U6) -------------------------
  Blockly.Blocks["robot_grasp"] = {
    init(this: Blockly.Block) {
      this.appendDummyInput()
        .appendField(new Blockly.FieldDropdown([["close", "GRASP"], ["open", "RELEASE"]]), "ACTION")
        .appendField(new Blockly.FieldDropdown(handOptions), "HAND")
        .appendField("hand");
      this.setPreviousStatement(true);
      this.setNextStatement(true);
      this.setColour(C_HAND);
      this.setTooltip("Grasp or release with the Inspire five-finger hand (G1 EDU U6).");
    },
  };
  javascriptGenerator.forBlock["robot_grasp"] = (block) => {
    const hand = block.getFieldValue("HAND");
    return block.getFieldValue("ACTION") === "GRASP"
      ? `await robot.grasp('${hand}');\n`
      : `await robot.release('${hand}');\n`;
  };

  Blockly.Blocks["robot_set_finger"] = {
    init(this: Blockly.Block) {
      this.appendValueInput("AMOUNT").setCheck("Number")
        .appendField("curl")
        .appendField(new Blockly.FieldDropdown(handOptions), "HAND")
        .appendField(new Blockly.FieldDropdown(fingerOptions), "FINGER")
        .appendField("to");
      this.appendDummyInput().appendField("(0–1)");
      this.setInputsInline(true);
      this.setPreviousStatement(true);
      this.setNextStatement(true);
      this.setColour(C_HAND);
      this.setTooltip("Curl one finger: 0 open, 1 fully curled (G1 EDU U6).");
    },
  };
  javascriptGenerator.forBlock["robot_set_finger"] = (block, gen) => {
    const amount = gen.valueToCode(block, "AMOUNT", Order.NONE) || "1";
    return `robot.setFinger('${block.getFieldValue("HAND")}', '${block.getFieldValue("FINGER")}', ${amount});\n`;
  };

  Blockly.Blocks["robot_finger_force"] = {
    init(this: Blockly.Block) {
      this.appendDummyInput().appendField("force on")
        .appendField(new Blockly.FieldDropdown(handOptions), "HAND")
        .appendField(new Blockly.FieldDropdown(fingerOptions), "FINGER")
        .appendField("fingertip");
      this.setOutput(true, "Number");
      this.setColour(C_HAND);
      this.setTooltip("Fingertip touch-sensor force in newtons (G1 EDU U6).");
    },
  };
  javascriptGenerator.forBlock["robot_finger_force"] = (block) => [
    `(await robot.getFingerForce('${block.getFieldValue("HAND")}', '${block.getFieldValue("FINGER")}'))`,
    Order.AWAIT,
  ];
}

export function buildToolbox(): Blockly.utils.toolbox.ToolboxDefinition {
  const num = (n: number) => ({
    kind: "block", type: "math_number", fields: { NUM: n },
  });
  const shadowNum = (name: string, n: number) => ({
    [name]: { shadow: { type: "math_number", fields: { NUM: n } } },
  });

  const contents: object[] = [
    {
      kind: "category", name: "Motion", colour: `${C_MOTION}`,
      contents: [
        { kind: "block", type: "robot_walk", inputs: shadowNum("METERS", 1) },
        { kind: "block", type: "robot_turn", inputs: shadowNum("DEGREES", 90) },
        { kind: "block", type: "robot_stand" },
        {
          kind: "block", type: "robot_set_velocity",
          inputs: { ...shadowNum("VX", 0.6), ...shadowNum("VY", 0), ...shadowNum("YAW", 0) },
        },
        { kind: "block", type: "robot_wait", inputs: shadowNum("SECONDS", 1) },
      ],
    },
    {
      kind: "category", name: "Pose", colour: `${C_POSE}`,
      contents: [
        {
          kind: "block", type: "robot_move_joint",
          inputs: { ...shadowNum("DEGREES", 45), ...shadowNum("SECONDS", 1) },
        },
      ],
    },
    ...(currentHasHands
      ? [{
          kind: "category", name: "Hands", colour: `${C_HAND}`,
          contents: [
            { kind: "block", type: "robot_grasp" },
            { kind: "block", type: "robot_set_finger", inputs: shadowNum("AMOUNT", 1) },
            { kind: "block", type: "robot_finger_force" },
          ],
        }]
      : []),
    {
      kind: "category", name: "Sense", colour: `${C_SENSE}`,
      contents: [
        { kind: "block", type: "robot_get_joint" },
        { kind: "block", type: "robot_get_sensor" },
        { kind: "block", type: "robot_print", inputs: { VALUE: { shadow: { type: "text", fields: { TEXT: "hello" } } } } },
      ],
    },
    {
      kind: "category", name: "Loops & logic", colour: "120",
      contents: [
        { kind: "block", type: "controls_repeat_ext", inputs: { TIMES: { shadow: { type: "math_number", fields: { NUM: 4 } } } } },
        { kind: "block", type: "controls_whileUntil" },
        { kind: "block", type: "controls_if" },
        { kind: "block", type: "logic_compare" },
        { kind: "block", type: "logic_boolean" },
      ],
    },
    {
      kind: "category", name: "Math & text", colour: "230",
      contents: [
        num(1),
        { kind: "block", type: "math_arithmetic" },
        { kind: "block", type: "math_random_int", inputs: { FROM: { shadow: { type: "math_number", fields: { NUM: 1 } } }, TO: { shadow: { type: "math_number", fields: { NUM: 10 } } } } },
        { kind: "block", type: "text" },
        { kind: "block", type: "text_join" },
      ],
    },
    { kind: "category", name: "Variables", colour: "330", custom: "VARIABLE" },
  ];
  return { kind: "categoryToolbox", contents } as Blockly.utils.toolbox.ToolboxDefinition;
}
