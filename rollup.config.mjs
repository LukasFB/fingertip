import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

const pluginDirectory = "com.lukas-bhm.fingertip.sdPlugin";

export default {
  input: "src/plugin.ts",
  output: {
    file: `${pluginDirectory}/bin/plugin.js`,
    format: "es",
    sourcemap: false,
  },
  plugins: [
    typescript({
      tsconfig: "./tsconfig.json",
      compilerOptions: { noEmit: false, rewriteRelativeImportExtensions: true },
    }),
    nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
    commonjs(),
    {
      name: "emit-module-package-file",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "package.json",
          source: "{\"type\":\"module\"}\n",
        });
      },
    },
  ],
};
