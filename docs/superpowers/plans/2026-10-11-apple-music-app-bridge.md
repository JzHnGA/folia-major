# Apple Music（遥控「音乐」App）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 macOS 桌面版新增 `apple-music` provider。由「音乐」App 发声，Folia 管队列，同时播放一段等长的静音载体，让逐字歌词与真实播放同步。

**Architecture:** 主进程常驻一个 `osascript -l JavaScript` 进程，用逐行 JSON 遥控「音乐」App。Omni 新增「外部播放引擎」契约，provider 通过 IPC transport 实现它。renderer 侧由 `ExternalPlaybackSession` / `ExternalPlaybackSync` 负责：转发控制命令、开播 hold、按「音乐」App 的进度校正载体 `<audio>`。

**Tech Stack:** Electron 43（CommonJS 主进程）、React 19 + TypeScript、Vitest（`environment: 'node'`，hooks 测试靠 mock `react`）、JXA。

**Spec:** `docs/superpowers/specs/2026-10-11-apple-music-app-bridge-design.md`

## Global Constraints

- `src/hooks`、`src/components`、`src/stores` 不得 import 任何 `*Transport`。Task 2 把 `appleMusicTransport` 加进 `test/unit/onlineMusic/omniArchitecture.test.ts` 的 `forbiddenImport` 正则。
- `src/utils` 是叶子层，不 import `omni` 或注册表。判断歌曲是否由外部引擎播放，一律用 `omni.isExternalPlaybackSong(song)` 或 Task 10 的 `involvesExternalPlayback`。
- 新文件在 import 之后加一行文件路径注释（例如 `// src/services/externalPlayback/silentCarrier.ts`）；复杂函数加一句注释；不删除、不改写已有注释和 `@note`。
- provider id 固定为 `'apple-music'`。persistent ID 用 `/^[0-9A-F]{16}$/i` 校验，歌单 id 另外允许 `'library'`。
- 同步阈值：偏差 < 0.08 s 不处理；0.08–1 s 时 `playbackRate` 取 `1 ± 0.05`；> 1 s 直接 seek。开播超时 8000 ms。状态轮询 1000 ms。控制命令超时 8000 ms，列表命令（`listPlaylists` / `getPlaylistTracks` / `searchLibrary`）超时 30000 ms。
- 载体格式：8 kHz、单声道、8-bit unsigned PCM WAV，样本值全为 `0x80`。如果 Task 1 发现 Chromium 不能播放 8-bit WAV，改为 16-bit signed、样本值 0；各任务里的数值同步更新。
- 单测命令：`npx vitest run -c vitest.config.ts <path>`。类型检查：`npm run typecheck`。不跑 `npm run build`，不打包。
- 提交信息用 `feat(apple-music): …` / `test(apple-music): …`，末尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

## Review Focus

- **开播 hold 期间用户按暂停**：「音乐」App 必须暂停；hold 解除后载体不能自动开始播放。Task 9 的 `pauses the engine and clears autoplay when the listener pauses during the start hold` 覆盖。
- **播放中「音乐」App 被退出，或 JXA 进程崩溃**：载体暂停并提示；再按播放时重新发 `play`，而不是 `resume`。Task 8 的 `treats an unexpected stop as engine-stopped and replays on the next play` 与 Task 4 的 `fails in-flight requests with network when the process exits and restarts with backoff` 覆盖。
- **上万首的资料库**：列表命令用 30 s 超时，不能被 8 s 的控制超时误杀。Task 4 的 `uses the list timeout for list operations` 覆盖。
- **启动时恢复会话，「音乐」App 没开**：自动播放关闭时不发任何命令；当前 provider 不是 Apple Music 时不启动「音乐」App。Task 8 的 `sends nothing for an idle start` 与 Task 7 的 `does not list playlists at startup unless Apple Music is the active provider` 覆盖。
- **持久化的当前 provider 是 apple-music，但自动化权限被拒**：可用性变为 `not-configured`，提示只出现一次，不进入扫码流程。Task 6 的 `reports not-configured after the bridge answers auth-required` 与 Task 7 的 `shows the permission hint once when access is denied` 覆盖。

---

## File Structure

| 文件 | 职责 |
| --- | --- |
| `electron/appleMusic/musicAppScript.cjs`（新） | 只导出 JXA 源码字符串 `MUSIC_APP_JXA_SOURCE` |
| `electron/appleMusic/musicAppBridge.cjs`（新） | 子进程生命周期、逐行 JSON 协议、参数校验、错误码映射、状态轮询、封面入库、`stopIfOwned` |
| `electron/main.cjs`、`electron/preload.cjs`、`src/vite-env.d.ts`、`package.json`（改） | 装配、IPC、类型、`NSAppleEventsUsageDescription` |
| `src/types/onlineMusic.ts`、`src/services/onlineMusic/omni.ts`（改） | 外部播放引擎契约与 Omni 入口 |
| `src/services/onlineMusic/appleMusicTransport.ts`（新） | renderer 侧 IPC 封装、权限状态 |
| `src/services/onlineMusic/appleMusicProvider.ts`（新） | provider：归一化、资料库、搜索、载体音源、空歌词、外部引擎 |
| `src/services/onlineMusic/providerRegistry.ts`（改） | 桥接可用时才注册 |
| `src/services/externalPlayback/silentCarrier.ts`（新） | 静音 WAV 与 blob URL |
| `src/services/externalPlayback/externalPlaybackSync.ts`（新） | 单曲同步控制器（纯逻辑） |
| `src/services/externalPlayback/externalPlaybackSession.ts`（新） | 跨曲目会话：切歌、hold、monitoring、音量、hold 期间暂停 |
| `src/services/externalPlayback/externalPlaybackGuards.ts`（新） | `involvesExternalPlayback(...)` |
| `src/hooks/useExternalPlaybackSync.ts`（新） | 把 session 接到 App |
| `src/hooks/useAppleMusicLibrary.ts`（新） | 账号与歌单装载 |
| `src/utils/visualizerSignal.ts`（新） | `resolveHasAnalyserSignal` 纯函数 |
| 其余（改） | 见各任务的 Files |

---

### Task 0：提交设计文档与计划

- [ ] **Step 1：提交**

```bash
git add docs/superpowers/specs/2026-10-11-apple-music-app-bridge-design.md docs/superpowers/plans/2026-10-11-apple-music-app-bridge.md
git commit -m "docs(apple-music): 设计文档与实施计划" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1：Spike（真机验证，代码验完即弃）

**会在用户的 Mac 上实际播放音乐，并触发「控制音乐」的系统授权弹窗。开始前先告诉用户。**

**Files：**
- Create（scratchpad，不进仓库）：`<scratchpad>/spike/music.jxa.js`、`<scratchpad>/spike/drive.mjs`、`<scratchpad>/spike/wav.html`
- Modify：spec 末尾追加 `## Spike 结论`

**Interfaces：**
- Produces：验证过的 `MUSIC_APP_JXA_SOURCE`（Task 4 原样内嵌），以及下列五个问题的结论。

- [ ] **Step 1：写参考 JXA 程序 `music.jxa.js`**

这是 Task 4 要内嵌的脚本原型，spike 的目的就是验证它：

