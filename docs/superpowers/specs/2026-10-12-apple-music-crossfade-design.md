# Apple Music 与其他平台之间的 Automix 交叉淡化设计

- 日期：2026-10-12
- 状态：方案已获用户确认（含暂停 / 继续淡入淡出），待审阅书面稿
- 前置：`docs/superpowers/specs/2026-10-11-apple-music-app-bridge-design.md`（遥控「音乐」App + 静音载体）

## 背景

Apple Music 歌曲由「音乐」App 发声，Folia 的 deck 只播放等长静音载体。目前只要过渡中有 Apple 歌曲，Automix 一律硬切（`involvesExternalPlayback` 守卫）。用户希望 Apple ↔ 网易云 / QQ（以及任何非 Apple 来源）之间也能真正交叉淡化，并且 Apple 歌曲的暂停 / 继续也有淡入淡出。

用户确认的取舍：

- 混合过渡只做**普通等功率交叉淡化**，时长沿用现有交叉淡化设置；没有节拍对齐、EQ 交换、stems、回声、变速。Apple 一侧没有音频可分析。
- Apple → Apple 仍然硬切：「音乐」App 只有一个播放器，不能同时放两首。
- 非 Apple 之间的过渡行为**完全不变**。

## 目标与成功标准

1. Apple ↔ 非 Apple 的过渡听感是一次连续的交叉淡化：
   - 「音乐」App 的音量按 Folia 为该 deck 计划的淡化曲线变化；
   - 与对侧 deck 的淡化在时间上对齐，误差 ≤ 100 ms。
2. 非 Apple → Apple 时，过渡开始的那一刻「音乐」App 已经在出声，不会出现「先静音、晚 1.5 s 才响」。
3. Apple → 非 Apple 时，「音乐」App 一直淡到过渡结束才停止，不会在过渡开始前就被切断。
4. Apple 歌曲暂停时「音乐」App 音量淡出后再暂停，继续时淡入；暂停结束后「音乐」App 的音量恢复到用户音量（不会把「音乐」App 留在 0 音量）。
5. 非 Apple 之间的过渡、以及现有 Automix 单元测试全部保持通过。

## 非目标

- Apple → Apple 的交叉淡化。
- 混合过渡中的节拍对齐、EQ / band、stems、回声、变速、响度平衡（balance trim）。
- 用捕获的「音乐」App 音频做分析（另见第 3 项频谱方案，独立推进）。

## 现状与问题（来自代码梳理）

- **包络只存在于 AudioParam 上**：Automix 在 `automixSession.ts` 的 `handleActiveDeckPlaying` 里用局部变量算出 `startAt / hold / wall / crossover / together`，由 `crossfadeGraph.ts` 的 `scheduleCrossfade` 生成 64 点曲线写进各 deck 的 `fade` GainNode 后就丢弃，外部拿不到。其他写 `fade` 的地方：
  - 臂起时置 0（:816）
  - 拒绝时的 50 ms 斜坡（:954-955）
  - 空闲复位（:880）
  - settle 恢复 1（:720）
  - stems 窗口
- **队列在臂起时（过渡开始前约 1 s）就切到下一首**：`advanceTrack` → `playSong` 会改 `currentSong / audioSrc`，于是外部播放 session：
  - **(a)** 臂起时活动 deck 换成进入的 deck，session 把**正在淡出的 Apple 歌曲重新绑到进入的 deck** 上，同步控制器会去播放并 seek 那个 deck；
  - **(b)** key 一变就 `dispose(stopEngine: true)`，「音乐」App 在淡化开始前就被停掉。
- **进入方向**：
  - 「音乐」App 起播要约 1.5 s，而 session 的开播 hold 与 Automix 的 hold 是「或」关系，进入的 deck 会比计划晚 1.5 s 以上才启动，过渡被截断或拒绝；
  - 同步控制器的 `seekCarrier(estimate)` 还会覆盖 Automix 对进入 deck 的 `inStart` seek。
- **静音载体误导 Automix**：分析器读到 −90 dB，导致：
  - 出 Apple 时选早 crossover；
  - 入 Apple 时把对侧网易云衰减满 6 dB；
  - 有歌词时可能选 bassSwap（中段 hold、band 曲线），这些都无法映射到「音乐」App。
