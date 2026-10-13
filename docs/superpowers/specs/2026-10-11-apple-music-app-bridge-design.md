# Apple Music 接入设计：遥控 macOS「音乐」App

- 日期：2026-10-11
- 状态：设计已逐段确认，待审阅书面稿
- 范围：仅本 fork 使用，不提交上游

## 背景与决策记录

上游 issue #226 有过两次尝试：PR #357 在 Folia 内嵌 MusicKit JS，已关闭，原因是 developer token 需要 Apple Developer Program 身份，且要把 Electron 换成 castLabs 运行时；另一个提议是用独立 companion 进程加载 `music.apple.com`。本设计不走这两条路，原因如下：

| 约束 / 偏好 | 结论 |
| --- | --- |
| 只给自己的 fork 用 | 不考虑上游接受度与合并成本 |
| 不额外花钱 | 不开 Apple Developer Program（不能自签 developer token） |
| 有 Apple Music 订阅，主平台 macOS | 「音乐」App 本身就能播放完整曲目 |
| 主要播放资料库里的歌和歌单 | AppleScript/JXA 能覆盖资料库，不需要 MusicKit 的曲库能力 |
| 在 Folia 里选歌，Folia 管队列，可与其他平台混排 | 「音乐」App 只作为音频引擎，队列与切歌由 Folia 负责 |
| 最看重歌词的动态可视化 | 采用「静音载体」方案：歌词时钟用浏览器媒体时钟，天然平滑 |

已比较过的接入方式：

- **静音载体（采用）**：Folia 的 `<audio>` 播放与曲目等长的静音音频，现有队列、`ended` 切歌、歌词时钟、媒体会话等全部照常工作；同步控制器把控制转发给「音乐」App，并用其真实进度校正载体。
- 播放引擎抽象层（未采用）：要改造 17 个文件里的 68 处 `audioRef.current`，其中大量是只对真实媒体元素有意义的逻辑（Web Audio 图、Automix 双 deck、`setSinkId`、`captureStream`）；还要从「音乐」App 的粗粒度进度自建时钟，在歌词平滑度上反而更难做好。
- 伪造 `HTMLAudioElement`（未采用）：Web Audio 图与 Automix deck 要求真实媒体元素，过于脆弱。

Spotify 另作第二个子项目：没有 Premium 时只能用 AppleScript 控制 Spotify.app（按 URI 播放、控制、读进度），无法搜索与浏览。届时复用本设计的静音载体与同步控制器，只替换控制后端。

## 目标

1. Folia 中出现「Apple Music」provider，可搜索资料库、浏览「音乐」App 的用户歌单与「资料库全部歌曲」。
2. Apple 曲目可加入 Folia 队列，与网易云、QQ 等平台的歌曲混排；由「音乐」App 发声，Folia 负责队列与切歌。
3. 逐字歌词动效与「音乐」App 的真实播放保持同步。

### 成功标准

- 稳定播放时，载体与「音乐」App 的推算位置偏差保持在 30 ms 以内。
- 拖动进度、暂停后继续，2 秒内重新收敛到上述范围，且歌词不出现可见的前后跳动（除偏差 > 1 s 的直接对齐外）。
- 开播时第一句歌词不早于「音乐」App 实际出声。
- 两首 Apple 曲目之间的空隙小于 1 秒。

## 非目标（第一版不做）

- 播放未加入资料库的 Apple Music 曲库歌曲；推荐、电台、专辑页、歌手页。
- 喜欢、歌单增删等写操作。
- Apple 曲目的 EQ、音效、输出设备选择、ReplayGain、Automix 过渡、媒体缓存、视频导出。
- Apple 曲目的音频响度驱动可视化（回落为待机呼吸动画）。
- Windows、Linux、网页版。
- Apple 自有的 TTML 逐字歌词（需要 developer token）；本地文件内嵌的纯文本歌词；通过 iTunes Search 反查曲库 ID。
- 暂停时「音乐」App 的音量淡出（Folia 的淡出作用在静音载体上，「音乐」App 会直接停）。