```js
ObjC.import('Foundation');

function respond(message) {
  const text = $(JSON.stringify(message) + '\n');
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(text.dataUsingEncoding($.NSUTF8StringEncoding));
}
function fail(number, message) { const error = new Error(message); error.errorNumber = number; throw error; }

const music = () => Application('Music');
const isRunning = () => Application('Music').running();
const requireRunning = () => { if (!isRunning()) fail(-600, 'Music is not running'); };

function findTrack(id) {
  const hits = music().libraryPlaylists[0].tracks.whose({ persistentID: id })();
  if (!hits.length) fail(-1728, 'Track not found');
  return hits[0];
}
function record(track) {
  return { id: track.persistentID(), name: track.name(), artist: track.artist(), albumArtist: track.albumArtist(),
    album: track.album(), duration: track.duration(), mediaKind: track.mediaKind() };
}
// 批量读属性：每个属性一次 Apple Event，上万首也只有 7 次往返。
function bulk(tracks) {
  const ids = tracks.persistentID();
  if (!ids.length) return [];
  const names = tracks.name(), artists = tracks.artist(), albumArtists = tracks.albumArtist(),
    albums = tracks.album(), durations = tracks.duration(), kinds = tracks.mediaKind();
  return ids.map((id, i) => ({ id, name: names[i], artist: artists[i], albumArtist: albumArtists[i],
    album: albums[i], duration: durations[i], mediaKind: kinds[i] }));
}

const handlers = {
  probe() {
    if (!isRunning()) return { running: false, permission: 'unknown' };
    try { music().name(); return { running: true, permission: 'granted' }; }
    catch (error) { if (error.errorNumber === -1743) return { running: true, permission: 'denied' }; throw error; }
  },
  listPlaylists() {
    requireRunning();
    const lists = music().userPlaylists;
    const ids = lists.persistentID(), names = lists.name(), kinds = lists.specialKind(), smart = lists.smart();
    const out = [{ id: 'library', name: '', kind: 'library' }];
    ids.forEach((id, i) => { if (kinds[i] === 'none') out.push({ id, name: names[i], kind: smart[i] ? 'smart' : 'user' }); });
    return out;
  },
  getPlaylistTracks({ playlistId }) {
    requireRunning();
    const list = playlistId === 'library'
      ? music().libraryPlaylists[0]
      : music().userPlaylists.whose({ persistentID: playlistId })()[0];
    if (!list) fail(-1728, 'Playlist not found');
    return bulk(list.tracks).filter(track => track.mediaKind === 'song');
  },
  searchLibrary({ query, limit }) {
    requireRunning();
    const hits = music().search(music().libraryPlaylists[0], { for: query, only: 'all' }) || [];
    return hits.slice(0, limit).map(record).filter(track => track.mediaKind === 'song');
  },
  getTrack({ id }) { requireRunning(); return record(findTrack(id)); },
  getArtwork({ id, path }) {
    requireRunning();
    const artworks = findTrack(id).artworks();
    if (!artworks.length) return null;
    const host = Application.currentApplication();
    host.includeStandardAdditions = true;
    const file = host.openForAccess(Path(path), { writePermission: true });
    try { host.setEof(file, { to: 0 }); host.write(artworks[0].rawData(), { to: file }); }
    finally { host.closeAccess(file); }
    return { path };
  },
  // 已经在播同一首（壁纸模式重启交接）时只校正位置，不重新缓冲。
  play({ id, position }) {
    const app = music();
    try {
      if (app.playerState() === 'playing' && app.currentTrack.persistentID() === id) {
        if (Math.abs(app.playerPosition() - position) > 1) app.playerPosition = position;
        return null;
      }
    } catch (error) { /* 没有当前曲目 */ }
    app.play(findTrack(id), { once: true });
    if (position > 0.5) app.playerPosition = position;
    return null;
  },
  pause() { requireRunning(); music().pause(); return null; },
  resume() { requireRunning(); music().play(); return null; },
  seek({ position }) { requireRunning(); music().playerPosition = position; return null; },
  setVolume({ volume }) { requireRunning(); music().soundVolume = volume; return null; },
  stop() { if (isRunning()) music().stop(); return null; },
  getState() {
    if (!isRunning()) return { state: 'stopped', persistentId: null, position: 0, duration: null };
    const app = music();
    let persistentId = null, duration = null;
    try { persistentId = app.currentTrack.persistentID(); duration = app.currentTrack.duration(); } catch (error) { /* 无当前曲目 */ }
    return { state: app.playerState(), persistentId, position: app.playerPosition() || 0, duration };
  },
};

function run() {
  const input = $.NSFileHandle.fileHandleWithStandardInput;
  let buffer = '';
  for (;;) {
    const chunk = input.availableData;
    if (chunk.length === 0) return;
    buffer += $.NSString.alloc.initWithDataEncoding(chunk, $.NSUTF8StringEncoding).js;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let request;
      try { request = JSON.parse(line); } catch (error) { continue; }
      try {
        const handler = handlers[request.op];
        if (!handler) fail(-1708, 'Unknown op');
        const data = handler(request.args || {});
        respond({ id: request.id, ok: true, data: data === undefined ? null : data });
      } catch (error) {
        respond({ id: request.id, ok: false, error: {
          number: typeof error.errorNumber === 'number' ? error.errorNumber : null,
          message: String((error && error.message) || error) } });
      }
    }
  }
}
```

- [ ] **Step 2：写驱动脚本 `drive.mjs`**

用 `node:child_process` 的 `spawn('osascript', ['-l', 'JavaScript', '-e', source])` 起进程，逐条发送 `{id, op, args}`，打印每条响应和往返耗时（`performance.now()`）。按顺序执行：`probe`、`listPlaylists`、`getPlaylistTracks('library')`（记录耗时和条数）、`searchLibrary`、`play`（用资料库里任意一首）、每 250 ms `getState` 共 40 次、`seek`、`pause`、`resume`、`getArtwork`（写到 scratchpad）、`stop`。

- [ ] **Step 3：运行，回答五个问题**

Run: `node <scratchpad>/spike/drive.mjs`

需要回答：
1. `play(track, {once:true})` 播完后是停下，还是接着播资料库的下一首？（把 `position` 设到结尾前 5 秒观察。）
2. 常驻进程的单条命令往返耗时（中位数、最大值）。
3. `playerPosition` 的精度，以及 250 ms 间隔采样时数值是否每次都在前进。
4. `getArtwork` 的输出文件是不是合法的 JPEG 或 PNG（看前几个字节）。
5. `getPlaylistTracks('library')` 的耗时，以及 `specialKind` 实际返回的取值。

- [ ] **Step 4：验证 Chromium 能播放 8-bit WAV**

`wav.html` 里用 Task 3 的算法（44 字节头 + `0x80` 数据）生成 3 秒 WAV，`new Audio(URL.createObjectURL(blob))` 播放，打印 `duration`，确认会触发 `ended`。在 Browser pane 打开 `file://` 页面执行。

- [ ] **Step 5：在 spec 末尾写 `## Spike 结论`，并按结论调整本计划**

- `once` 无效：Task 8 增加「检测到引擎在 `mediaId` 不同的曲目上 playing，且载体距离结尾不到 1.5 s 时，发 `pause` 而不是 takeover」。
- 8-bit 不可播放：按 Global Constraints 改为 16-bit。
- `rawData` 写文件失败：Task 4 的 `getArtwork` 返回 `null`，provider 不显示封面。

- [ ] **Step 6：提交 spec 的改动**

```bash
git add docs/superpowers/specs/2026-10-11-apple-music-app-bridge-design.md docs/superpowers/plans/2026-10-11-apple-music-app-bridge.md
git commit -m "docs(apple-music): 记录 spike 结论" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2：Omni 外部播放契约

**Files：**
- Modify：`src/types/onlineMusic.ts`（`ProviderCapabilities`、`OnlineMusicProvider`、末尾的 Omni 别名）
- Modify：`src/services/onlineMusic/omni.ts`（在 `canPlaySong` 附近）
- Modify：`test/unit/onlineMusic/omniArchitecture.test.ts:8`（正则加入 `appleMusicTransport`）
- Test：`test/unit/onlineMusic/omniExternalPlayback.test.ts`（新）

**Interfaces：**
- Produces：

```ts
export interface ExternalPlaybackState {
    state: 'playing' | 'paused' | 'stopped';
    mediaId: string | null;
    positionSec: number;
    durationSec: number | null;
    sampledAtMs: number;   // Date.now() 时间戳；positionSec 在这一刻为真
}
export interface OnlineExternalPlaybackProvider {
    play(song: SongResult, positionSec: number): Promise<void>;
    pause(): Promise<void>;
    resume(): Promise<void>;
    seek(positionSec: number): Promise<void>;
    stop(): Promise<void>;
    setVolume(volume: number): Promise<void>;   // 0..1
    setMonitoring(active: boolean): void;
    subscribeState(listener: (state: ExternalPlaybackState) => void): () => void;
}
// ProviderCapabilities.externalPlayback?: boolean
// OnlineMusicProvider.externalPlayback?: OnlineExternalPlaybackProvider
export type OmniExternalPlaybackEngine = OnlineExternalPlaybackProvider;
export type OmniExternalPlaybackState = ExternalPlaybackState;

// omni
isExternalPlaybackSong(song: SongResult | null | undefined): boolean
getExternalPlaybackEngine(song: SongResult): OmniExternalPlaybackEngine | null
```

- [ ] **Step 1：写失败测试**

沿用 `omni.test.ts` 的写法：用 `registerOnlineMusicProvider` 注册测试 provider，在 `afterEach` 里注销。

```ts
it('treats a song as external only when its provider declares externalPlayback and exposes an engine', () => {
    registerOnlineMusicProvider(externalProvider);   // capabilities.externalPlayback: true，并带 externalPlayback 对象
    registerOnlineMusicProvider(plainProvider);      // 两者都没有
    expect(omni.isExternalPlaybackSong(song('ext-test'))).toBe(true);
    expect(omni.isExternalPlaybackSong(song('plain-test'))).toBe(false);
    expect(omni.getExternalPlaybackEngine(song('ext-test'))).toBe(externalProvider.externalPlayback);
    expect(omni.getExternalPlaybackEngine(song('plain-test'))).toBeNull();
});
it('answers false and null for local, missing and unregistered songs instead of throwing', () => {
    expect(omni.isExternalPlaybackSong(null)).toBe(false);
    expect(omni.isExternalPlaybackSong({ ...song('x'), sourceRef: { kind: 'local', mediaId: 'a' } })).toBe(false);
    expect(omni.isExternalPlaybackSong(song('not-registered'))).toBe(false);
    expect(omni.getExternalPlaybackEngine(song('not-registered'))).toBeNull();
});
it('does not treat a declared capability without an engine as external', () => {
    registerOnlineMusicProvider({ ...plainProvider, id: 'half-test', capabilities: { ...capabilities, externalPlayback: true } });
    expect(omni.isExternalPlaybackSong(song('half-test'))).toBe(false);
});
```

- [ ] **Step 2：确认测试失败**

Run: `npx vitest run -c vitest.config.ts test/unit/onlineMusic/omniExternalPlayback.test.ts`
Expected：FAIL，提示 `omni.isExternalPlaybackSong is not a function`。

- [ ] **Step 3：实现契约和两个 Omni 方法**

两个方法都用 `getOnlineMusicProviderForSong(song)`（未注册时返回 null，不抛错），条件是 `providerSupports(provider, 'externalPlayback') && provider.externalPlayback`。同时在架构测试的正则 `(providerRegistry|kugouTransport|qqTransport|bodianTransport|…)` 里加上 `appleMusicTransport`。

- [ ] **Step 4：确认测试通过**

Run: `npx vitest run -c vitest.config.ts test/unit/onlineMusic/omniExternalPlayback.test.ts test/unit/onlineMusic/omni.test.ts test/unit/onlineMusic/omniArchitecture.test.ts && npm run typecheck`
Expected：全部 PASS，typecheck 无错误。

- [ ] **Step 5：提交**

```bash
git add src/types/onlineMusic.ts src/services/onlineMusic/omni.ts test/unit/onlineMusic/omniExternalPlayback.test.ts test/unit/onlineMusic/omniArchitecture.test.ts
git commit -m "feat(apple-music): Omni 增加外部播放引擎契约" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3：静音载体

