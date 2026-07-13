import { useEffect, useRef } from "react";
import * as Blockly from "blockly";
import { javascriptGenerator } from "blockly/javascript";
import { useStore } from "../state/store";
import { buildToolbox, defineRobotBlocks, refreshRobotBlocks } from "./defineBlocks";
import { MonacoPane } from "../editor/MonacoPane";

let blocksDefined = false;

export function BlocklyPane() {
  const hostRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<Blockly.WorkspaceSvg | null>(null);
  const spec = useStore((s) => s.spec);
  const generatedJs = useStore((s) => s.generatedJs);
  const setBlockly = useStore((s) => s.setBlockly);

  useEffect(() => {
    if (!hostRef.current) return;
    if (!blocksDefined) {
      defineRobotBlocks();
      blocksDefined = true;
    }
    refreshRobotBlocks(spec?.joints ?? [], spec?.robotId === "g1_edu_u6");

    const ws = Blockly.inject(hostRef.current, {
      toolbox: buildToolbox(),
      media: "/blockly-media/", // self-hosted: no CDN fetches (COEP-safe)
      renderer: "zelos",
      theme: Blockly.Themes.Zelos,
      grid: { spacing: 24, length: 2, colour: "#333a48", snap: true },
      zoom: { controls: true, wheel: true, startScale: 0.85 },
      trashcan: true,
      move: { scrollbars: true, drag: true, wheel: false },
    });
    wsRef.current = ws;

    const saved = useStore.getState().blocklyState;
    if (saved && Object.keys(saved).length) {
      try {
        Blockly.serialization.workspaces.load(saved, ws);
      } catch {
        /* stale state from another robot — start fresh */
      }
    }

    const regenerate = () => {
      const state = Blockly.serialization.workspaces.save(ws);
      const code = javascriptGenerator.workspaceToCode(ws);
      setBlockly(state, code);
    };
    ws.addChangeListener((ev: Blockly.Events.Abstract) => {
      if (ev.isUiEvent) return;
      regenerate();
    });
    regenerate();

    const onResize = () => Blockly.svgResize(ws);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      ws.dispose();
      wsRef.current = null;
    };
    // Rebuild the workspace when the robot changes so hand blocks and joint
    // dropdowns match the loaded robot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec?.robotId]);

  return (
    <div className="flex h-full flex-col">
      <div ref={hostRef} className="min-h-0 flex-1" />
      <div className="h-[30%] min-h-[7rem] border-t border-zinc-800">
        <div className="flex items-center justify-between bg-zinc-900 px-3 py-1 text-[11px] uppercase tracking-wide text-zinc-500">
          <span>Generated JavaScript (read-only)</span>
          <span>blocks run through the same sandbox as the JS editor</span>
        </div>
        <div className="h-[calc(100%-1.5rem)]">
          <MonacoPane readOnly value={generatedJs || "// drag blocks to build a program"} />
        </div>
      </div>
    </div>
  );
}