## 架构总览

```text
Folia 队列 ──▶ omni ──▶ apple-music provider ──▶ IPC ──▶ 主进程桥接 ──▶ 常驻 JXA ──▶「音乐」App（发声）
     │                                                        │
     │                                                        └── 每秒 getState（仅 Apple 曲目播放时）
     ▼                                                                 │
<audio> 播放等长静音载体 ◀──── 对齐 / 转发 ──── 同步控制器 ◀─────────────┘
     │
     └──▶ 歌词时钟、可视化、队列、媒体会话、Discord 等现有链路（不改动）
```

## 1. Provider 与歌曲身份

- 新增 Omni provider `apple-music`，显示名「Apple Music」。
- **只在 macOS 桌面版注册**（`window.electron?.platform === 'darwin'`），其他平台不注册。恢复会话时这些歌曲会被 `useSessionRestoreController` 留在缓存中不播放，而不是报「播放失败」。注册表已支持运行时注册。
- 歌曲身份：`sourceRef = { kind: 'online', providerId: 'apple-music', mediaId: <persistent ID> }`，`id` 同为 persistent ID 字符串（16 位十六进制）。
- 能力：
  - 支持：`search`（资料库搜索）、`playback`、`lyrics`、`auth`、`userLibrary`、`playlists`。
  - 新增 `ProviderCapabilities.externalPlayback?: boolean`，并在 `omni.ts` 提供 `omni.isExternalPlaybackSong(song)`，供 hooks、services 判断。`utils` 是叶子层，不在 `appPlaybackGuards.ts` 里读注册表。
  - 不支持：专辑、歌手、推荐、写操作。
- 账号：不扫码。`auth.getLoginStatus()` 在桥接可用且已获自动化授权时返回合成用户（`id: 'local'`，昵称「本机音乐资料库」），未授权时返回 `null` 并通过错误信息给出权限指引。
- 新增 `useAppleMusicLibrary`，仿照 `src/hooks/useBodianLibrary.ts`：启动时调用 `getLoginStatus` → `getProviderUserPlaylists` → `updateAccount`，在用户选中该 provider 之前就把状态补成 `authenticated`，避免进入 `providerLoginSession` 的扫码流程。
- 集合：
  - 「音乐」App 的用户歌单（含智能歌单，跳过文件夹），加上「资料库全部歌曲」。
  - 曲目分页：主进程一次性批量读取整个歌单的元数据并缓存，按 `limit/offset` 切片返回。
- 封面：主进程用 JXA 取出 artwork 原始数据，存入现有 `folia-cover://` 内容寻址缓存（`electron/localCoverAssets.cjs`），列表懒加载。

## 2. 主进程桥接

- 常驻 `osascript -l JavaScript` 子进程，stdin/stdout 逐行 JSON 协议，每条命令带请求 id 与超时；进程意外退出时按退避策略重启。
- 命令集：

| 命令 | 说明 |
| --- | --- |
| `probe` | 是否运行、是否已授权；不会顺带启动「音乐」App |
| `listPlaylists` | 用户歌单与资料库 |
| `getPlaylistTracks(id)` | 批量属性读取 |
| `searchLibrary(query, limit)` | 「音乐」App 自带资料库搜索 |
| `getTrack(id)` | 单曲元数据，时长为精确小数秒 |
| `getArtwork(id)` | 封面原始数据 |
| `play(id, position)` | 只播这一首，播完即停（`once`，待 spike 验证） |
| `pause` / `resume` / `seek(sec)` / `setVolume(0–100)` / `stop` | 播放控制 |
| `getState` | `{ state, persistentId, position, duration, sampledAt }` |

