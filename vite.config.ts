import path from 'path';
import { fileURLToPath } from 'url';
import { type ConfigEnv, type Plugin, type UserConfig, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { commandPinyinPlugin } from './dev/pinyin/commandPinyinPlugin.mjs';
import { traditionalLocalePlugin } from './dev/i18n/traditionalLocalePlugin.mjs';
import { icuFoliaDataPlugin } from './dev/icuFolia/icuFoliaDataPlugin.mjs';
import { nebbiaStrokesPlugin } from './dev/nebbia/nebbiaStrokesPlugin.mjs';
import { normalizeBuildCommit, resolveBuildKind, resolveBuildRepo, resolveDevBuildKindOverride } from './dev/build/buildIdentity.mjs';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LYRIC_PROXY_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS,PATCH,DELETE,POST,PUT',
  'Access-Control-Allow-Headers': [
    'X-CSRF-Token',
    'X-Requested-With',
    'Accept',
    'Accept-Version',
    'Content-Length',
    'Content-MD5',
    'Content-Type',
    'Date',
    'X-Api-Version',
    'KG-Rec',
    'KG-RC',
    'KG-CLIENTTIMEMS',
    'mid',
    'x-router',
  ].join(', '),
};

const LYRIC_PROXY_IGNORED_FORWARD_HEADERS = ['host', 'connection', 'content-length', 'origin', 'referer'];

function isAllowedLyricProxyHost(hostname: string): boolean {
  return hostname === 'qq.com' || hostname.endsWith('.qq.com') ||
    hostname === 'y.gtimg.cn' ||
    hostname === 'kugou.com' || hostname.endsWith('.kugou.com') ||
    hostname === 'kgimg.com' || hostname.endsWith('.kgimg.com');
}

function setLyricProxyCorsHeaders(res: import('http').ServerResponse): void {
  Object.entries(LYRIC_PROXY_CORS_HEADERS).forEach(([key, value]) => {
    res.setHeader(key, value);
  });
}

function sendLyricProxyJson(res: import('http').ServerResponse, statusCode: number, body: unknown): void {
  setLyricProxyCorsHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readDevRequestBody(req: import('http').IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

function devLyricProxyPlugin() {
  return {
    name: 'folia-dev-lyric-proxy',
    apply: 'serve' as const,
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const requestUrl = new URL(req.url ?? '/', 'http://localhost');
        if (requestUrl.pathname !== '/api/lyric-proxy') {
          next();
          return;
        }

        if (req.method === 'OPTIONS') {
          setLyricProxyCorsHeaders(res);
          res.statusCode = 200;
          res.end();
          return;
        }

        const targetUrlStr = requestUrl.searchParams.get('url');
        if (!targetUrlStr) {
          sendLyricProxyJson(res, 400, { error: 'Missing url parameter' });
          return;
        }

        try {
          const targetUrl = new URL(targetUrlStr);
          if (!isAllowedLyricProxyHost(targetUrl.hostname)) {
            sendLyricProxyJson(res, 403, { error: 'Forbidden: Domain not allowed' });
            return;
          }

          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (!LYRIC_PROXY_IGNORED_FORWARD_HEADERS.includes(key.toLowerCase()) && value) {
              headers.set(key, Array.isArray(value) ? value.join(', ') : value);
            }
          }

          const hasBody = ['POST', 'PUT', 'PATCH'].includes(req.method ?? '');
          const response = await fetch(targetUrl.toString(), {
            method: req.method,
            headers,
            body: hasBody ? await readDevRequestBody(req) : undefined,
          });

          setLyricProxyCorsHeaders(res);

          res.statusCode = response.status;
          res.statusMessage = response.statusText;
          const contentType = response.headers.get('content-type');
          if (contentType) {
            res.setHeader('Content-Type', contentType);
          }

          const buffer = Buffer.from(await response.arrayBuffer());
          res.end(buffer);
        } catch (error) {
          console.error('Vite lyric proxy request failed:', error);
          sendLyricProxyJson(res, 500, { error: 'Proxy request failed', details: String(error) });
        }
      });
    },
  };
}

