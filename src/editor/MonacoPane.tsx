import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { useStore } from "../state/store";
import { buildRobotTypings } from "./robotTypes";

// self-hosted Monaco workers (no CDN — the page is cross-origin isolated)
self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

// handy for debugging and driving the editor from e2e tests
(window as unknown as { monaco: typeof monaco }).monaco = monaco;

monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
  target: monaco.languages.typescript.ScriptTarget.ES2020,
  allowNonTsExtensions: true,
  lib: ["es2020"],
});
monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: false,
  noSyntaxValidation: false,
  // top-level await is fine: code runs inside an async function
  diagnosticCodesToIgnore: [1375, 1378],
});

let typingsLib: monaco.IDisposable | null = null;

export function MonacoPane({ readOnly = false, value }: { readOnly?: boolean; value?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const jsSource = useStore((s) => s.jsSource);
  const setJsSource = useStore((s) => s.setJsSource);
  const spec = useStore((s) => s.spec);

  // (re)publish robot typings whenever the loaded robot changes
  useEffect(() => {
    const jointNames = spec?.joints.map((j) => j.name) ?? [];
    const hasHands = spec?.robotId === "g1_edu_u6";
    typingsLib?.dispose();
    typingsLib = monaco.languages.typescript.javascriptDefaults.addExtraLib(
      buildRobotTypings(jointNames, hasHands),
      "ts:robot.d.ts",
    );
  }, [spec]);

  useEffect(() => {
    if (!hostRef.current) return;
    const editor = monaco.editor.create(hostRef.current, {
      value: readOnly ? (value ?? "") : jsSource,
      language: "javascript",
      theme: "vs-dark",
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      lineNumbers: "on",
      readOnly,
      scrollBeyondLastLine: false,
      padding: { top: 10 },
      tabSize: 2,
      wordWrap: "off",
      renderWhitespace: "none",
      fixedOverflowWidgets: true,
    });
    editorRef.current = editor;
    if (!readOnly) {
      const sub = editor.onDidChangeModelContent(() => {
        const text = editor.getValue();
        if (text !== useStore.getState().jsSource) setJsSource(text);
      });
      return () => {
        sub.dispose();
        editor.dispose();
      };
    }
    return () => editor.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  // external source changes (snippets, project load, blocks preview)
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const next = readOnly ? (value ?? "") : jsSource;
    if (editor.getValue() !== next) {
      const pos = editor.getPosition();
      editor.setValue(next);
      if (pos && !readOnly) editor.setPosition(pos);
    }
  }, [jsSource, value, readOnly]);

  return <div ref={hostRef} className="h-full w-full" />;
}