- 状态推送：只在当前歌曲是 Apple 曲目时，每秒轮询一次 `getState`；每条控制命令执行后立即补查一次。结果通过 IPC 事件推给渲染进程。
- 安全：
  - IPC handler 一律经 `isTrustedMainWindowContents` 校验来源。
  - persistent ID 用 `/^[0-9A-F]{16}$/i` 校验。
  - 搜索词等参数以 JSON 数据传入 JXA，不拼接进脚本。
- 权限与打包：
  - `package.json` 的 `build.mac.extendInfo` 增加 `NSAppleEventsUsageDescription`。
  - 拒绝授权时错误码为 -1743，映射为权限错误。
  - 当前未开启 hardened runtime；日后开启需加 `com.apple.security.automation.apple-events`。
- 文件布局沿用 `electron/macWallpaperController.cjs` 的写法：模块内不 import Electron，`spawn` 注入以便单测，darwin 门控，失败时软降级。
  - `electron/appleMusic/musicAppBridge.cjs`：JXA 脚本以字符串内嵌，避免打包漏文件。
  - `electron/main.cjs`：仅 darwin 懒加载并注册 `apple-music-*` IPC；`before-quit` 时如果是 Folia 发起的播放，就停止「音乐」App。
  - `electron/preload.cjs`：暴露 `window.electron.appleMusic.*`，事件监听返回取消订阅函数。
  - `src/vite-env.d.ts`：渲染进程类型。
  - `src/services/onlineMusic/appleMusicTransport.ts`：渲染进程侧 transport。

## 3. 静音载体与同步控制器

### 载体

- 由 provider 的 `playback.getAudioSource` 生成：8 kHz、单声道、8-bit PCM 静音 WAV（样本值 `0x80`），时长取「音乐」App 的精确小数秒时长，约 0.5 MB/分钟。
- 经 `createSafeObjectUrl` 生成 `blob:` 地址。`cachePlayedTrackAssets`、`ended` 时的缓存、在线音源刷新与 `onError` 重试本来就会跳过 `blob:`。
- `loadOnlineSongAudioSource` 对 Apple 曲目返回 `{ audioSrc, blobUrl }`，以便切歌时回收，并跳过 `updatePrefetchedAudioUrl`。
- 生成载体不会启动「音乐」App（预取也会调用 `getAudioSource`）。只有同步控制器发播放命令。

### 同步控制器

- 纯逻辑类（建议 `src/services/externalPlayback/externalPlaybackSync.ts`），注入桥接接口、媒体元素与时钟；由 `src/hooks/useExternalPlaybackSync.ts` 接到当前 deck 的 `<audio>` 与播放 store。

1. **开播不抢跑**：复用 `usePlaybackAudioBridge` 的 autoplay hold（`isAutoplayHeld`）。载体加载完成后保持不播，同时发 `play(id, 位置)`；等「音乐」App 报告该曲目处于 playing，再放开载体并对齐位置。
2. **Folia → 「音乐」App**：
   - 载体 `pause` → `pause`
   - 载体 `play`（继续）→ `resume`
   - 用户触发的 `seeked` → `seek`
   - 音量在 `syncOutputGain`（`src/App.tsx` 约 520 行）的钳制之后同步过去，节流，0–1 线性映射到 0–100。
   - 控制器自己的校正 seek 带内部标记，不回传。
3. **漂移校正**：用 `position + (now − sampledAt)` 推算「音乐」App 的当前位置，与载体比较：
   - 偏差 < 30 ms：不处理。
   - 30 ms – 1 s：把载体 `playbackRate` 调到 1±0.05，持续若干秒追平，逐字动画不跳。
   - > 1 s：直接 seek 载体（内部标记）。
   - `playbackRate` 目前只被 Automix 的 `tempoBend` 使用，Apple 曲目上 Automix 已关闭，不冲突。
4. **「音乐」App 侧的意外变化**：
   - 外部暂停或继续（含拔耳机）：载体跟随，保持 Folia 状态一致。
   - 外部切到其他曲目：视为用户接管。载体暂停，本曲停止同步，提示「你在音乐 App 里切了歌，Folia 已暂停同步」。
   - 「音乐」App 退出或报错：载体暂停并提示；再次播放时重新发 `play`。