**Files：**
- Create：`src/services/externalPlayback/silentCarrier.ts`
- Test：`test/unit/externalPlayback/silentCarrier.test.ts`

**Interfaces：**
- Produces：`createSilentWavBytes(durationSec: number, sampleRate = 8000): Uint8Array`；`createSilentCarrierUrl(durationSec: number): string | null`（`new Blob([bytes], { type: 'audio/wav' })` 交给 `createSafeObjectUrl`，见 `src/utils/blobGuards.ts`）。

- [ ] **Step 1：写失败测试**

```ts
const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));

it('writes a PCM header for 8 kHz mono 8-bit audio', () => {
    const bytes = createSilentWavBytes(1.5);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(ascii(bytes, 0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(bytes.length - 8);
    expect(ascii(bytes, 8, 16)).toBe('WAVEfmt ');
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);      // PCM
    expect(view.getUint16(22, true)).toBe(1);      // mono
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint32(28, true)).toBe(8000);   // byte rate
    expect(view.getUint16(32, true)).toBe(1);      // block align
    expect(view.getUint16(34, true)).toBe(8);
    expect(ascii(bytes, 36, 40)).toBe('data');
    expect(view.getUint32(40, true)).toBe(12000);
    expect(bytes.length).toBe(44 + 12000);
});
it('fills the data chunk with the unsigned 8-bit midpoint', () => {
    expect(createSilentWavBytes(0.25).slice(44).every(byte => byte === 0x80)).toBe(true);
});
it('rounds the sample count up so the carrier never ends before the track', () => {
    expect(createSilentWavBytes(0.00001).length).toBe(45);
    expect(createSilentWavBytes(213.4567).length).toBe(44 + Math.ceil(213.4567 * 8000));
});
it('rejects durations that are not positive and finite', () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => createSilentWavBytes(value)).toThrow();
});
```

- [ ] **Step 2：确认测试失败**

Run: `npx vitest run -c vitest.config.ts test/unit/externalPlayback/silentCarrier.test.ts`
Expected：FAIL，模块不存在。

- [ ] **Step 3：实现 `silentCarrier.ts`**

- [ ] **Step 4：确认测试通过**

Run：同 Step 2。Expected：PASS。

- [ ] **Step 5：提交**