- **进入的 Apple 歌曲没有预热源**：预取跳过外部歌曲的音频，Automix warm 步骤拿不到 URL。
- **暂停淡出**：`playbackFade.ts` 的淡出作用在静音载体上，听不到；随后载体暂停 → `engine.pause()` 硬停；继续时「音乐」App 直接满音量。

## 方案

### 1. 包络端口（Automix → 外部）

在 Automix session 与 deck 之间新增一个只读端口：

```ts
// 一段增益包络：在 AudioContext 时间 startAt 开始，seconds 内按 points 等距插值；seconds 为 0 表示瞬时设值。
export interface DeckGainEnvelope { startAt: number; seconds: number; points: readonly number[] }
onDeckEnvelope(deck: AutomixDeckId, envelope: DeckGainEnvelope): void
```

- `scheduleCrossfade` 返回它生成的两条曲线（不改变写 AudioParam 的方式）。
- session 在每个写 `fade` 的位置同时发出对应包络：
  - 臂起置 0
  - 交叉淡化曲线
  - 拒绝斜坡
  - 空闲复位
  - settle 恢复
- 只是新增通知，不改变任何 AudioParam 调度，因此非 Apple 过渡的听感不变。

`playbackFade.ts` 以同样形式发出暂停 / 继续包络：`onFadeEnvelope(envelope)`，覆盖淡出到 0、恢复 1、继续前置 0、淡入到 1。

### 2. 外部音量镜像（ExternalVolumeMirror）

新的纯逻辑服务 `src/services/externalPlayback/externalVolumeMirror.ts`。

- **输出**：`用户音量 × deck 包络当前值 × 暂停包络当前值`。
  - 用 AudioContext 时间加 60 ms 前瞻求值，抵消 IPC 延迟。
  - 包络在变化时以 20 Hz 调用 `engine.setVolume`，静止时只在值变化时调用。
  - 换算到「音乐」App 的 0–100 整数后，与上次相同就不发。
- **载体暂停期间不抬高音量**：暂停淡出后包络恢复到 1 的那一步不会把「音乐」App 拉响。
- **暂停后恢复用户音量**：等「音乐」App 状态读数确认已暂停 / 停止（或 500 ms 超时）后，把音量恢复到用户音量。这时它已经不出声，不会有爆音，也不会把「音乐」App 留在 0 音量。
- **接管现有路径**：现在 session 直接把用户音量发给「音乐」App 的 `mirrorVolume` 改为经由镜像，非过渡时 deck 包络恒为 1。

### 3. 共享载体（进入方向的预热源）

为外部歌曲建一个载体登记表 `src/services/externalPlayback/carrierRegistry.ts`：

- `acquireCarrier(song) → url`：同一首歌返回同一个 blob URL。
- `releaseCarrier(song)`：引用计数归零时回收。
- Automix 预热下一首 Apple 歌曲时取得它的载体作为 warm source；`playSong` 走 `loadOnlineSongAudioSource` 时拿到的是**同一个 URL**，因此 deck 交接无缝，`resolveDeckSrc` 照旧工作。
- 现有「切歌回收 `blobUrl`」改为 release，不再直接 revoke 外部载体。

### 4. Automix 对混合过渡的处理

- **守卫**：`involvesExternalPlayback` 在 `checkTransitionPoint` 中改为「两侧都是外部 → 硬切」。恰好一侧是外部时允许过渡。
- **强制普通交叉淡化**：混合过渡强制走 `planCrossfade`，样式 plainBlend，并关闭响度平衡、band、回声、变速、stems、build-up。外部一侧的 profile 视为缺失：`leadIn = 0`，结尾 = 载体时长。
- **预滚**：进入的一侧是外部时，臂起时刻提前 `EXTERNAL_PREROLL_SEC = 2.5 s`，同时调整 `checkTransitionPoint` 的窗口和 `automixSession` 的 arm 判断，让「音乐」App 有时间先起播。
- 非混合的过渡路径不做任何改变。

### 5. 外部播放 session / 同步控制器的改动

- **按 src 绑定，而不是按「活动 deck」绑定**：session 把外部歌曲绑定到「src 为其载体的那个 deck」。
  - hook 需要从 Automix 取得两个 deck 的元素与各自承载的歌曲（`deckSongRef` / tail 信息）。
  - 修掉问题 (a)。