5. **切歌与结束**：
   - 载体 `ended` 由 Folia 队列切歌。下一首是 Apple 曲目就发 `play(下一首)`，否则发 `stop`。
   - 单曲循环时载体带原生 `loop`，不触发 `ended`。检测到非用户触发的「结尾 → 开头」回绕时，重新发 `play`。
   - 离开 Apple 曲目、停止播放、退出 Folia 时停止「音乐」App。
   - 启动同步时若「音乐」App 已在播放目标曲目（例如壁纸模式重启交接），只对齐位置，不重发 `play`。

## 4. 歌词

- provider 实现 `lyrics.getLyrics`，返回 `{ lyrics: null, isPureMusic: false }`。不能缺省：缺省会让 `omni.getLyrics` 抛 `unsupported`，跳过匹配。
- Apple 曲目不受 `autoUseBestLyric` 开关约束，总是自动匹配。改动位置：
  - `src/services/onlinePlayback.ts` 约 166 行（播放）
  - `src/services/prefetchService.ts` 约 282 行（预取）
  - `src/components/app/playback/restorePlaybackSource.ts`（会话恢复路径，现无自动匹配；缓存未命中时补一次）
- 匹配依据：标题、艺人、专辑、精确时长（经 `getProviderSongMetadata`）。
- 匹配来源：现有 QQ、网易云（含 AMLL 逐字库）、酷狗，按用户设置的优先级，逐字歌词优先。
- 匹配结果按 `apple-music:<persistent ID>` 存入歌词缓存与在线覆盖记录。
- 预取只跳过音频，歌词照常提前匹配。
- 手动「重新匹配歌词」与匹配弹窗对 Apple 曲目可用。

## 5. 排除项与错误处理

### 需要跳过 Apple 曲目的位置

| 位置 | 处理 |
| --- | --- |
| `src/services/automix/useAutomixDecks.ts` `checkTransitionPoint`（约 572 行后） | 当前或下一首为 Apple 曲目时不过渡，硬切 |
| 同文件 stems 效果（约 719 行）、`harvestDeck`（约 293 行） | 跳过 |
| `src/services/prefetchService.ts` `prefetchSong` 音频段（约 215–238 行）、`analyseForAutomix`（约 49 行） | 跳过音频与分析，保留歌词 |
| `src/services/onlinePlayback.ts` `loadOnlineSongAudioSource` | 返回 `blobUrl`，不写预取缓存 |
| `src/hooks/useElectronVideoExportController.ts`（约 106 行） | 拒绝导出并提示原因 |
| `src/utils/mediaSessionSync.ts` | Apple 曲目上报速率固定为 1 |
| `src/hooks/usePlaybackVisualizerBridge.ts`（约 121–131 行） | Apple 曲目按「无分析信号」处理，回落待机呼吸动画，避免频段被静音拉平 |
| EQ、音效、输出设备设置 | 增加一行说明：Apple Music 曲目由音乐 App 输出，不受这些设置影响 |

无需改动：Discord、媒体会话元数据、Stage API、ReplayGain（无数据时为 0 dB）、壁纸模式交接。

### 错误处理

| 情况 | 处理 |
| --- | --- |
| 「音乐」App 未运行 | 播放时自动启动，启动延迟由开播 hold 覆盖 |
| 自动化权限被拒（-1743） | provider 显示错误与权限指引。播放时暂停并提示，不跳歌，避免整个队列被跳过 |
| 曲目不可播放（已删除、云端不可用、订阅过期、地区限制） | 8 秒内未进入 playing 或报错时，抛 `OnlineProviderError('not-playable')`，交给现有的失败跳歌逻辑 |
| JXA 进程崩溃 | 退避重启，进行中的命令重试一次；仍失败则暂停并提示 |
| Folia 退出 | 如果是 Folia 发起的播放，`before-quit` 时停止「音乐」App |