```bash
git add src/services/externalPlayback/silentCarrier.ts test/unit/externalPlayback/silentCarrier.test.ts
git commit -m "feat(apple-music): 生成等长静音载体" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4：主进程桥接

**Files：**
- Create：`electron/appleMusic/musicAppScript.cjs`（`module.exports = { MUSIC_APP_JXA_SOURCE: String.raw\`…\` }`，内容是 Task 1 验证过的脚本）
- Create：`electron/appleMusic/musicAppBridge.cjs`
- Test：`test/unit/electron/appleMusicBridge.test.ts`

**Interfaces：**
- Produces：

```js
createMusicAppBridge({
  spawn,                     // child_process.spawn
  platform = process.platform,
  now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout,
  onState = () => {},        // (ExternalPlaybackState) => void
  artwork,                   // { tmpPath(): string, readFile(p): Promise<Buffer>, removeFile(p): Promise<void>,
                             //   has(assetId): Promise<boolean>, write(assetId, bytes, mime): Promise<unknown> }
  artworkIndex,              // { get(trackId): string | undefined, set(trackId, assetId): void }
  controlTimeoutMs = 8000, listTimeoutMs = 30000, pollIntervalMs = 1000,
  restartDelaysMs = [500, 2000, 10000],
}) → {
  isAvailable(): boolean,                                // 仅 darwin
  request(op, args): Promise<{ ok: true, data } | { ok: false, error: { code, message } }>,   // 永不 reject
  setMonitoring(active: boolean): void,
  stopIfOwned(): Promise<void>,
  dispose(): void,
}
```

- 允许的 op：`probe`、`listPlaylists`、`getPlaylistTracks`、`searchLibrary`、`getTrack`、`getArtwork`、`play`、`pause`、`resume`、`seek`、`setVolume`、`stop`、`getState`。
- 返回给 renderer 的数据形状：
  - 曲目：`{ id, name, artist, albumArtist, album, duration, artworkAssetId? }`（去掉 `mediaKind`，`artworkAssetId` 从 `artworkIndex` 补上）
  - `getArtwork`：`{ assetId } | null`
  - `getState`：已归一化的 `ExternalPlaybackState`
- 状态归一化：
  - `'playing' | 'fast forwarding' | 'rewinding'` → `'playing'`；`'paused'` → `'paused'`；其他 → `'stopped'`
  - `sampledAtMs` 取发出请求与收到响应两个时刻的中点
- 错误码映射：`-1743` → `auth-required`；`-600` / `-609` → `unavailable`；`-1728` → `not-playable`；超时或进程退出 → `network`；参数不合法 → `invalid-response`；未知 op → `unsupported`
- 参数校验：
  - `id`、`playlistId` 用 `/^[0-9A-F]{16}$/i`，`playlistId` 另外允许 `'library'`
  - `query` 是 1–200 字符的字符串
  - `limit` 是 1–100 的整数
  - `position` 是有限且 ≥ 0 的数
  - `volume` 是 0–1 的数，在桥接里换算成 `Math.round(volume * 100)` 再发给 JXA
- `getArtwork`：
  - 主进程生成临时路径，传给 JXA 的 `{ id, path }`
  - 读出字节后按魔数判断：`FF D8 FF` → `image/jpeg`，`89 50 4E 47` → `image/png`，其他 → 返回 `null`
  - 计算 `sha256` 得到 `assetId = 'sha256:' + hex`；`has` 为 false 时才 `write`
  - 写入 `artworkIndex`，最后删除临时文件
- `stopIfOwned`：只在最近一次成功的 `play` 之后、还没有成功的 `stop` 时才发 `stop`。
- 轮询：只在 `setMonitoring(true)` 期间，每 `pollIntervalMs` 发一次 `getState`，结果交给 `onState`。`play` / `pause` / `resume` / `seek` 成功后立即补发一次 `getState`。

- [ ] **Step 1：写失败测试**

在测试文件里写一个假的 `spawn`：返回带 `stdin.write` 记录、`stdout` 为 `EventEmitter`、可触发 `exit` 的对象；测试从记录里取出写入的 JSON 行，再从 `stdout` 回写 `JSON.stringify({id, ok, data})+'\n'`。用 `vi.useFakeTimers()`。

```ts
it('spawns osascript in JavaScript mode once and reuses the process', async () => { /* 两次 request → spawn 只调用一次，参数为 ('osascript', ['-l','JavaScript','-e', MUSIC_APP_JXA_SOURCE]) */ });
it('matches responses to requests by id even when they arrive out of order', async () => { /* 先回 id 2 再回 id 1 */ });
it('rejects malformed ids and arguments without writing to the process', async () => {
    expect(await bridge.request('getTrack', { id: '../etc' })).toMatchObject({ ok: false, error: { code: 'invalid-response' } });
    expect(await bridge.request('searchLibrary', { query: '', limit: 10 })).toMatchObject({ ok: false });
    expect(await bridge.request('seek', { position: -1 })).toMatchObject({ ok: false });
    expect(await bridge.request('eval', {})).toMatchObject({ ok: false, error: { code: 'unsupported' } });
    expect(child.stdin.write).not.toHaveBeenCalled();
});
it('passes the search query as JSON data, never as script text', async () => { /* query 含 '"); do shell script("x' → 写入行 JSON.parse 后 args.query 原样一致 */ });
it('maps AppleScript error numbers to provider error codes', async () => { /* -1743→auth-required、-600→unavailable、-1728→not-playable */ });
it('times out control operations after 8 s', async () => { /* pause 无回应，advanceTimersByTime(8000) → code 'network' */ });
it('uses the list timeout for list operations', async () => { /* getPlaylistTracks 在 8 s 时仍未结束，30 s 时为 network */ });
it('fails in-flight requests with network when the process exits and restarts with backoff', async () => {
    /* exit → 进行中的请求得到 network；下一次 request 在 500 ms 后才 spawn 第二个进程 */ });
it('polls getState only while monitoring and pushes normalized state', async () => {
    /* setMonitoring(true) → 1000 ms 后写入 getState；回包 {state:'fast forwarding', persistentId:'ABCDEF0123456789', position:12.5, duration:200}
       → onState({ state:'playing', mediaId:'ABCDEF0123456789', positionSec:12.5, durationSec:200, sampledAtMs: <中点> })；
       setMonitoring(false) 之后不再写入 */ });
it('refreshes state right after a successful control command', async () => { /* seek 成功 → 紧接着写入一条 getState */ });
it('converts volume to the 0-100 scale', async () => { /* setVolume({volume:0.426}) → 写入 args.volume === 43 */ });
it('stops Music on quit only when Folia started the playback', async () => { /* 没 play 过 → stopIfOwned 不写入；play 成功后 → 写入 stop；stop 成功后再调 → 不写入 */ });
it('stores artwork bytes as a content-addressed cover and indexes it', async () => {
    /* readFile 返回以 FF D8 FF 开头的 Buffer → write('sha256:<hex>', bytes, 'image/jpeg')，返回 { assetId }，并删除临时文件；
       之后 getTrack 的结果带上 artworkAssetId */ });
it('is unavailable and never spawns on other platforms', async () => { /* platform:'linux' → isAvailable() false，request → unavailable */ });
```

- [ ] **Step 2：确认测试失败**

Run: `npx vitest run -c vitest.config.ts test/unit/electron/appleMusicBridge.test.ts`
Expected：FAIL，模块不存在。

- [ ] **Step 3：实现 `musicAppScript.cjs` 和 `musicAppBridge.cjs`**

写法参照 `electron/bodianApiBridge.cjs` 与 `electron/macWallpaperController.cjs`：模块内不 `require('electron')`；依赖全部注入；失败时软降级。stdout 按 `\n` 切行，忽略无法解析的行；stderr 只用 `console.warn` 打印前 200 个字符。

- [ ] **Step 4：确认测试通过**

Run：同 Step 2。Expected：PASS。

- [ ] **Step 5：提交**

```bash
git add electron/appleMusic test/unit/electron/appleMusicBridge.test.ts
git commit -m "feat(apple-music): 主进程常驻 JXA 桥接" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5：Electron 装配

**Files：**
- Modify：`electron/main.cjs`
  - 顶部 `require` 区
  - 仿照 `getMacWallpaperController`（约 661 行）写一个懒加载 getter
  - IPC 放在 `bodian-api-request`（约 5946 行）旁边
  - `app.on('before-quit')`（约 5393 行）
- Modify：`electron/preload.cjs`（约 145 行 `bodianRequest` 旁）
- Modify：`src/vite-env.d.ts`（约 899 行 `bodianRequest` 旁）
- Modify：`package.json`（`build.mac.extendInfo`）
- Create：`src/services/onlineMusic/appleMusicTransport.ts`（本任务只写类型导出：`AppleMusicOperation`、`AppleMusicBridgeResult`、`AppleMusicTrackRecord`、`AppleMusicPlaylistRecord`、`AppleMusicPermission`，定义见 Task 6；运行时函数由 Task 6 补上）

**Interfaces：**
- Consumes：Task 4 的 `createMusicAppBridge`。
- Produces：

```ts
window.electron.appleMusic?: {
    request(op: AppleMusicOperation, args?: Record<string, unknown>): Promise<AppleMusicBridgeResult>;
    setMonitoring(active: boolean): Promise<void>;
    onState(callback: (state: ExternalPlaybackState) => void): () => void;
};
// AppleMusicOperation、AppleMusicBridgeResult 以 import type 从 src/services/onlineMusic/appleMusicTransport.ts 引入
```

- [ ] **Step 1：主进程装配**

`getAppleMusicBridge()`：非 darwin 返回 `null`，否则只创建一次。注入的依赖：
- `spawn`：`require('child_process').spawn`
- `onState`：`state => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('apple-music-state', state)`
- `artwork`：基于 `os.tmpdir()`、`crypto.randomUUID()`、`fs.promises`，以及 `localCoverAssetStore.has` / `write`
- `artworkIndex`：基于 `store` 的键 `apple_music_artwork_index`（普通对象；超过 5000 条时按插入顺序删除最旧的）

IPC：
- `ipcMain.handle('apple-music-request', (event, op, args) => …)`：先用 `isTrustedMainWindowContents(event.sender)` 校验，失败就 `throw`（和 discord handler 一样）；bridge 为 null 时返回 `{ ok:false, error:{ code:'unavailable', message:'Apple Music requires macOS' } }`
- `ipcMain.handle('apple-music-set-monitoring', …)`：同样校验

`before-quit`：`void getAppleMusicBridge()?.stopIfOwned()`（不 await，不阻塞退出），然后 `dispose()`。

- [ ] **Step 2：preload 与类型**

preload 暴露 `appleMusic: { request, setMonitoring, onState }`。`onState` 按 `onWallpaperModeChanged` 的写法返回取消订阅函数。`vite-env.d.ts` 补上上面的类型。

- [ ] **Step 3：打包声明**

在 `package.json` 的 `build.mac` 下增加：

```json
"extendInfo": {
  "NSAppleEventsUsageDescription": "Folia 需要控制「音乐」App 来播放你的 Apple Music 资料库。"
}
```

- [ ] **Step 4：验证**

Run: `node --check electron/main.cjs && node --check electron/preload.cjs && node -e "console.log(require('./package.json').build.mac.extendInfo)" && npm run typecheck`
Expected：语法检查无输出；打印出 `extendInfo`；typecheck 无错误。

- [ ] **Step 5：提交**

```bash
git add electron/main.cjs electron/preload.cjs src/vite-env.d.ts package.json src/services/onlineMusic/appleMusicTransport.ts
git commit -m "feat(apple-music): 装配主进程 IPC 与 macOS 自动化权限声明" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6：transport、provider 与注册

**Files：**
- Modify：`src/services/onlineMusic/appleMusicTransport.ts`（Task 5 只放了类型，这里补运行时函数）
- Create：`src/services/onlineMusic/appleMusicProvider.ts`
- Modify：`src/services/onlineMusic/providerRegistry.ts:81-84`
- Test：`test/unit/onlineMusic/appleMusicProvider.test.ts`

**Interfaces：**
- Consumes：Task 2 的契约、Task 3 的 `createSilentCarrierUrl`、Task 5 的 `window.electron.appleMusic`、`getLocalCoverAssetUrl`（`src/services/localCoverAssetUrl.ts`）。
- Produces：

```ts
// appleMusicTransport.ts
export type AppleMusicOperation = 'probe' | 'listPlaylists' | 'getPlaylistTracks' | 'searchLibrary' | 'getTrack' | 'getArtwork'
    | 'play' | 'pause' | 'resume' | 'seek' | 'setVolume' | 'stop' | 'getState';
export type AppleMusicBridgeResult<T = unknown> = { ok: true; data: T } | { ok: false; error: { code: ProviderErrorCode; message: string } };
export interface AppleMusicTrackRecord { id: string; name: string; artist: string; albumArtist: string; album: string; duration: number; artworkAssetId?: string }
export interface AppleMusicPlaylistRecord { id: string; name: string; kind: 'library' | 'user' | 'smart' }
export type AppleMusicPermission = 'granted' | 'denied' | 'unknown';
export const isAppleMusicBridgeAvailable: () => boolean;   // window.electron?.platform === 'darwin' && 存在 appleMusic.request
export function requestAppleMusic<T>(op: AppleMusicOperation, args?: Record<string, unknown>): Promise<T>;
// 失败时抛 OnlineProviderError(code, message, 'apple-music')；收到 auth-required 时把权限置为 'denied'，成功则置为 'granted'
export const getAppleMusicPermission: () => AppleMusicPermission;
export function subscribeAppleMusicState(listener: (state: ExternalPlaybackState) => void): () => void;
export function setAppleMusicMonitoring(active: boolean): void;

// appleMusicProvider.ts
export const APPLE_MUSIC_PROVIDER_ID = 'apple-music';
export const appleMusicProvider: OnlineMusicProvider;
```

provider 的具体行为：

- `capabilities`：
  - 开启：`search`、`playback`、`lyrics`、`auth`、`userLibrary`、`playlists`、`externalPlayback`
  - 关闭：`albums`、`artists`、`recommendations`、`mutations`、`wordByWordLyrics`
- `getAvailability()`：
  - 桥接不可用 → `{ configured:false, reason:'runtime-unavailable' }`
  - 权限为 `'denied'` → `{ configured:false, reason:'not-configured' }`
  - 其他情况 → `{ configured:true }`
- `normalizeSong(record)`：
  - `id = record.id`
  - `artists = [{ id: 'artist:' + record.artist, name: record.artist }]`
  - `album = { id: 'album:' + (record.albumArtist || record.artist) + '|' + record.album, name: record.album, coverUrl }`
  - `durationMs = Math.round(record.duration * 1000)`
  - `sourceRef = { kind:'online', providerId:'apple-music', mediaId: record.id, providerData: { durationSec: record.duration } }`
  - `coverUrl` 优先取 `record.artworkAssetId`，其次取模块内 `albumArtwork` map（按 album id 记录，任何一首该专辑的曲目拿到 assetId 后写入），换算用 `getLocalCoverAssetUrl(id, 1024)`
- `songMetadata.getSongMetadata`：先用 `createProviderSongMetadata`，再用 `albumArtwork` map 补上 `coverUrl`。
- `auth`：
  - `getLoginStatus()` 先调 `probe`：权限为 `denied` 时返回 `null`；否则返回 `{ id:'local', nickname:'音乐资料库' }`
  - `logout()` 清空模块缓存
  - 不提供任何二维码相关方法
- `library.getUserPlaylists(userId, limit, offset)`：
  - 来自 `listPlaylists`，转成 `{ providerId:'apple-music', id, name, type:'playlist', isOwned:true, providerData:{ kind } }`
  - `kind === 'library'` 的那项名字为 `'资料库全部歌曲'`，并排在第一位
  - 按 `offset` / `limit` 切片
- `catalog.getPlaylistTracks(id, limit, offset)`：整张歌单在模块内缓存 60 秒，切片后 `normalizeSong`；`total` 等于记录总数。
- `catalog.getPlaylistDetail(id, collection)`：返回 `collection ?? null`，在已知时带上 `trackCount`。
- `search.searchSongs(query, limit, offset)`：
  - 空查询直接返回空页
  - 否则调 `searchLibrary({ query, limit: Math.min(offset + limit, 100) })`，再切片
- `playback.getSongDetail(id)`：调 `getTrack`。
- `playback.getAudioSource(song)`：
  - 时长取 `providerData.durationSec`，没有就调 `getTrack`
  - 尽力获取封面：`getArtwork` 设 1500 ms 超时，失败忽略，成功写入 `albumArtwork`
  - 然后返回 `{ url: createSilentCarrierUrl(durationSec), fetchedAt: Date.now(), quality: 'standard' }`
  - 不发任何播放命令
- `lyrics.getLyrics()`：返回 `{ lyrics: null, isPureMusic: false }`。
- `externalPlayback`：
  - `play` → `requestAppleMusic('play', { id: mediaId, position })`；`pause`、`resume`、`seek`、`stop`、`setVolume` 同理一一对应
  - `setMonitoring` → `setAppleMusicMonitoring`
  - `subscribeState` → `subscribeAppleMusicState`

`providerRegistry.ts`：在 `registerOnlineMusicProvider(bodianProvider);` 之后加上 `if (isAppleMusicBridgeAvailable()) registerOnlineMusicProvider(appleMusicProvider);`。

- [ ] **Step 1：写失败测试**

在测试里设置 `globalThis.window = { electron: { platform: 'darwin', appleMusic: { request, setMonitoring, onState } } }`，`request` 用 `vi.fn` 按 op 返回 fixture；在 `afterEach` 里删除 `globalThis.window`。

```ts
it('normalizes Music.app tracks with a stable apple-music identity', () => {
    const song = appleMusicProvider.normalizeSong(track);   // track.id = 'ABCDEF0123456789', duration 213.4
    expect(song.sourceRef).toEqual({ kind: 'online', providerId: 'apple-music', mediaId: 'ABCDEF0123456789', providerData: { durationSec: 213.4 } });
    expect(song.durationMs).toBe(213400);
});
it('lists the whole library first under its own name, then user and smart playlists', async () => { /* name '资料库全部歌曲'，顺序与 kind */ });
it('pages playlist tracks from one cached bridge call', async () => {
    /* 先取 0..2 再取 2..4 → request('getPlaylistTracks') 只调用一次；total 等于记录数；hasMore 正确 */ });
it('returns a silent blob carrier without starting playback', async () => {
    /* getAudioSource → url 以 'blob:' 开头；request 调用里没有 'play' */ });
it('returns empty lyrics so the shared auto-match runs', async () => {
    expect(await appleMusicProvider.lyrics!.getLyrics(song)).toEqual({ lyrics: null, isPureMusic: false });
});
it('returns no user and reports not-configured when the probe says access is denied', async () => {
    /* request('probe') 返回 {ok:true,data:{running:true,permission:'denied'}} → getLoginStatus() 为 null，getAvailability() 为 { configured:false, reason:'not-configured' } */ });
it('reports not-configured after the bridge answers auth-required', async () => {
    /* 任意请求返回 {ok:false,error:{code:'auth-required'}} → requestAppleMusic 抛 OnlineProviderError('auth-required')，之后 getAvailability() 为 not-configured；下一次请求成功后恢复为 configured */ });
it('is runtime-unavailable without the desktop bridge', () => { /* 删除 window.electron.appleMusic → { configured:false, reason:'runtime-unavailable' } */ });
it('routes engine commands to the bridge with the song persistent id', async () => {
    /* externalPlayback.play(song, 12) → request('play', { id: 'ABCDEF0123456789', position: 12 })；setVolume(0.5) → request('setVolume', { volume: 0.5 }) */ });
```

- [ ] **Step 2：确认测试失败**

Run: `npx vitest run -c vitest.config.ts test/unit/onlineMusic/appleMusicProvider.test.ts`
Expected：FAIL，模块不存在。

- [ ] **Step 3：实现 transport、provider 和注册**

- [ ] **Step 4：确认测试通过，现有 provider 测试不受影响**

Run: `npx vitest run -c vitest.config.ts test/unit/onlineMusic && npm run typecheck`
Expected：全部 PASS，typecheck 无错误。

- [ ] **Step 5：提交**

```bash
git add src/services/onlineMusic/appleMusicTransport.ts src/services/onlineMusic/appleMusicProvider.ts src/services/onlineMusic/providerRegistry.ts test/unit/onlineMusic/appleMusicProvider.test.ts
git commit -m "feat(apple-music): 新增 apple-music provider" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7：账号与歌单装载 `useAppleMusicLibrary`，以及 i18n 文案

**Files：**
- Create：`src/hooks/useAppleMusicLibrary.ts`
- Modify：`src/App.tsx:741-753`（refreshers / logouts 两个 map 各加一项）
- Modify：`src/i18n/locales/zh-CN.ts`、`en.ts`、`in.ts`（新增顶层 `appleMusic` 对象）
- Test：`test/unit/hooks/useAppleMusicLibrary.test.ts`

**Interfaces：**
- Consumes：`omni.getProviderAvailability`、`omni.getLoginStatus`、`omni.getProviderUserPlaylists`；`providerAccountCache` 的 load / save / clear；`useOnlineProviderAccountStore`（`activeProviderId`、`updateAccount`、`clearAccount`）；`setStatusMessage`。
- Produces：`useAppleMusicLibrary(): { refresh(): Promise<boolean>; logout(): Promise<void> }`。

i18n 文案（三种语言的键必须一致）：

| key | zh-CN | en | in |
| --- | --- | --- | --- |
| `appleMusic.permissionDenied` | Folia 没有控制「音乐」App 的权限。请在「系统设置 → 隐私与安全性 → 自动化」中允许 Folia 控制「音乐」。 | Folia isn't allowed to control Music. Allow it in System Settings → Privacy & Security → Automation. | Folia belum diizinkan mengontrol Music. Izinkan di Pengaturan Sistem → Privasi & Keamanan → Otomatisasi. |
| `appleMusic.takeover` | 你在「音乐」App 里切了歌，Folia 已暂停同步。 | You changed the song in Music, so Folia stopped syncing. | Anda mengganti lagu di Music, jadi Folia berhenti menyinkronkan. |
| `appleMusic.engineStopped` | 「音乐」App 停止了播放，Folia 已暂停。 | Music stopped playing, so Folia paused. | Music berhenti memutar, jadi Folia dijeda. |
| `appleMusic.playFailed` | 「音乐」App 无法播放这首歌。 | Music couldn't play this song. | Music tidak dapat memutar lagu ini. |
| `appleMusic.exportUnsupported` | Apple Music 歌曲由「音乐」App 发声，无法导出带声音的视频。 | Apple Music songs play through the Music app, so they can't be exported with sound. | Lagu Apple Music diputar lewat aplikasi Music, jadi tidak bisa diekspor beserta suaranya. |
| `appleMusic.audioSettingsHint` | Apple Music 歌曲由「音乐」App 输出，不受这里的设置影响。 | Apple Music songs play through the Music app and aren't affected by these settings. | Lagu Apple Music diputar lewat aplikasi Music dan tidak terpengaruh pengaturan ini. |

行为（照 `useBodianLibrary` 的结构写，同样用 generation 计数丢弃过期结果）：

1. 挂载时：provider 没有注册（`omni.getProviderSummaries()` 里找不到 `'apple-music'`）就什么都不做。
2. 调 `omni.getLoginStatus('apple-music')`，它只会 `probe`，不会启动「音乐」App：
   - 返回 `null`，且可用性的 `reason === 'not-configured'` → `clearAccount('apple-music', 'apple-music-permission-denied')`，并在模块级标志控制下只提示一次 `t('appleMusic.permissionDenied')`
   - 返回 user → 用快照填 collections，`status:'authenticated'`，`hydration:'ready'`，`freshness:'stale'`
3. 只有 `activeProviderId === 'apple-music'` 时（挂载时就是，或之后切换过来）才拉取歌单：分页拉到 `hasMore` 为 false，然后保存快照，`freshness:'fresh'`。
4. 拉取歌单时出错：
   - `unavailable` → 保留快照，`freshness:'stale'`，不显示错误
   - `auth-required` → 按第 2 步的权限处理
   - 其他 → `freshness:'error'`
5. `logout`：清除账号和快照。

- [ ] **Step 1：写失败测试**

沿用 `useBodianLibrary.test.ts` 的写法：mock `react`，把 effects 收集起来手动执行；mock `omni` 和 `providerAccountCache`。

```ts
it('marks the local library as signed in from the probe without listing playlists at startup', async () => {
    /* activeProviderId 'netease'；getLoginStatus → {id:'local'} → updateAccount 写入 status 'authenticated'；getProviderUserPlaylists 未调用 */ });
it('does not list playlists at startup unless Apple Music is the active provider', async () => {
    /* activeProviderId 'apple-music' → 调用 getProviderUserPlaylists('apple-music','local',{offset:0,limit:50}) */ });
it('lists playlists once the listener switches to Apple Music', async () => {
    /* 先是 'netease'，然后 store.setActiveProviderId('apple-music') → 触发拉取 */ });
it('shows the permission hint once when access is denied', async () => {
    /* getLoginStatus null + availability not-configured → clearAccount(…,'apple-music-permission-denied')；refresh 两次，setStatusMessage 只调用一次 */ });
it('keeps the snapshot quietly when Music is not running', async () => {
    /* getProviderUserPlaylists 抛 OnlineProviderError('unavailable') → freshness 'stale'，且没有 error */ });
```

- [ ] **Step 2：确认测试失败**

Run: `npx vitest run -c vitest.config.ts test/unit/hooks/useAppleMusicLibrary.test.ts`
Expected：FAIL，模块不存在。

- [ ] **Step 3：实现 hook，接到 App，补齐三种语言的文案**

在 App 里：`const { refresh: refreshAppleMusicLibrary, logout: logoutAppleMusicLibrary } = useAppleMusicLibrary();`，再分别加进两个 map 的 `'apple-music'` 键。订阅 `activeProviderId` 时用 `useOnlineProviderAccountStore.subscribe`，在 effect 的清理函数里取消订阅。

- [ ] **Step 4：确认测试通过**

Run: `npx vitest run -c vitest.config.ts test/unit/hooks/useAppleMusicLibrary.test.ts test/unit/hooks/useBodianLibrary.test.ts test/unit/i18n && npm run typecheck`
Expected：PASS，typecheck 无错误。

- [ ] **Step 5：提交**

```bash
git add src/hooks/useAppleMusicLibrary.ts src/App.tsx src/i18n/locales test/unit/hooks/useAppleMusicLibrary.test.ts
git commit -m "feat(apple-music): 装载本机资料库账号与歌单" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8：单曲同步控制器 `ExternalPlaybackSync`

**Files：**
- Create：`src/services/externalPlayback/externalPlaybackSync.ts`
- Test：`test/unit/externalPlayback/externalPlaybackSync.test.ts`

**Interfaces：**
- Consumes：Task 2 的 `OmniExternalPlaybackEngine` / `OmniExternalPlaybackState`。
- Produces：

```ts
export const SYNC_DRIFT_IGNORE_SEC = 0.08;
export const SYNC_DRIFT_SEEK_SEC = 1;
export const SYNC_RATE_NUDGE = 0.05;
export const SYNC_START_TIMEOUT_MS = 8000;
export const SYNC_END_GRACE_SEC = 1.5;

export interface ExternalPlaybackCarrier {
    currentTime: number;
    playbackRate: number;
    readonly paused: boolean;
    readonly duration: number;
    pause(): void;
    play(): Promise<void>;
    addEventListener(type: 'play' | 'pause' | 'seeked', listener: () => void): void;
    removeEventListener(type: 'play' | 'pause' | 'seeked', listener: () => void): void;
}
export type ExternalPlaybackIssue =
    | { kind: 'takeover'; reason: 'track-changed' | 'engine-stopped' }
    | { kind: 'failure'; error: unknown };
export interface ExternalPlaybackSyncOptions {
    engine: OmniExternalPlaybackEngine;
    song: SongResult;                     // mediaId 取 sourceRef.mediaId
    carrier: ExternalPlaybackCarrier;
    now?: () => number;                   // 默认 Date.now
    setTimer?: (callback: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
    onHoldReleased: () => void;
    onIssue: (issue: ExternalPlaybackIssue) => void;
}
export class ExternalPlaybackSync {
    constructor(options: ExternalPlaybackSyncOptions);
    start(intent: 'play' | 'idle'): void;   // 起始位置读 carrier.currentTime
    abortStart(): void;
    dispose(options: { stopEngine: boolean }): Promise<void>;
}
```

行为规则（下面每条都对应一个测试）：

- **过期状态**：发出 `play` / `pause` / `resume` / `seek` 时记录 `lastCommandAtMs = now()`；`sampledAtMs < lastCommandAtMs` 的状态一律忽略。
- **推算位置**：状态为 `playing` 时 `est = positionSec + (now() − sampledAtMs) / 1000`；否则就是 `positionSec`。偏差 `drift = est − carrier.currentTime`。
- **内部操作要打标记**：控制器自己写 `currentTime`、调用 `pause()` / `play()` 之前先置标记，对应的 `seeked` / `pause` / `play` 事件只清掉标记，不转发给引擎。
- **`start('play')`**：
  - `held = true`，`startPos = carrier.currentTime`，发 `engine.play(song, startPos)`，启动 8 s 超时
  - 收到同一 `mediaId` 的 `playing` 状态时：如果 `|est − startPos| > 1` 且还没补发过 seek，就发 `engine.seek(startPos)`，继续 hold；否则把载体对齐到 `est`（内部 seek），解除 hold 并调用 `onHoldReleased()`
  - 超时 → `onIssue({ kind:'failure', error: new OnlineProviderError('not-playable', …, 'apple-music') })`
  - `play` 被 reject → `onIssue({ kind:'failure', error })`
- **`start('idle')`**：不发任何命令。之后载体触发 `play` 时，如果最近一次状态是同一 `mediaId` 且 `paused` → `resume`；其他情况 → `play(song, carrier.currentTime)`。
- **载体事件**（非内部触发）：
  - `pause` → `engine.pause()`
  - `play` → 规则同上：最近一次状态显示同曲在播就不发；暂停中就 `resume`；其他情况发 `play`
  - `seeked` → 最近一次状态是 `stopped` 或 `mediaId` 不同时（包括单曲循环回绕），并且载体在播 → `play(song, t)`；否则 → `seek(t)`
- **引擎状态**（非过期，且不在 hold 中）：
  - 同曲、`playing`：
    - 载体暂停着（且不是 ended）→ 视为外部继续，内部 `play()`
    - `|drift| < 0.08` → `playbackRate = 1`
    - `0.08 ≤ |drift| ≤ 1` → `playbackRate = 1 + sign(drift) × 0.05`
    - `|drift| > 1` → 内部 seek 到 `est`，`playbackRate = 1`
  - 同曲、`paused`，而载体在播 → 视为外部暂停，内部 `pause()`
  - 不同曲目、非 `stopped` → `takeover('track-changed')`：内部暂停，之后不再发任何命令，`dispose` 也不 `stop`
  - `stopped`，载体在播，距离结尾大于 1.5 s → `takeover('engine-stopped')`：内部暂停，但保持挂载，下次 `play` 事件会重新发 `play`
- **`abortStart()`**：清除超时；如果已经发过 `play`，就发 `pause`；`held = false`，不调用 `onHoldReleased`。
- **`dispose({ stopEngine })`**：退订，移除监听，清除计时器，`playbackRate = 1`；只有在 `stopEngine` 为真、本控制器发过命令、并且没有被 takeover 时才 `await engine.stop()`。

- [ ] **Step 1：写失败测试**

测试工具：
- `FakeCarrier`：`play()` / `pause()` 修改 `paused` 并派发对应事件；`userSeek(t)` 修改 `currentTime` 并派发 `seeked`；写 `currentTime` 本身不派发事件，测试需要时手动调 `dispatch('seeked')`
- `FakeEngine`：所有方法都是 `vi.fn().mockResolvedValue(undefined)`；`emit(state)` 调用订阅者
- 时间：`let clock = 1_000_000; now = () => clock`，计时器用 `vi.useFakeTimers()`

```ts
it('holds the carrier until Music reports the track playing, then aligns and releases', () => {
    sync.start('play');
    expect(engine.play).toHaveBeenCalledWith(song, 0);
    engine.emit(state({ state: 'playing', positionSec: 0.4, sampledAtMs: clock }));
    expect(carrier.currentTime).toBeCloseTo(0.4);
    expect(onHoldReleased).toHaveBeenCalledTimes(1);
});
it('re-seeks Music once when it starts far from the resume position', () => {
    carrier.currentTime = 120; sync.start('play');
    engine.emit(state({ state: 'playing', positionSec: 0.2 }));
    expect(engine.seek).toHaveBeenCalledWith(120);
    expect(onHoldReleased).not.toHaveBeenCalled();
});
it('fails with not-playable when Music never starts within 8 s', () => { /* advanceTimersByTime(8000) → onIssue failure，error.code === 'not-playable' */ });
it('sends nothing for an idle start', () => {
    sync.start('idle');
    for (const command of [engine.play, engine.pause, engine.resume, engine.seek, engine.stop, engine.setVolume]) {
        expect(command).not.toHaveBeenCalled();
    }
});
it('ignores drift under 80 ms', () => { /* drift 0.05 → playbackRate === 1，没有 seek */ });
it('nudges the carrier rate for drift between 80 ms and 1 s', () => {
    /* drift +0.3 → 1.05；drift −0.3 → 0.95；随后 drift 0.02 → 1 */ });
it('seeks the carrier for drift over 1 s without echoing the seek to Music', () => {
    /* drift 1.6 → carrier.currentTime = est；dispatch('seeked') → engine.seek 未调用 */ });
it('ignores a stale state sampled before the listener seek', () => {
    /* userSeek(90) → engine.seek(90)；再 emit 一个 sampledAtMs 早于这次 seek 的 playing 状态（position 10）→ carrier 仍在 90 */ });
it('mirrors listener pause, resume and seek to Music', () => { /* pause→pause、play→resume、userSeek(30)→seek(30) */ });
it('follows a pause and resume made in Music', () => { /* paused 状态 → carrier.paused 为 true 且 engine.pause 未调用；之后 playing → carrier.play 被调用 */ });
it('stops syncing when the listener changes the track in Music', () => {
    /* playing 但 mediaId 不同 → onIssue takeover track-changed，carrier 暂停；之后 userSeek 不再调用 engine；dispose({stopEngine:true}) 也不调用 stop */ });
it('treats an unexpected stop as engine-stopped and replays on the next play', () => {
    /* currentTime 60 / duration 200，stopped → takeover engine-stopped；carrier.play() → engine.play(song, 60) */ });
it('lets the track run out quietly near its end', () => { /* currentTime 199 / duration 200，stopped → 没有 onIssue */ });
it('replays Music when the carrier loops back to the start', () => { /* 先 stopped（在结尾），再 userSeek(0)（回绕）且 carrier 在播 → engine.play(song, 0) */ });
it('pauses Music when a pending start is aborted', () => { /* start('play') 后 abortStart() → engine.pause()，onHoldReleased 未调用 */ });
it('stops Music on dispose only when asked and only if it commanded playback', async () => { /* 三种情况 */ });
```

- [ ] **Step 2：确认测试失败**

Run: `npx vitest run -c vitest.config.ts test/unit/externalPlayback/externalPlaybackSync.test.ts`
Expected：FAIL，模块不存在。

- [ ] **Step 3：实现 `ExternalPlaybackSync`**

- [ ] **Step 4：确认测试通过**

Run：同 Step 2。Expected：PASS。

- [ ] **Step 5：提交**

```bash
git add src/services/externalPlayback/externalPlaybackSync.ts test/unit/externalPlayback/externalPlaybackSync.test.ts
git commit -m "feat(apple-music): 单曲同步控制器" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9：跨曲目会话与 App 接线

**Files：**
- Create：`src/services/externalPlayback/externalPlaybackSession.ts`
- Create：`src/hooks/useExternalPlaybackSync.ts`
- Modify：`src/App.tsx`
  - `syncOutputGain`（约 520 行）
  - `usePlaybackQueueController` 解构之后（约 1033 行之后）
  - `usePlaybackAudioBridge` 的 `isAutoplayHeld`（约 1353 行）
- Test：`test/unit/externalPlayback/externalPlaybackSession.test.ts`

**Interfaces：**
- Consumes：Task 8 的 `ExternalPlaybackSync`；`getPlaybackSongKey`；`PlayerState`。
- Produces：

```ts
export interface ExternalPlaybackSessionInput {
    song: SongResult | null;
    audioSrc: string | null;
    carrier: (ExternalPlaybackCarrier & { readyState: number; addEventListener(type: 'loadedmetadata', l: () => void): void;
        removeEventListener(type: 'loadedmetadata', l: () => void): void }) | null;
    playerState: PlayerState;
    wantsAutoplay: boolean;
}
export interface ExternalPlaybackSessionDeps {
    isExternal(song: SongResult | null | undefined): boolean;
    getEngine(song: SongResult): OmniExternalPlaybackEngine | null;
    createSync?(options: ExternalPlaybackSyncOptions): ExternalPlaybackSync;   // 测试注入点
    clearAutoplayIntent(): void;
    onIssue(issue: ExternalPlaybackIssue): void;
    now?: () => number;
}
export class ExternalPlaybackSession {
    constructor(deps: ExternalPlaybackSessionDeps);
    update(input: ExternalPlaybackSessionInput): void;
    isAutoplayHeld(song: SongResult | null, audioSrc: string | null): boolean;
    subscribe(listener: () => void): () => void;   // hold 释放时通知
    getVersion(): number;
    mirrorVolume(volume: number): void;             // 当前歌曲是外部播放时才生效，100 ms 尾部节流
    dispose(): void;
}

// src/hooks/useExternalPlaybackSync.ts
export function useExternalPlaybackSync(params: {
    audioRef: RefObject<HTMLAudioElement | null>;
    shouldAutoPlayRef: MutableRefObject<boolean>;
    activeDeck: string;
    onPlaybackFailure: () => void;
}): { autoplayHeld: boolean; mirrorVolume: (volume: number) => void };
```

会话规则：

- `key = song && audioSrc ? getPlaybackSongKey(song) + '|' + audioSrc : null`。
- **`key` 变化时**：
  - 旧的 sync 调 `dispose({ stopEngine: !isExternal(newSong) })`
  - 旧引擎 `setMonitoring(false)`（下一首仍是外部播放时跳过），新外部歌曲的引擎 `setMonitoring(true)`
  - 新歌曲是外部播放且有 carrier 时创建 sync；`carrier.readyState >= 1` 时立即 `start`，否则等 `loadedmetadata` 之后再 `start`
  - `wantsAutoplay` 为 true 时用 `'play'`，否则用 `'idle'`，并且直接把这个 key 记为已释放
- **`isAutoplayHeld`**：`isExternal(song) && audioSrc !== null && key !== releasedKey`。在同一次渲染里同步算出，这样 `usePlaybackAudioBridge` 的 effect 第一次见到新 `audioSrc` 时就已经被 hold 住。
- **hold 期间 `playerState` 从其他值变成 `PAUSED`**：`sync.abortStart()`，`clearAutoplayIntent()`，再把这个 key 记为已释放并通知订阅者。
- **`onIssue` 的分流**（在 hook 里做）：
  - takeover `track-changed` → 提示 `appleMusic.takeover`（info）
  - takeover `engine-stopped` → 提示 `appleMusic.engineStopped`（info）
  - failure 且 `OnlineProviderError.code === 'auth-required'` → `setPlayerState(PlayerState.PAUSED)` 并提示 `appleMusic.permissionDenied`（error），不跳歌
  - 其他 failure → 提示 `appleMusic.playFailed`（error），然后调 `onPlaybackFailure()`

App 接线：
- 在 `syncOutputGain` 之前声明 `const externalVolumeMirrorRef = useRef<(volume: number) => void>(() => {});`，在 `syncOutputGain` 钳制之后调用 `externalVolumeMirrorRef.current(clampedVolume);`
- hook 放在 `skipAfterPlaybackFailure` 可用之后：`const externalPlayback = useExternalPlaybackSync({ audioRef, shouldAutoPlayRef: shouldAutoPlay, activeDeck: automix.activeDeck, onPlaybackFailure: skipAfterPlaybackFailure });` 并赋值 `externalVolumeMirrorRef.current = externalPlayback.mirrorVolume;`
- `usePlaybackAudioBridge` 的参数改为 `isAutoplayHeld: automix.autoplayHeld || externalPlayback.autoplayHeld`

hook 本身很薄：用 `useState(() => new ExternalPlaybackSession(...))`；用 `useSyncExternalStore(session.subscribe, session.getVersion)` 在 hold 释放时触发重渲染；在依赖 `[currentSong, audioSrc, playerState, activeDeck]` 的 effect 里调用 `session.update({ …, carrier: audioRef.current, wantsAutoplay: shouldAutoPlayRef.current })`；卸载时 `dispose`。

- [ ] **Step 1：写失败测试**

`createSync` 注入一个返回 fake sync（`start` / `abortStart` / `dispose` 都是 `vi.fn`）的工厂，记录它收到的 options。

```ts
it('holds autoplay for a new external song in the same render that receives its source', () => {
    expect(session.isAutoplayHeld(appleSong, 'blob:carrier')).toBe(true);
    expect(session.isAutoplayHeld(neteaseSong, 'https://x')).toBe(false);
});
it('starts with play intent once the carrier has metadata and releases the hold on request', () => {
    /* readyState 0 → 不 start；派发 loadedmetadata → start('play')；调用 options.onHoldReleased() → isAutoplayHeld 为 false，订阅者被通知 */ });
it('starts idle and does not hold when nothing wants to autoplay', () => { /* wantsAutoplay false → start('idle')，isAutoplayHeld false */ });
it('pauses the engine and clears autoplay when the listener pauses during the start hold', () => {
    /* update(PLAYING) 后 update(PAUSED) → abortStart 被调用，clearAutoplayIntent 被调用，isAutoplayHeld 为 false */ });
it('stops Music when moving to a non-external song and keeps it when moving to another Apple song', () => {
    /* apple→netease：dispose({stopEngine:true}) 且 setMonitoring(false)；apple→apple：dispose({stopEngine:false}) 且 monitoring 保持开启 */ });
it('mirrors volume only while an external song is current', () => { /* netease 时 mirrorVolume → 引擎 setVolume 未调用；apple 时 100 ms 内的多次调用只保留最后一次 */ });
it('forwards sync issues to the dependency', () => { /* options.onIssue(x) → deps.onIssue(x) */ });
```

- [ ] **Step 2：确认测试失败**

Run: `npx vitest run -c vitest.config.ts test/unit/externalPlayback/externalPlaybackSession.test.ts`
Expected：FAIL，模块不存在。

- [ ] **Step 3：实现 session、hook 和 App 接线**

- [ ] **Step 4：确认测试通过，并检查播放相关的现有测试**

Run: `npx vitest run -c vitest.config.ts test/unit/externalPlayback test/unit/playback test/unit/hooks && npm run typecheck`
Expected：PASS，typecheck 无错误。

- [ ] **Step 5：提交**

```bash
git add src/services/externalPlayback/externalPlaybackSession.ts src/hooks/useExternalPlaybackSync.ts src/App.tsx test/unit/externalPlayback/externalPlaybackSession.test.ts
git commit -m "feat(apple-music): 接上外部播放同步、开播 hold 与音量" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10：排除项

**Files：**
- Create：`src/services/externalPlayback/externalPlaybackGuards.ts`
- Create：`src/utils/visualizerSignal.ts`
- Modify：`src/services/onlinePlayback.ts:52-64`
- Modify：`src/services/prefetchService.ts`（`analyseForAutomix` 约 49 行；音频预取段约 215 行）
- Modify：`src/services/automix/useAutomixDecks.ts`（`harvestDeck` 约 293 行；`checkTransitionPoint` 中 `nextSong` 解析之后约 572 行；stems effect 约 719 行）
- Modify：`src/hooks/useElectronVideoExportController.ts`（`startExport` 里 `!audioElement || !currentSong` 判断之后）
- Modify：`src/hooks/usePlaybackVisualizerBridge.ts`（`hasAudibleSignal` 约 88 行）
- Modify：`src/utils/mediaSessionSync.ts`（`createMediaSessionPositionState`、`publishMediaSessionTrack`）与 `src/hooks/useMediaSessionBridge.ts:141`
- Test：
  - `test/unit/externalPlayback/externalPlaybackGuards.test.ts`
  - `test/unit/utils/visualizerSignal.test.ts`
  - `test/unit/utils/mediaSessionSync.test.ts`（追加）
  - `test/unit/onlinePlayback.test.ts`（追加）

**Interfaces：**
- Produces：
  - `involvesExternalPlayback(...songs: Array<SongResult | null | undefined>): boolean`
  - `resolveHasAnalyserSignal({ isActuallyPlaying, isTransitionAudible, isExternalPlayback }: { isActuallyPlaying: boolean; isTransitionAudible: boolean; isExternalPlayback: boolean }): boolean`
  - `createMediaSessionPositionState(audio, options?: { reportUnitRate?: boolean })`
  - `publishMediaSessionTrack(mediaSession, audio, track, createMetadata?, options?: { reportUnitRate?: boolean })`

各处改法：
- `onlinePlayback`：歌曲是外部播放时，返回 `{ kind:'ok', audioSrc: url, blobUrl: url, replayGain }`，并跳过 `updatePrefetchedAudioUrl`。
- `prefetchService`：外部播放歌曲跳过整个音频预取段；`analyseForAutomix` 开头加 `if (involvesExternalPlayback(song)) return;`。
- `useAutomixDecks`：
  - `checkTransitionPoint` 里 `if (involvesExternalPlayback(currentSong, nextSong)) return report(`${audioSrc}:external`, 'external playback engine, hard cut');`
  - `harvestDeck` 和 stems effect 开头也做同样判断，直接 return
- 视频导出：`omni.isExternalPlaybackSong(currentSong)` 为真时，按 `export.noRecordableContent` 那段的写法 `setExportState(error: t('appleMusic.exportUnsupported'))` 后 return。
- 可视化：`hasAudibleSignal = resolveHasAnalyserSignal({ isActuallyPlaying, isTransitionAudible: isTransitionAudible(), isExternalPlayback })`，其中 `isExternalPlayback` 从 store 里的 `currentSong` 经 `omni.isExternalPlaybackSong` 得到。注意：时钟仍然由 `isActuallyPlaying` 驱动，只有频段回落到呼吸动画。
- 媒体会话：传入 `{ reportUnitRate: omni.isExternalPlaybackSong(currentSong) }`。

- [ ] **Step 1：写失败测试**

```ts
// externalPlaybackGuards.test.ts（mock omni.isExternalPlaybackSong：providerId === 'apple-music' 时为 true）
it('is true when any of the songs plays through an external engine', () => {
    expect(involvesExternalPlayback(neteaseSong, appleSong)).toBe(true);
    expect(involvesExternalPlayback(neteaseSong, null, undefined)).toBe(false);
});

// visualizerSignal.test.ts
it('drops to the idle animation for external playback even while the carrier plays', () => {
    expect(resolveHasAnalyserSignal({ isActuallyPlaying: true, isTransitionAudible: false, isExternalPlayback: true })).toBe(false);
    expect(resolveHasAnalyserSignal({ isActuallyPlaying: true, isTransitionAudible: false, isExternalPlayback: false })).toBe(true);
    expect(resolveHasAnalyserSignal({ isActuallyPlaying: false, isTransitionAudible: true, isExternalPlayback: false })).toBe(true);
});

// mediaSessionSync.test.ts
it('reports a unit rate while the carrier is being nudged', () => {
    expect(createMediaSessionPositionState({ currentTime: 10, duration: 100, playbackRate: 1.05 }, { reportUnitRate: true })?.playbackRate).toBe(1);
    expect(createMediaSessionPositionState({ currentTime: 10, duration: 100, playbackRate: 1.05 })?.playbackRate).toBe(1.05);
});

// onlinePlayback.test.ts：新增 hoisted 的 isExternalMock（默认返回 false），并在 omni mock 里加上 isExternalPlaybackSong: isExternalMock；Task 11 沿用它
it('hands an external carrier back as a blob to revoke and never stores it as a prefetched URL', async () => {
    /* isExternalMock → true；getAudioSource → { url: 'blob:carrier' } → 结果 { kind:'ok', audioSrc:'blob:carrier', blobUrl:'blob:carrier' }；updatePrefetchedAudioUrlMock 未调用 */ });
```

- [ ] **Step 2：确认测试失败**

Run: `npx vitest run -c vitest.config.ts test/unit/externalPlayback/externalPlaybackGuards.test.ts test/unit/utils/visualizerSignal.test.ts test/unit/utils/mediaSessionSync.test.ts test/unit/onlinePlayback.test.ts`
Expected：新增用例 FAIL。

- [ ] **Step 3：按上面的改法实现**

- [ ] **Step 4：确认测试通过，并检查 Automix 和预取的现有测试**

Run: `npx vitest run -c vitest.config.ts test/unit/externalPlayback test/unit/utils test/unit/onlinePlayback.test.ts test/unit/prefetchService.test.ts test/unit/automix && npm run typecheck`
Expected：PASS，typecheck 无错误。

- [ ] **Step 5：提交**

```bash
git add src/services/externalPlayback/externalPlaybackGuards.ts src/utils/visualizerSignal.ts src/services/onlinePlayback.ts src/services/prefetchService.ts src/services/automix/useAutomixDecks.ts src/hooks/useElectronVideoExportController.ts src/hooks/usePlaybackVisualizerBridge.ts src/utils/mediaSessionSync.ts src/hooks/useMediaSessionBridge.ts test/unit
git commit -m "feat(apple-music): 外部播放歌曲跳过 Automix、预取、导出与音频分析" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11：歌词强制自动匹配

**Files：**
- Modify：`src/services/onlinePlayback.ts`
  - 第 98 行附近的缓存早退条件（保持不变：已有缓存的匹配结果照常使用）
  - 第 166 行的 `shouldAutoMatch`
- Modify：`src/services/prefetchService.ts`（约 282 行的 `shouldAutoMatch`）
- Modify：`src/components/app/playback/restorePlaybackSource.ts`（约 262–279 行的 `omni.getLyrics` 分支）
- Test：`test/unit/onlinePlayback.test.ts`（追加）

**Interfaces：**
- Consumes：Task 2 的 `omni.isExternalPlaybackSong`；现有的 `loadOnlineSongLyrics(song, prefetched, userId, callbacks)`。

改法：
- 两处 `shouldAutoMatch` 都改成 `(settings.autoUseBestLyric || omni.isExternalPlaybackSong(song)) && !onlineLyricsState?.hasOnlineOverride`。
- `restorePlaybackSource`：缓存未命中、歌曲是外部播放时，改为
  `await loadOnlineSongLyrics(song, null, effectiveUserId, { isCurrent: () => isSamePlaybackSong(usePlaybackStore.getState().currentSong, song), onLyrics: setLyrics, onDone: () => {} })`，然后 `return true`。
  - 如果 `isSamePlaybackSong` 不接受 null，先判空。

- [ ] **Step 1：写失败测试**

把 `useLyricSettingsStore` 的 mock 改成读一个 hoisted 的可变对象，默认 `autoUseBestLyric: true`。

```ts
it('auto-matches an external-playback song even when auto-use-best-lyric is off', async () => {
    lyricSettings.autoUseBestLyric = false;
    isExternalMock.mockReturnValue(true);
    lyricsMock.mockResolvedValue({ lyrics: null, isPureMusic: false });
    autoMatchMock.mockResolvedValue({ id: 1, source: 'qq', lyrics: parsedFixture, isPureMusic: false });
    await loadOnlineSongLyrics(appleSong, null, null, callbacks);
    expect(autoMatchMock).toHaveBeenCalledWith(appleSong.name, 'Artist', appleSong.durationMs, expect.objectContaining({ album: 'Album', providerCandidate: undefined }));
    expect(callbacks.onLyrics).toHaveBeenLastCalledWith(parsedFixture);
});
it('still respects the setting for ordinary provider songs', async () => {
    lyricSettings.autoUseBestLyric = false;
    isExternalMock.mockReturnValue(false);
    await loadOnlineSongLyrics(neteaseSong, null, null, callbacks);
    expect(autoMatchMock).not.toHaveBeenCalled();
});
```

- [ ] **Step 2：确认测试失败**

Run: `npx vitest run -c vitest.config.ts test/unit/onlinePlayback.test.ts`
Expected：第一个新增用例 FAIL（`autoMatchMock` 未被调用）。

- [ ] **Step 3：实现三处改动**

- [ ] **Step 4：确认测试通过**

Run: `npx vitest run -c vitest.config.ts test/unit/onlinePlayback.test.ts test/unit/prefetchService.test.ts && npm run typecheck`
Expected：PASS，typecheck 无错误。

- [ ] **Step 5：提交**

```bash
git add src/services/onlinePlayback.ts src/services/prefetchService.ts src/components/app/playback/restorePlaybackSource.ts test/unit/onlinePlayback.test.ts
git commit -m "feat(apple-music): Apple Music 歌曲总是自动匹配歌词" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12：收尾：设置说明、文档与真机验收

**Files：**
- Modify：`src/components/panelTab/AudioEqualizerDialog.tsx`（对话框正文顶部）
- Modify：`src/components/modal/settings/PlaybackSettingsSubview.tsx`（输出设备选择器旁）
- Modify：`src/services/onlineMusic/README.md`（Layer map 加 `appleMusicProvider.ts → appleMusicTransport.ts → electron/appleMusic/musicAppBridge.cjs`；「Provider and cache files」加一段说明外部播放引擎与静音载体）

- [ ] **Step 1：两处设置说明**

当前歌曲满足 `omni.isExternalPlaybackSong(currentSong)` 时，用现有的次级说明文字样式显示 `t('appleMusic.audioSettingsHint')`。`currentSong` 从 `usePlaybackStore` 读取。

- [ ] **Step 2：更新 README**

- [ ] **Step 3：完整单测与类型检查**

Run: `npm run test:unit && npm run typecheck`
Expected：全部 PASS（与基线相比没有新增失败）。

- [ ] **Step 4：真机验收（需要用户参与，`npm run dev:electron`）**

逐项勾选 spec 的「真机验收清单」，把结果追加到 spec 末尾的 `## 真机验收结果`。不通过的项要记录现象，回到对应任务修复。

- [ ] **Step 5：提交**

```bash
git add src/components/panelTab/AudioEqualizerDialog.tsx src/components/modal/settings/PlaybackSettingsSubview.tsx src/services/onlineMusic/README.md docs/superpowers/specs/2026-10-11-apple-music-app-bridge-design.md
git commit -m "docs(apple-music): 设置说明、Omni 文档与真机验收记录" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
