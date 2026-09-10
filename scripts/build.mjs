// 本文件：构建脚本，用 esbuild 把整棵源码树打包成单个可执行的 dist/mini-cc.mjs。
/**
 * Bundle mini-cc into one runnable file, plus the one asset that cannot be
 * inlined (see the yoga.wasm copy at the bottom).
 * 把 mini-cc 打包成一个可运行文件，外加一个无法内联的资源（见文末 yoga.wasm 的拷贝）。
 *
 * Why bundle at all, when tsx works? Startup. `npx tsx` pays to transpile the
 * whole tree on every invocation; a bundle starts in tens of milliseconds. For
 * a CLI you run fifty times a day that is the difference between a tool that
 * feels instant and one that does not.
 * 既然 tsx 能跑，为何还要打包？为了启动速度。`npx tsx` 每次调用都要转译整棵树；
 * 打包后启动只需几十毫秒。对一天要跑五十次的 CLI，这就是「跟手」与「不跟手」之别。
 */
import { build } from 'esbuild'
import { chmod, copyFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const outfile = 'dist/mini-cc.mjs'

/**
 * Ink imports react-devtools-core for its development mode. It is an optional
 * peer dependency we do not install, and leaving it `external` would make the
 * bundle fail at import time. Replace it with an empty module.
 * Ink 会为开发模式引入 react-devtools-core。它是我们没安装的可选 peer 依赖，
 * 标为 external 会让打包产物在 import 时就崩。用一个空模块替换掉。
 */
const stubOptionalDeps = {
  name: 'stub-optional-deps',
  setup(build) {
    const stubbed = /^react-devtools-core$/
    build.onResolve({ filter: stubbed }, args => ({ path: args.path, namespace: 'stub' }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export default {}',
      loader: 'js',
    }))
  },
}

const result = await build({
  entryPoints: ['src/bootstrap-entry.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  plugins: [stubOptionalDeps],
  banner: {
    // The shebang must be the FIRST line of the file, so it goes here rather
    // than being prepended afterwards — esbuild would otherwise emit its own
    // from the entry point and you would end up with two.
    // shebang 必须是文件第一行，故放在 banner 里而非事后拼接——
    // 否则 esbuild 会从入口文件再吐一个，最后你有两行。
    //
    // The rest is a CommonJS shim: some dependencies still reach for
    // require/__dirname, which do not exist in an ESM bundle.
    // 其余是 CommonJS 垫片：部分依赖仍会用 require/__dirname，而 ESM 产物里没有它们。
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __createRequire } from 'node:module'",
      "import { fileURLToPath as __fileURLToPath } from 'node:url'",
      "import { dirname as __pathDirname } from 'node:path'",
      'const require = __createRequire(import.meta.url)',
      'const __filename = __fileURLToPath(import.meta.url)',
      'const __dirname = __pathDirname(__filename)',
    ].join('\n'),
  },
  minify: false,
  sourcemap: true,
  logLevel: 'info',
})

/**
 * Ink's layout engine is WebAssembly, and it loads the .wasm at runtime with
 * `createRequire(import.meta.url).resolve('./yoga.wasm')`. In the bundle that
 * `import.meta.url` is dist/mini-cc.mjs, so the lookup lands in dist/ — hence
 * `mini-cc: Cannot find module './yoga.wasm'` unless we put it there.
 * Ink 的布局引擎是 WebAssembly，运行时用
 * `createRequire(import.meta.url).resolve('./yoga.wasm')` 加载。
 * 打包后这里的 import.meta.url 是 dist/mini-cc.mjs，查找便落到 dist/ 目录——
 * 不把文件放进去，就会报 `mini-cc: Cannot find module './yoga.wasm'`。
 *
 * Copying beats inlining as base64: the source of truth stays the installed
 * package, so a dependency bump cannot leave a stale copy welded into the
 * bundle.
 * 拷贝优于内联 base64：事实来源仍是已安装的包，
 * 升级依赖时不会有一份陈旧副本被焊死在产物里。
 */
const wasm = createRequire(import.meta.url).resolve('yoga-wasm-web/dist/yoga.wasm')
await copyFile(wasm, join(dirname(outfile), 'yoga.wasm'))

// Make it directly executable on Unix; Windows uses the npm shim.
// 让它在 Unix 上可直接执行；Windows 走 npm 的 shim。
await chmod(outfile, 0o755).catch(() => {})

if (result.errors.length) process.exit(1)
console.log(`built ${outfile} (+ dist/yoga.wasm)`)
