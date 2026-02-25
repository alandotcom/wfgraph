import path from "node:path";
import { transformAsync } from "@babel/core";
import type { BunPlugin } from "bun";

const SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/;
const EXCLUDED_FILE_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/;

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function isProcessableSource(filePath: string): boolean {
  const normalized = normalizePath(filePath);

  if (!SOURCE_FILE_PATTERN.test(normalized)) {
    return false;
  }

  if (normalized.endsWith(".d.ts") || EXCLUDED_FILE_PATTERN.test(normalized)) {
    return false;
  }

  return !normalized.includes("/node_modules/");
}

export function createReactCompilerPlugin(): BunPlugin {
  return {
    name: "react-compiler-babel-plugin",
    setup(build) {
      build.onLoad({ filter: SOURCE_FILE_PATTERN }, async (args) => {
        if (!isProcessableSource(args.path)) {
          return;
        }

        const source = await Bun.file(args.path).text();
        const transformed = await transformAsync(source, {
          filename: args.path,
          babelrc: false,
          configFile: false,
          sourceMaps: false,
          presets: [
            ["@babel/preset-typescript", { allowDeclareFields: true }],
            ["@babel/preset-react", { runtime: "automatic" }],
          ],
          plugins: [
            ["babel-plugin-react-compiler", { panicThreshold: "none" }],
          ],
        });

        if (!transformed?.code) {
          return;
        }

        return {
          contents: transformed.code,
          loader: "js",
        };
      });
    },
  };
}