/**
 * iOS 壳的构建裁剪：grid 入口换成不可用的空清单，PonderHost 换成空组件。
 * registry 用 eager glob 发现各 suite 目录下的 entry.ts，这里在解析阶段拦下 grid 的入口，
 * 连它静态 import 的 Grid3D / GridView / GridMap 一起不进包；glob 的键仍是
 * `./suites/grid/entry.ts`，registry 拿到的是一份 available:false 的清单。
 * 默认 suite 由 .env.ios 的 VITE_LIBRARY_DEFAULT_SUITE=bravais 指过去。
 * App 里 PonderHost 的 import 也在这里换成空组件，Ponder registry / 教程层不进 iOS 包；
 * 手机教程由 components/mobile-tutorial 提供。
 * 另外 8 个在线平台（酷狗 / QQ / 波点 / YouTube Music / Spotify / 汽水 / Apple Music / 飞牛）
 * 的 provider 模块换成只有 id 的占位：iOS 只注册网易云，其余平台只在源码里保留给桌面 / Web 构建。
 */
const IOS_PROVIDER_STUBS: readonly { suffix: string; id: string; exportName: string; }[] = [
  { suffix: 'kugou/kugouProvider', id: 'kugou', exportName: 'kugouProvider' },
  { suffix: 'qq/qqProvider', id: 'qq', exportName: 'qqProvider' },
  { suffix: 'bodian/bodianProvider', id: 'bodian', exportName: 'bodianProvider' },
  { suffix: 'ytm/ytmProvider', id: 'ytm', exportName: 'ytmProvider' },
  { suffix: 'spotify/spotifyProvider', id: 'spotify', exportName: 'spotifyProvider' },
  { suffix: 'qishui/qishuiProvider', id: 'qishui', exportName: 'qishuiProvider' },
  { suffix: 'appleMusic/appleMusicProvider', id: 'appleMusic', exportName: 'appleMusicProvider' },
  { suffix: 'fnmusic/fnmusicProvider', id: 'fnmusic', exportName: 'fnmusicProvider' },
];

/** providerRegistry 用相对路径 import（`./kugou/kugouProvider`），也可能被解析成绝对路径。 */
const providerStubIndex = (source: string): number => {
  const normalized = source.replace(/\\/g, '/').replace(/\.ts$/, '');
  return IOS_PROVIDER_STUBS.findIndex(entry => normalized.endsWith(entry.suffix));
};

function iosBravaisOnlyPlugin(mode: string): Plugin {
  const GRID_STUB_ID = '\0folia-ios-bravais-only:grid-suite-entry';
  const PONDER_STUB_ID = '\0folia-ios-bravais-only:ponder-host';
  const providerStubId = (index: number) => `\0folia-ios-bravais-only:provider-${index}`;
  return {
    name: 'folia-ios-bravais-only',
    enforce: 'pre',
    resolveId(source) {
      if (mode !== 'ios') return null;
      if (/suites[\\/]grid[\\/]entry\.ts$/.test(source)) return GRID_STUB_ID;
      if (/components[\\/]ponder[\\/]PonderHost(?:\.tsx)?$/.test(source)) return PONDER_STUB_ID;
      const providerIndex = providerStubIndex(source);
      if (providerIndex >= 0) return providerStubId(providerIndex);
      return null;
    },
    load(id) {
      if (id === GRID_STUB_ID) {
        return `export default ${JSON.stringify({
          id: 'grid',
          labelKey: 'libraryTui.rendererGrid',
          available: false,
          surfaces: {},
        })};\n`;
      }
      if (id === PONDER_STUB_ID) {
        return 'export default function PonderHost() { return null; }\n';
      }
      const providerIndex = IOS_PROVIDER_STUBS.findIndex((_, index) => providerStubId(index) === id);
      if (providerIndex >= 0) {
        const stub = IOS_PROVIDER_STUBS[providerIndex];
        return `export const ${stub.exportName} = { id: ${JSON.stringify(stub.id)} };\n`;
      }
      return null;
    },
  };
}