- **淡出方向（Apple → 非 Apple）**：
  - 臂起后当前歌曲变为非 Apple，但只要 Apple 歌曲仍在 tail deck 上淡出，就保留它的 sync（绑在 tail deck）和监控，不 `stop`，音量由镜像按 tail deck 的包络驱动。
  - settle 暂停 tail deck 后，载体暂停 → `engine.pause()`；session 随后 `dispose(stopEngine: true)` 并按第 2 节恢复用户音量。
  - 修掉问题 (b)。
- **进入方向（非 Apple → Apple）**：同步控制器新增启动意图 `'preroll'`，由 session 在臂起时调用：
  1. 发 `engine.play(song, inStart)`；此时进入 deck 的包络为 0，「音乐」App 音量由镜像压在 0。
  2. 等「音乐」App 真正出声（复用现有出声判断）。
  3. 期间不播放、不 seek 载体：载体由 Automix 自己的 hold 管。
  4. 过渡期间以**载体为位置基准**：Automix 释放并播放载体后，偏差超过阈值时 seek 的是「音乐」App，而不是载体。过渡结束（settle）后恢复为以「音乐」App 为基准。
- **hold 与歌词门控**：由 Automix 推进的进入歌曲不再叠加 session 的开播 hold，也不等歌词加载（Ruling 31 只适用于普通开播），起播时机完全由 Automix 和预滚保证。
- **暂停 / 继续**：镜像按暂停包络淡出「音乐」App 音量，载体暂停后照常 `engine.pause()`。继续时先 `resume`，镜像按淡入包络把音量拉回来。普通开播（start hold）不做淡入：出声时直接是用户音量。

## 错误处理

- **预滚失败**：8 s 内未出声，或 `play` 被拒。本次过渡改为硬切：Automix 按拒绝路径处理，进入歌曲按现有失败逻辑处理（跳歌或暂停）。不影响淡出一侧。
- **淡出中「音乐」App 被用户切走或退出**：沿用现有接管规则，tail 一侧的 sync 进入接管后不再控制「音乐」App；Folia 的淡化照常完成。
- **IPC 慢或阻塞**：镜像只发最新值、丢弃过期值，不排队。
- **任何异常都不能让「音乐」App 停在 0 音量**：dispose、stop、退出前恢复用户音量。

## 测试

- **包络端口**：在 `automixSession.test.ts` 的 harness 里断言各写 `fade` 的位置发出了与 AudioParam 调度一致的包络（复用 `fakeAudioGraph.ts`）。
- **暂停包络**：在 `playbackFade.test.ts` / `fakeFadeGraph.ts` 下断言淡出、恢复、淡入包络。
- **镜像**：纯逻辑测试（假时钟、假引擎），覆盖：
  - 20 Hz 采样、前瞻 60 ms
  - 用户音量相乘、0–100 取整去重
  - 载体暂停不抬高音量
  - 确认暂停后恢复用户音量
  - 超时恢复
- **载体登记表**：同歌同 URL、引用计数、归零回收。
- **Automix 混合过渡**：
  - 一侧外部 → 允许并强制 crossfade
  - 两侧外部 → 硬切
  - 进入外部 → 臂起提前 2.5 s
  - 平衡、band、回声、变速、stems 均未调度
- **同步控制器**：
  - `'preroll'` 起播不动载体、出声后等待
  - 过渡期间以载体为基准 seek「音乐」App
  - settle 后恢复以「音乐」App 为基准
  - 预滚超时报失败
- **session**：
  - 按 src 绑定；tail 期间不 stop、监控保持
  - settle 后 stop 并恢复音量
  - 进入方向臂起即 preroll、不叠加开播 hold、不等歌词
- **回归**：
  - 现有 `test/unit/automix/**`、`test/unit/externalPlayback/**`、`test/unit/playback/**` 全部通过
  - `npm run typecheck`
- **真机验收**：
  - Apple → 网易云、网易云 → Apple 各听若干次，确认连续淡化、无断音、无晚启
  - Apple 歌曲暂停 / 继续的淡入淡出
  - 过渡后「音乐」App 音量恢复正常
  - 非 Apple 之间的过渡听感不变
