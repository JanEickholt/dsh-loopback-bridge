/** Host half only: a plain ESM library the dsh loader mounts server-side. */
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  sourcemap: true,
  clean: true,
  external: [/^@deepseek-ai\//],
})