export default async function viteConfig(_config: ConfigEnv): Promise<UserConfig> {
  let commitHash = '';
  if (process.env.VERCEL_GIT_COMMIT_SHA) {
    commitHash = process.env.VERCEL_GIT_COMMIT_SHA.substring(0, 7);
  } else {
    try {
      commitHash = execSync('git rev-parse --short HEAD').toString().trim();
    } catch (e) {
      console.warn('Could not get commit hash:', e);
      commitHash = 'unknown, probably dev version';
    }
  }

  let gitBranch = '';
  if (process.env.VERCEL_GIT_COMMIT_REF) {
    gitBranch = process.env.VERCEL_GIT_COMMIT_REF;
  } else {
    try {
      gitBranch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
    } catch (e) {
      console.warn('Could not get git branch:', e);
      gitBranch = 'unknown';
    }
  }

  let commitSuffix = '';
  const canResolveCommitName = /^[0-9a-f]{7,40}$/i.test(commitHash) && !/^0+$/.test(commitHash);
  if (canResolveCommitName) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`https://namoe.izuna.top/api/namoe?hash=${commitHash}`, {
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json() as { name?: string };
        if (data?.name) {
          commitSuffix = `/${data.name}`;
        }
      }
    } catch (e) {
      // Ignore errors during fetch to prevent build failure
    }
  }
  if (process.env.REQUIRE_COMMIT_NAME === 'true' && canResolveCommitName && !commitSuffix) {
    throw new Error(`Could not resolve the commit name for ${commitHash}`);
  }

  // 请求 AMLL 官方 API 时 UA 里的构建身份，见 dev/build/buildIdentity.mjs
  const buildRepo = resolveBuildRepo(process.env, () => execSync('git remote get-url origin', { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
  const buildCommit = normalizeBuildCommit(commitHash);
  // 官方 / 自部署 / 非官方：设置里的版本号、扫码诊断报告和反馈入口都会读它
  // 开发服务器可以用 FOLIA_DEV_BUILD_KIND 钉住（Playwright 用）；vite build 不认这个变量。
  const buildKind = resolveDevBuildKindOverride(_config.command, process.env) ?? resolveBuildKind(process.env);

  const appVersionLabel = process.env.APP_VERSION_LABEL?.trim() || 'Realeco';
  const appReleaseChannel = process.env.APP_RELEASE_CHANNEL?.trim().toLowerCase() || 'realeco';
  const dockerStackVersion = process.env.DOCKER_STACK_VERSION?.trim() || '';

  // The /__folia_cover/ route (public/folia-cover-sw.js) runs inside the PWA worker instead of as a
  // worker of its own: a scope holds one registration, so a second script at '/' replaced sw.js and
  // left the precache with nothing to serve it offline. The query is the file's content hash: an edit
  // to it alone still changes sw.js, and the new copy is not taken from the HTTP cache (imported
  // scripts go through it under the default updateViaCache).
  const localCoverWorkerImport = `folia-cover-sw.js?v=${createHash('sha256')
    .update(fs.readFileSync(path.resolve(__dirname, 'public/folia-cover-sw.js')))
    .digest('hex')
    .slice(0, 12)}`;

  return {
    base: process.env.ELECTRON === 'true' ? './' : '/',
    worker: {
      format: 'es'
    },
    optimizeDeps: {
      // The app's own pages only. Left to its default (every **/*.html under the root) the startup
      // dep scan also crawls each git worktree under .claude/worktrees, a whole copy of the app apiece.
      entries: ['*.html'],
      // Only metadataParser.worker.ts imports music-metadata, and the startup dep scan does not
      // follow worker entries. Left out, the first local import discovers it at runtime, Vite
      // re-optimizes, and every open page is force-reloaded ("optimized dependencies changed").
      include: ['music-metadata'],
    },
    build: {
      rollupOptions: {
        input: {
          main: 'index.html',
          stageClient: 'stage-client.html',
          modExport: 'mod-export.html',
        },
        output: {
          // Rolldown ignores manualChunks once codeSplitting is set, so every manual split lives here.
          codeSplitting: {
            groups: [
              // three.js is a large dependency used only by the diorama 3D visualizer. Split it into its
              // own chunk so it doesn't bloat the main bundle past the PWA precache size limit (each file
              // must stay under workbox.maximumFileSizeToCacheInBytes to be cached for offline use).
              { name: 'three', test: /[\\/]node_modules[\\/]three[\\/]/ },
              // lucide's dynamicIconImports (folium.ui.icon, theme lyricsIcons) makes every icon a dynamic
              // entry, so rolldown gives each icon a chunk of its own - the ones the app imports by name
              // too, which turns them into ~200 single-file startup requests the precache leaves out.
              // An icon referenced by more than its own loader is one the app imports: keep those in
              // one ordinary chunk.
              {
                name: 'lucide-icons',
                test: /[\\/]node_modules[\\/]lucide-react[\\/]dist[\\/]esm[\\/]icons[\\/]/,
                minShareCount: 2,
              },
            ],
          },
          // Icons only reachable through dynamicIconImports stay one chunk each (~1600 of them), loaded
          // when a mod or a theme's lyricsIcons asks for that icon. They live in one directory so the
          // PWA precache can leave them out; workbox.runtimeCaching keeps the ones that get used.
          chunkFileNames(chunk) {
            return chunk.moduleIds.some(id => id.includes('/node_modules/lucide-react/dist/esm/icons/'))
              && chunk.moduleIds.length === 1
              ? 'assets/folium-icons/[name]-[hash].js'
              : 'assets/[name]-[hash].js';
          },
        },
      },
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
      watch: {
        // Build output and model weights are not sources, and watching them breaks packaging: the
        // watcher opens a handle on every directory it finds, and electron-builder packages by
        // extracting Electron into release/win-unpacked.tmp and renaming it to release/win-unpacked.
        // On Windows that rename fails with EPERM while anything holds the directory - so a dev
        // server left running in another terminal kills every `npm run build:electron`.
        // .claude holds the git worktrees of parallel sessions, each a full checkout of the repo:
        // watched, they cost one handle per file (hundreds of thousands on Windows), and setting
        // those up starves the dev server for minutes before it answers the first page.
        ignored: ['**/release/**', '**/models/**', '**/.claude/**'],
      },
    },
    plugins: [
      devLyricProxyPlugin(),
      commandPinyinPlugin(),
      traditionalLocalePlugin(),
      icuFoliaDataPlugin(),
      nebbiaStrokesPlugin(),
      iosBravaisOnlyPlugin(_config.mode),
      react(),
      // iOS（Capacitor）构建不带 Service Worker：capacitor:// scheme 上注册不了，也没有离线意义。
      ...(_config.mode === 'ios' ? [] : [VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['icon.svg'],
        devOptions: {
          enabled: true
        },
        workbox: {
          maximumFileSizeToCacheInBytes: 5000000,
          importScripts: [localCoverWorkerImport],
          // Docker serves this file dynamically; it must never be pinned in the PWA precache.
          // The cover route is stored with the worker script itself, so precaching it is redundant.
          globIgnores: ['**/runtime-config.js', '**/assets/folium-icons/**', '**/folia-cover-sw.js'],
          runtimeCaching: [{
            // Per-icon chunks load on demand. Their names are content-hashed, so an icon cached on
            // first use can be served as-is when the app later starts offline.
            urlPattern: /\/assets\/folium-icons\/[^/]+\.js$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'folia-lucide-icons',
              expiration: { maxEntries: 400 },
            },
          }],
          // API navigations must reach the deployment platform instead of the SPA shell. Opening a
          // local cover in its own tab is a navigation too, and the cover route already answers it.
          navigateFallbackDenylist: [/^\/api(?:\/|$)/, /^\/__folia_cover\//]
        },
        manifest: {
          name: 'Folia Music',
          short_name: 'Folia',
          description: 'A beautiful AI-themed music player',
          theme_color: '#09090b',
          background_color: '#09090b',
          display: 'standalone',
          icons: [
            {
              src: 'icon.svg',
              sizes: '512x512',
              type: 'image/svg+xml',
              purpose: 'any maskable'
            }
          ]
        }
      })])
    ],
    define: {
      '__COMMIT_HASH__': JSON.stringify(commitHash + commitSuffix),
      '__GIT_BRANCH__': JSON.stringify(gitBranch),
      '__BUILD_REPO__': JSON.stringify(buildRepo),
      '__BUILD_COMMIT__': JSON.stringify(buildCommit),
      '__BUILD_KIND__': JSON.stringify(buildKind.kind),
      '__BUILD_HOST__': JSON.stringify(buildKind.host ?? ''),
      '__APP_VERSION__': JSON.stringify(JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')).version),
      '__APP_VERSION_LABEL__': JSON.stringify(appVersionLabel),
      '__APP_RELEASE_CHANNEL__': JSON.stringify(appReleaseChannel),
      '__DOCKER_STACK_VERSION__': JSON.stringify(dockerStackVersion)
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      }
    }
  };
}