## 6. 测试与验证

### 第 0 步：spike（真机，代码验完即弃）

1. 「音乐」App 的 `play` 是否支持 `once`。不支持时的退路：检测到自动续播立即暂停。
2. 常驻 JXA 的 stdin 循环是否可行，测命令延迟。
3. Chromium `<audio>` 能否播放 8 kHz / 8-bit WAV。不行时改用 16-bit（约 1 MB/分钟）。
4. `player position` 的精度与更新粒度。

### 单元测试（Vitest）

- `test/unit/electron/appleMusicBridge.test.ts`：注入假 `spawn`，覆盖分帧、请求 id、超时、退避重启、ID 校验、-1743 映射。
- `test/unit/onlineMusic/appleMusicProvider.test.ts`：归一化与 `sourceRef` 身份、能力声明、`getLyrics` 空结果、载体为 `blob:`。
- 静音 WAV 生成器：文件头与字节长度。
- 同步控制器（假桥接、假媒体元素、假时钟）：
  - 开播 hold 与放开
  - 三档漂移处理
  - 内部 seek 不回传，用户 seek 回传
  - 外部暂停/继续跟随
  - 外部切歌暂停同步
  - 「音乐」App 退出
  - `ended` 后的 `play` / `stop`
  - 单曲循环回绕
  - 已在播同一首时只对齐
- 排除项：Automix 不过渡、预取跳过音频、Apple 曲目强制自动匹配、可视化无信号回落、视频导出拒绝。
- `npm run typecheck`；单测按路径过滤运行；不做完整构建与打包。

### 真机验收清单（macOS）

- [ ] 首次控制弹出授权；拒绝后显示指引
- [ ] 大资料库的歌单加载速度可接受
- [ ] 播放、暂停、拖进度、切歌（含 Apple ↔ 网易云混排来回切换）
- [ ] 逐字歌词同步：整首播放、拖动后、暂停继续后均无抢跑或拖后
- [ ] 在「音乐」App 中手动切歌，Folia 暂停同步并提示
- [ ] 「音乐」App 未运行时自动启动；退出 Folia 后「音乐」App 停止
- [ ] 单曲循环；壁纸模式重启交接

## 改动文件概览

新增：

- `electron/appleMusic/musicAppBridge.cjs`
- `src/services/onlineMusic/appleMusicTransport.ts`
- `src/services/onlineMusic/appleMusicProvider.ts`（按需拆出 `appleMusicNormalize.ts`）
- `src/services/externalPlayback/silentCarrier.ts`
- `src/services/externalPlayback/externalPlaybackSync.ts`
- `src/hooks/useExternalPlaybackSync.ts`
- `src/hooks/useAppleMusicLibrary.ts`
- 对应单元测试

修改：

- `src/types/onlineMusic.ts`
- `src/services/onlineMusic/omni.ts`
- `src/services/onlineMusic/providerRegistry.ts`
- `src/services/onlinePlayback.ts`
- `src/services/prefetchService.ts`
- `src/components/app/playback/restorePlaybackSource.ts`
- `src/services/automix/useAutomixDecks.ts`
- `src/hooks/usePlaybackAudioBridge.ts`
- `src/hooks/usePlaybackVisualizerBridge.ts`
- `src/utils/mediaSessionSync.ts`
- `src/hooks/useElectronVideoExportController.ts`
- EQ / 输出设备设置组件
- `src/App.tsx`（只做最小装配：音量同步与 hook 接线，逻辑放在 hooks / `components/app/*`）
- `electron/main.cjs`、`electron/preload.cjs`、`src/vite-env.d.ts`
- `package.json`（`build.mac.extendInfo`）
- i18n 文案（`zh-CN`、`en`、`in`）
- `src/services/onlineMusic/README.md`（provider 清单与外部播放说明）

