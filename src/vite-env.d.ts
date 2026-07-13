/// <reference types="vite/client" />

interface Window {
  MonacoEnvironment?: import("monaco-editor").Environment;
}
declare var MonacoEnvironment: import("monaco-editor").Environment | undefined;