## 待在实施计划中确认的细节

- 自动化权限未授予时用户选中 Apple Music 的交互：显示权限指引，不能落入 `providerLoginSession` 的扫码流程（它在缺少二维码能力时会失败）。
- `syncOutputGain` 位于 `App.tsx`，音量同步的接线方式以最小改动为准（例如通过 hook 订阅目标音量）。
- autoplay hold 与现有 Automix hold 的叠加方式（两者是「或」关系）。

## Spike 结论（2026-10-12，真机：macOS，资料库 3,828 首）

| 问题 | 结论 | 对设计的影响 |
| --- | --- | --- |
| 常驻 JXA 进程 | 可行。`getState` 往返中位数 25 ms，首条约 150–200 ms；pause / seek / resume 5–10 ms | 采用常驻进程 |
| stdin 结束 | `NSData.length` 经桥接是字符串，`=== 0` 永不成立，会在 EOF 时 100% CPU 空转 | 用 `Number(chunk.length) === 0` 判断 |
| `play(track, {once:true})` | **无效**，播完后「音乐」App 会接着播资料库的下一首 | 由 renderer 处理：载体结尾的 `pause` 事件会立即暂停「音乐」App；结尾附近发现引擎换到别的曲目时发 `pause`，不当作接管 |
| 开播状态 | 发出 `play` 后约 0.3 s 就报 `playing`，但位置在 0 停留约 1.5 s（缓冲）才开始前进 | 开播 hold 要等到「位置开始前进」才释放；`play` 之后 8 s 内轮询间隔改为 250 ms |
| 位置精度 | 毫秒级，稳定播放时每次采样均匀前进 | 漂移阈值可用 |
| seek 之后 | 约 1 s 内位置有 ±0.15 s 的抖动 | 每次 play / resume / seek 之后 1 s 内不做漂移校正 |
| 资料库读取 | `listPlaylists` 189 ms（14 个）；整个资料库 3,828 条 152 ms；搜索 268 ms；资料库里有 music video，需要按 `mediaKind === 'song'` 过滤 | 批量读属性可行 |
| 封面 | `artworks[0].rawData()` 返回的是描述符文本 `'tdta'($<十六进制>$)`，不是二进制 | JXA 只返回十六进制串，主进程解码；不需要临时文件 |
| 自动化授权 | 第一条真正的 Apple Event 会阻塞，直到用户在系统弹窗里点允许；`Application('Music').name()` 在本地回答，测不出权限 | `probe` 不发 Apple Event，权限只从真实请求的结果得知 |
| 载体格式 | 8 kHz / 8-bit WAV 在 Chromium 正常播放，时长准确，结尾先触发 `pause` 再触发 `ended` | 保持 8-bit |
| 载体静音 | 页面隐藏时，Chromium 把 `muted` 媒体的时钟降到约 0.25×；不静音则正常 | 载体元素不能设 `muted`，Folia 的静音改为把「音乐」App 音量设为 0。主窗口已设 `backgroundThrottling: false` |

验证过的 JXA 脚本：`.superpowers/sdd/2026-10-11-apple-music-app-bridge/music-app-jxa.js`（Task 4 原样内嵌）。

真机复测（2026-10-12）：稳定播放时载体恒定领先「音乐」App 约 70 ms（−0.067…−0.071 s），刚好低于原来的 80 ms 阈值而永远不被校正，所以漂移阈值收紧到 30 ms。同一次复测发现「音乐」App 的交叉淡入淡出 / AutoMix 会在本曲结束前数秒就开始下一首，载体此时还剩 2 s 以上，原逻辑把它当成用户接管；现在「音乐」App 最后一次报告本曲的位置距结尾不超过 12 s（`SYNC_MUSIC_TRANSITION_WINDOW_SEC`）时，视为本曲播完：暂停「音乐」App 的下一首，并把载体直接放到结尾，由 `ended` 切到 Folia 队列的下一首。
