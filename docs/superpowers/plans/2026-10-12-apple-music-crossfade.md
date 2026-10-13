# Apple Music ↔ 其他平台 Automix 交叉淡化与暂停淡入淡出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apple Music 歌曲与任何非 Apple 来源之间的 Automix 过渡变成一次真正的等功率交叉淡化，Apple 歌曲的暂停 / 继续也有淡出淡入。

**Architecture:** Automix 和暂停淡化每次写 `fade` 增益时，同时发出一条只读的增益包络。`ExternalVolumeMirror` 在 AudioContext 时间 +60 ms 处求值「用户音量 × 绑定 deck 包络 × 暂停包络」，用这个值驱动「音乐」App 的音量。外部播放 session 改为按载体 src 绑定 deck：
- 淡出方向：tail 一直保留到 settle。
- 进入方向：臂起时用 `'preroll'` 意图提前让「音乐」App 起播，过渡期间以载体为位置基准。

载体放进引用计数登记表，Automix 预热和 `playSong` 拿到的是同一个 blob URL。

**Tech Stack:** React 19 + TypeScript、Web Audio、Vitest（`environment: 'node'`，hook 测试靠 mock `react`）。Electron / JXA 桥接不改。

**Spec:** `docs/superpowers/specs/2026-10-12-apple-music-crossfade-design.md`

## Global Constraints

- 包络求值的前瞻量：`MIRROR_LOOKAHEAD_SEC = 0.06`（AudioContext 时间）。
- 镜像节奏：有包络正在变化时按 20 Hz 发送（`MIRROR_TICK_MS = 50`）。包络静止时，只在结果变化时发送。
- 「音乐」App 音量按 `Math.round(v × 100)` 换成 0–100 的整数，与上次发出的值相同就不发；同一时刻最多一条 `setVolume` 在途，只保留最新值。用户音量的变化保留 100 ms 尾部节流（`EXTERNAL_VOLUME_THROTTLE_MS = 100`）。
- `EXTERNAL_PREROLL_SEC = 2.5`：只有进入一侧是外部歌曲时，臂起才提前这么多。
- 恢复用户音量：Folia 不再驱动「音乐」App 后，等它报告「不在播我们这首」，或等 `MIRROR_RESTORE_TIMEOUT_MS = 500`，再发用户音量。前提是上次发出的值和用户音量不同。
- 混合过渡（恰好一侧是外部歌曲）一律强制普通交叉淡化，具体是：
  - 用 `planCrossfade` 规划，样式 plainBlend，时长取交叉淡化滑块；
  - 外部一侧的 profile / lyrics 视为缺失；
  - crossover 用 `crossoverFor(null)`，没有节拍吸附；
  - 关闭响度平衡、band、echo、变速、stems、build-up。

  两侧都是外部歌曲时照旧硬切。
- 非混合过渡的行为必须逐字节不变。`test/unit/automix/**`、`test/unit/externalPlayback/**`、`test/unit/playback/**` 的现有断言一律不改，只允许给 harness 加记录器、给 fake 加字段。
- 分层规则：
  - `src/hooks`、`src/components`、`src/stores` 不 import 任何 `*Transport`。
  - `src/utils` 是叶子层，不 import `omni` 或注册表。
  - 判断外部歌曲用 `omni.isExternalPlaybackSong` 或 `externalPlaybackGuards` 里的函数。
- 新文件在 import 之后加一行路径注释（例如 `// src/services/gainEnvelope.ts`），复杂函数加一句注释，不删改已有注释和 `@note`。
- 载体 `<audio>` 永远不设 `muted`。
- 同步常量不变：`SYNC_DRIFT_IGNORE_SEC = 0.03`、`SYNC_DRIFT_SEEK_SEC = 1`、`SYNC_SETTLE_MS = 1000`、`SYNC_START_TIMEOUT_MS = 8000`、`SYNC_MUSIC_TRANSITION_WINDOW_SEC = 12`。
- 单测：`npx vitest run -c vitest.config.ts <path>`。类型检查：`npm run typecheck`。不跑 build。
- 工作区里有与本计划无关、尚未提交的频谱采集改动（`git status` 可见）。每次提交只 `git add` 本任务列出的文件，禁止 `git add -A` / `git add .`。
- 提交信息：`feat(apple-music): …` / `test(apple-music): …` / `docs(apple-music): …`，末尾 `-m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`。每次提交后立即 `git push origin claude/apple-music-support-90e440`。

## Review Focus

- **settle 先暂停 tail 载体、马上把 fade 拉回 1，而 `pause` 事件是异步的**：Apple → 网易云过渡结束时，镜像必须读载体同步可得的 `paused` 属性，不能在 pause IPC 送到前把「音乐」App 拉回用户音量（会听到 tail 末尾满音量一下）。由 Task 3 `never raises Music while the carrier it drives is paused` 和 Task 7 `keeps the tail controller through the advance and stops Music only when the tail settles` 钉住。
- **臂起后、载体被 Automix hold 住期间听者按暂停**（「音乐」App 正以 0 音量预滚）：必须 `engine.pause()` 并归还音量。8 s 后不能报「播放失败」，也不能让「音乐」App 一直静音地播下去。由 Task 6 `pauses Music when a preroll is aborted`、`ends the preroll wait on a carrier pause without a failure` 和 Task 7 `aborts the preroll when the listener pauses during the lead` 钉住。
- **预滚 8 s 内一直没出声**（「音乐」App 冷启动、流媒体卡住）：本次过渡按拒绝路径硬切，进入歌曲走现有失败逻辑。不能让网易云淡到无声、再等跳歌倒计时。由 Task 5 `refuses an armed blend once it is cut` / `cuts a running blend at once` 和 Task 7 `cuts the blend before routing a failed preroll` 钉住。
- **淡出途中听者在「音乐」App 里换了歌（接管）**：镜像不能继续跟 tail 包络把听者自己的歌淡到 0，要立刻把用户音量还回去。由 Task 3 `stops following envelopes once control is yielded and restores at once for another track` 和 Task 7 `yields Music's volume on a takeover` 钉住。
- **过渡中途取消回尾**（拖动进度条，或暂停淡出走 `cancelBlendKeepingTail`），Apple 歌曲重新成为当前歌曲：key 不变，要保留同一个 sync，不重新 `play`、不 `stop`；载体 URL 不能已被 revoke。由 Task 7 `keeps the same controller when a mid-blend cancel returns to the outgoing Apple song` 和 Task 4 `keeps a released carrier while a deck still renders it and sweeps it later` 钉住。

---

## File Structure

| 文件 | 职责 |
| --- | --- |
| `src/services/gainEnvelope.ts`（新） | `DeckGainEnvelope` 类型；包络求值 `envelopeValueAt` / `envelopeEndsAt` |
| `src/services/automix/crossfadeGraph.ts`（改） | `rampGainEnvelope`；`scheduleCrossfadeEnvelopes`（`scheduleCrossfade` 仍返回 boolean） |
| `src/services/automix/automixSession.ts`（改） | `onDeckEnvelope` 端口；混合过渡的规划与执行；预滚臂起；`cutTransition` |
| `src/services/automix/transitionStrategy.ts`（改） | `planForExternalPair` |
| `src/services/automix/useAutomixDecks.ts`（改） | 守卫改「两侧外部」；预滚窗口；载体预热槽；`transitionSongs` / `getDeckElement` / `cutTransition`；包络端口 |
| `src/services/playbackFade.ts`（改） | 暂停 / 继续包络与监听注册 |
| `src/services/externalPlayback/externalVolumeMirror.ts`（新） | 「音乐」App 音量镜像 |
| `src/services/externalPlayback/carrierRegistry.ts`（新） | 载体登记表（引用计数、延迟回收）与预热槽 |
| `src/utils/mediaElementSources.ts`（新） | `isUrlOnAudioElement(url)`（从 `playbackBlobUrls` 抽出的 DOM 查询） |
| `src/services/playbackBlobUrls.ts`（改） | 遇到载体 URL 改为 release；新增 `releasePlaybackBlobUrl` |
| `src/services/onlinePlayback.ts`（改） | 外部歌曲经登记表取载体 |
| `src/hooks/usePlaybackQueueController.ts`、`src/components/app/playback/restorePlaybackSource.ts`（改） | 直接 revoke 改为 `releasePlaybackBlobUrl` |
| `src/services/externalPlayback/externalPlaybackGuards.ts`（改） | `externalSideOf` |
| `src/services/externalPlayback/externalPlaybackSync.ts`（改） | `'preroll'` 意图、载体基准、`endTransition`、三项加固 |
| `src/services/externalPlayback/externalPlaybackSession.ts`（改） | 按 src 绑定、tail 保留、预滚、持有镜像 |
| `src/hooks/useExternalPlaybackSync.ts`（改） | 把 deck、过渡、包络、音频时钟接进 session |
| `src/App.tsx`（改） | 接线 |

---

### Task 0：提交计划

- [ ] **Step 1：提交**

```bash
git add docs/superpowers/plans/2026-10-12-apple-music-crossfade.md
git commit -m "docs(apple-music): Apple 与其他平台交叉淡化实施计划" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin claude/apple-music-support-90e440
```

---

### Task 1：Automix 增益包络端口（无行为变化）

**Files：**
- Create：`src/services/gainEnvelope.ts`（本任务只放类型）
- Modify：`src/services/automix/crossfadeGraph.ts`
  - `rampGain`（约 :167）之后加 `rampGainEnvelope`
  - `scheduleCrossfade`（:622-651）拆成 `scheduleCrossfadeEnvelopes` 加原函数
- Modify：`src/services/automix/automixSession.ts`
  - `AutomixSessionPorts`（:119-154）
  - 写 `fade` 的五处：settle :720、臂起 :816、非臂起复位 :880、拒绝 :954-955、交叉淡化 :1188
- Test：
  - `test/unit/automix/crossfadeGraph.test.ts`（追加）
  - `test/unit/automix/automixSession.test.ts`（`createHarness` 加 `envelopes` 记录器并返回它；追加用例）

**Interfaces：**
- Consumes：无。
- Produces：

```ts
// src/services/gainEnvelope.ts
/** From startAt on the AudioContext clock, `points` evenly spaced over `seconds`, linear in between; seconds 0 sets points.at(-1) at startAt. Before startAt the gain holds whatever it was. */
export interface DeckGainEnvelope { startAt: number; seconds: number; points: readonly number[] }

// src/services/automix/crossfadeGraph.ts
export const rampGainEnvelope: (context: AudioContext, gain: GainNode, value: number, seconds?: number) => DeckGainEnvelope;
export interface ScheduledCrossfade { ok: boolean; outgoing: DeckGainEnvelope[]; incoming: DeckGainEnvelope[] }
export const scheduleCrossfadeEnvelopes: (context: AudioContext, outgoing: GainNode, incoming: GainNode,
    seconds: number, crossover?: number, hold?: number, together?: number) => ScheduledCrossfade;
// scheduleCrossfade keeps its signature and boolean result: scheduleCrossfadeEnvelopes(...).ok

// src/services/automix/automixSession.ts
export interface AutomixSessionPorts { /* existing */ onDeckEnvelope?: (deck: AutomixDeckId, envelope: DeckGainEnvelope) => void }
```

规则：
- **`rampGainEnvelope`**：调用 `rampGain` 之前先读 `gain.gain.value` 作为 `from`，然后调用 `rampGain`，原样不动。返回值：
  - `startAt` = `context.currentTime`
  - `seconds` = `max(0, seconds)`
  - `points`：`seconds > 0` 时为 `[from, value]`，否则为 `[value]`
- **`scheduleCrossfadeEnvelopes`**：对 AudioParam 的写入和今天的 `scheduleCrossfade` 完全一样。
  - 成功时，每一侧的数组依次是：
    1. 仅当 `hold > 0` 时，一条在 `now` 的瞬时包络（outgoing 为 `[1]`、incoming 为 `[0]`），对应现有的两条 `setValueAtTime`；
    2. 曲线包络 `{ startAt, seconds, points: Array.from(curve) }`。
  - 被拒绝时：`ok: false`，两侧各返回 catch 分支里 50 ms `rampGainEnvelope` 的结果。
- **automixSession**：
  - 新增内部 `rampFade(context, deck, value, seconds)`，取代上述四处 `rampGain(context, chain.fade, …)`。
  - :1188 改用 `scheduleCrossfadeEnvelopes`，按顺序先发 tail deck、再发 active deck 的每一条包络。
  - 端口可选，并且在写入之后调用。
- **`scheduleStemWindow` 不发包络**：混合过渡永远走不到 stems（Task 5），非混合过渡没人消费这些包络。

- [ ] **Step 1：写失败测试**

```ts
// crossfadeGraph.test.ts
it('returns the envelopes it wrote, the hold included', () => {
    const context = createFakeContext(10);
    const outgoing = createFakeGainNode(); const incoming = createFakeGainNode();
    const scheduled = scheduleCrossfadeEnvelopes(context, asGain(outgoing), asGain(incoming), 0.04, 0.5, 1.2);
    expect(scheduled.ok).toBe(true);
    expect(scheduled.outgoing[0]).toEqual({ startAt: 10, seconds: 0, points: [1] });
    expect(scheduled.incoming[0]).toEqual({ startAt: 10, seconds: 0, points: [0] });
    expect(scheduled.outgoing[1]).toEqual({ startAt: 11.2, seconds: 0.04, points: Array.from(lastCurve(outgoing)!.curve) });
});
it('returns the cut it fell back to when the engine rejects the curves', () => {
    /* setValueCurveAtTime 抛错 → ok false；outgoing.at(-1) 为 { seconds: 0.05, points.at(-1): 0 }，incoming.at(-1).points.at(-1) 为 1 */ });
it('describes a ramp from the current value', () => {
    /* 假 gain 当前值 1，rampGainEnvelope(ctx@3, g, 0, 0.2) → { startAt: 3, seconds: 0.2, points: [1, 0] }；seconds 0 → points [0] */ });

// automixSession.test.ts（harness：onDeckEnvelope: (deck, envelope) => envelopes.push({ deck, envelope })）
const last = (h, deck) => h.envelopes.filter(e => e.deck === deck).at(-1)?.envelope;
it('announces the incoming deck going silent at arm', () => {
    const h = createHarness(); h.arm();
    expect(last(h, 'B')).toEqual({ startAt: 0, seconds: 0, points: [0] });
});
it('announces both crossfade curves exactly as scheduled', () => {
    const h = createHarness(); h.arm(); h.session.handleActiveDeckPlaying('local:next-song');
    const curve = lastCurve(h.chains.A.fadeNode)!;
    expect(last(h, 'A')).toEqual({ startAt: curve.time, seconds: curve.duration, points: Array.from(curve.curve) });
    expect(last(h, 'B')!.points).toEqual(Array.from(lastCurve(h.chains.B.fadeNode)!.curve));
});
it('announces the refusal ramps', () => { /* handleActiveDeckPlaying('local:some-other-song') → A { seconds 0.05, points.at(-1) 0 }，B { seconds 0.05, points.at(-1) 1 } */ });
it('announces unity on both decks when the transition settles', () => { /* advanceTimersByTime(5_200) → A、B 的最后一条都是 seconds 0.03、points.at(-1) 1 */ });
it('announces unity for a deck that starts outside a transition', () => { /* 未臂起直接 handleActiveDeckPlaying(null) → A { seconds 0.02, points.at(-1) 1 } */ });
```

- [ ] **Step 2：确认测试失败**

Run：`npx vitest run -c vitest.config.ts test/unit/automix/crossfadeGraph.test.ts test/unit/automix/automixSession.test.ts`
Expected：FAIL，`scheduleCrossfadeEnvelopes` / `rampGainEnvelope` 未导出，`envelopes` 为空。

- [ ] **Step 3：按上面的规则实现**

- [ ] **Step 4：确认通过，现有 Automix 用例一个不改**

Run：`npx vitest run -c vitest.config.ts test/unit/automix && npm run typecheck`
Expected：PASS。

- [ ] **Step 5：提交**

```bash
git add src/services/gainEnvelope.ts src/services/automix/crossfadeGraph.ts src/services/automix/automixSession.ts test/unit/automix/crossfadeGraph.test.ts test/unit/automix/automixSession.test.ts
git commit -m "feat(apple-music): Automix 发出 deck 增益包络" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin claude/apple-music-support-90e440
```

---

### Task 2：暂停 / 继续淡化发出包络

**Files：**
- Modify：`src/services/playbackFade.ts`
  - `PlaybackFadeDeps`（:40-48）
  - 六处 `rampGain`：`snapToUnity` :134、`restoreAfterDrain` :143、`fadeOutThen` :182、`cancelPendingPause` :196、`prepareFadeIn` :207、`runFadeIn` :214
  - 单例 :275-278
- Test：`test/unit/services/playbackFade.test.ts`（追加；`makeController` 增加 `onEnvelope` 记录器）

**Interfaces：**
- Consumes：Task 1 的 `DeckGainEnvelope`、`rampGainEnvelope`。
- Produces：

```ts
export type PlaybackFadeDeps = { /* existing */ onEnvelope?: (envelope: DeckGainEnvelope) => void };
/** The app-wide controller forwards its envelopes here; null unregisters. */
export const registerPlaybackFadeEnvelopeListener: (listener: ((envelope: DeckGainEnvelope) => void) | null) => void;
```

规则：
- 六处 `rampGain(graph.context, graph.gain, v, s)` 全部改为 `rampGainEnvelope` 并把结果交给 `onEnvelope`。时机、generation 和 drain 逻辑一律不动。
- 单例的 `onEnvelope` 转发给最近一次注册的监听。

- [ ] **Step 1：写失败测试**

```ts
it('announces the fade-out it schedules and the return to unity after the drain', () => {
    const fade = makeController(); fade.fadeOutThen(vi.fn());
    expect(envelopes[0]).toEqual({ startAt: 0, seconds: D, points: [1, 0] });
    advance(D + 0.02 + DRAIN_AND_RESTORE);
    expect(envelopes.at(-1)).toMatchObject({ seconds: 0.03, points: [0, 1] });
});
it('announces the fade-in from silence', () => {
    /* prepareFadeIn() → { seconds: 0, points: [0] }；runFadeIn(token) → { seconds: D, points: [0, 1] } */ });
it('turns a pending pause around from the current gain', () => {
    /* fadeOutThen；advance(D / 2)；cancelPendingPause() → 最后一条 seconds D，points[0] ≈ 0.5，points[1] 为 1 */ });
it('announces nothing when the fade cannot run', () => { /* enabled = false 时 fadeOutThen / prepareFadeIn → envelopes 为空 */ });
```

- [ ] **Step 2：确认测试失败**

Run：`npx vitest run -c vitest.config.ts test/unit/services/playbackFade.test.ts`
Expected：FAIL，`envelopes` 为空。

- [ ] **Step 3：实现**

- [ ] **Step 4：确认通过**

Run：`npx vitest run -c vitest.config.ts test/unit/services/playbackFade.test.ts test/unit/automix/pauseFadeAbort.test.ts test/unit/hooks/usePlaybackTransportFade.test.ts && npm run typecheck`
Expected：PASS。

- [ ] **Step 5：提交**

```bash
git add src/services/playbackFade.ts test/unit/services/playbackFade.test.ts
git commit -m "feat(apple-music): 暂停与继续淡化发出增益包络" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin claude/apple-music-support-90e440
```

---

### Task 3：`ExternalVolumeMirror`（纯逻辑）

**Files：**
- Modify：`src/services/gainEnvelope.ts`（加求值函数）
- Create：`src/services/externalPlayback/externalVolumeMirror.ts`
- Test：
  - `test/unit/services/gainEnvelope.test.ts`（新）
  - `test/unit/externalPlayback/externalVolumeMirror.test.ts`（新）

**Interfaces：**
- Consumes：
  - Task 1 的 `DeckGainEnvelope`
  - `AutomixDeckId`（`automixSession.ts`，type-only import）
  - `OmniExternalPlaybackEngine` / `OmniExternalPlaybackState`
- Produces：

```ts
// gainEnvelope.ts
/** The gain at `time`: `held` before the envelope starts (or when there is none), its last point after it ends. */
export const envelopeValueAt: (envelope: DeckGainEnvelope | null, held: number, time: number) => number;
/** startAt + seconds; -Infinity for none. */
export const envelopeEndsAt: (envelope: DeckGainEnvelope | null) => number;

// externalVolumeMirror.ts
export const MIRROR_LOOKAHEAD_SEC = 0.06;
export const MIRROR_TICK_MS = 50;
export const MIRROR_RESTORE_TIMEOUT_MS = 500;
export const EXTERNAL_VOLUME_THROTTLE_MS = 100;
export interface ExternalVolumeTarget {
    engine: OmniExternalPlaybackEngine;
    mediaId: string | null;
    /** Whose envelope applies; null = unknown deck, factor 1. */
    deck: AutomixDeckId | null;
    carrier: { readonly paused: boolean };
}
export interface ExternalVolumeMirrorOptions {
    audioNow: () => number | null;          // AudioContext.currentTime, null while there is no graph
    now?: () => number;                     // wall ms, compared with sampledAtMs
    setTimer?: (callback: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}
export class ExternalVolumeMirror {
    constructor(options: ExternalVolumeMirrorOptions);
    setUserVolume(volume: number): void;
    handleDeckEnvelope(deck: AutomixDeckId, envelope: DeckGainEnvelope): void;
    handleFadeEnvelope(envelope: DeckGainEnvelope): void;
    bind(target: ExternalVolumeTarget): void;   // follow this engine; idle until drive()
    drive(): void;                              // Folia is playing it: send the product now and on every change
    yieldControl(): void;                       // stop driving; give the user volume back once Music is not playing ours, or after 500 ms
    unbind(): void;                             // yieldControl() and forget the target; a pending restore still completes
    dispose(): void;                            // unbind() and stop ticking; the instance stays usable (StrictMode re-runs effects)
}
```

算法（测试管不到的部分）：
- **包络轨道**：deck A、B 和暂停淡化各有一条轨道 `{ held, envelope }`，初值 `held = 1`、`envelope = null`。无论绑定的是哪个 deck，两个 deck 的轨道都要一直记录。
- **新包络到达**（cancel-and-hold 语义）：
  - `held = envelopeValueAt(old, held, audioNow())`，然后 `envelope = 新的`；
  - `audioNow()` 为 null 时，`held` 取旧包络的最后一点。
- **输出**：在 `t = audioNow() + MIRROR_LOOKAHEAD_SEC` 处计算 `user × deck × fade`。`audioNow()` 为 null 时 `t = +∞`；`deck === null` 时 deck 因子为 1。
- **三种状态**：
  - **未绑定**：只完成可能还在等待的恢复，其他什么都不发。
  - **绑定但空闲**（`bind` 之后、`drive` 之前；或 `yieldControl` 之后）：只在用户音量变化时发送，发的是纯用户音量。这是现状里「当前歌曲是外部播放时滑块照样同步」的行为。
  - **驱动中**：发送上面的乘积。
- **驱动中，不拉高已暂停的载体**：只要 `target.carrier.paused` 为真，并且自 `bind` 以来见过它在播，发出的百分比就取 `min(新值, 上次发出值)`。「见过它在播」在 `drive()` 时或任意一次求值时看到 `!paused` 即置位，`bind` 时清零。所以开播 hold 期间（载体从没播过）不受限制。
- **节拍**：只要绑定 deck 或暂停淡化的包络在 `t` 处还没结束（`t < envelopeEndsAt`，包括还没开始的），就用 `setTimer(MIRROR_TICK_MS)` 链式重算。结束后停止。
- **其他触发**：
  - 包络到达、`drive()`：立即重算；
  - `setUserVolume`：100 ms 尾部节流；
  - 用户音量从没设置过：什么都不发。
- **发送**：
  - 百分比与上次发出值相同就跳过；
  - 有命令在途时只记下最新值，等在途命令结束后若仍不同再发；
  - 命令被拒绝时 `lastSentPct = null`，错误吞掉。
- **恢复**：
  - `yieldControl()`：上次发出值为 null，或已经等于用户音量的百分比时，什么都不做。否则订阅 engine 状态，第一条满足 `sampledAtMs >= 让出时刻` 且（`state !== 'playing'` 或 `mediaId !== target.mediaId`）的读数出现，或 500 ms 到了，就发用户音量，然后退订。
  - 对同一个 engine 再次 `bind()` 会取消还在等待的恢复，由新歌接手音量。

- [ ] **Step 1：写失败测试**

测试工具：
- engine fake 照抄 `externalPlaybackSync.test.ts` 的 `createEngine`。
- `audio = { t: 0 }`，`clock = 1_000_000`。
- `carrier = { paused: false }`，`target = () => ({ engine, mediaId: OUR_ID, deck: 'A', carrier })`。
- `advance(sec)`：每步 10 ms，同时推进 `audio.t` 和 `clock`，再 `await vi.advanceTimersByTimeAsync(10)`（让在途命令的 promise 能结算）。
- `sent = () => engine.setVolume.mock.calls.map(([v]) => v)`。

```ts
// gainEnvelope.test.ts
it('holds the previous value until the envelope starts', () => expect(envelopeValueAt({ startAt: 2, seconds: 1, points: [0, 1] }, 0.7, 1)).toBe(0.7));
it('interpolates evenly spaced points linearly', () => expect(envelopeValueAt({ startAt: 0, seconds: 2, points: [1, 0, 1] }, 1, 0.5)).toBeCloseTo(0.5));
it('sets instantly and holds the last point afterwards', () => { /* seconds 0 → points.at(-1)；t 超过结束 → 最后一点 */ });

// externalVolumeMirror.test.ts
it('drives Music 60 ms ahead of the audio clock', async () => {
    mirror.setUserVolume(1); mirror.bind(target()); mirror.drive();
    mirror.handleDeckEnvelope('A', { startAt: 0, seconds: 1, points: [1, 0] });
    await advance(0);
    expect(sent().at(-1)).toBeCloseTo(0.94, 5);
});
it('follows a moving envelope at 20 Hz and goes quiet once it settles', async () => {
    /* 接上一条：advance(1.2) → 发送次数在 19..23 之间，最后一次为 0；再 advance(1) → 次数不变 */ });
it('multiplies the user volume, the deck and the pause fade', async () => {
    /* 用户 0.5；deck A [0.5]；fade [0.5] → 最后一次为 0.13 */ });
it('sends each 0–100 step once', async () => { /* [0.501] 之后 [0.499] → 只发一次 0.5 */ });
it('reads only the deck it is bound to', async () => { /* deck B 的包络 → 不发送 */ });
it('never raises Music while the carrier it drives is paused', async () => {
    mirror.setUserVolume(1); mirror.bind(target()); mirror.drive();
    mirror.handleDeckEnvelope('A', { startAt: 0, seconds: 0, points: [0] });
    const before = sent().length;
    carrier.paused = true;                                            // settle paused the tail synchronously...
    mirror.handleDeckEnvelope('A', { startAt: 0, seconds: 0.03, points: [0, 1] });   // ...then ramped its fade back to 1
    await advance(0.2);
    expect(sent().slice(before).every(v => v === 0)).toBe(true);
});
it('gives Music the user volume once it confirms the pause', async () => {
    /* 接上一条：yieldControl()；clock += 100；emit paused（OUR_ID，sampledAtMs: clock）→ 最后一次为 1；engine.listenerCount() 为 0 */ });
it('ignores a confirmation sampled before control was yielded and restores after 500 ms', async () => {
    /* 早于让出时刻的 paused 读数 → 不发；advance(0.5) → 发 1 */ });
it('stops following envelopes once control is yielded and restores at once for another track', async () => {
    /* 淡出中 yieldControl()；emit playing OTHER_ID（让出之后采样）→ 发 1；之后 deck A 的包络 → 不再发送 */ });
it('sends only the newest value while a command is in flight', async () => {
    /* setVolume 返回 deferred；drive 后依次来 [0.8]、[0.6]、[0.4] → resolve → 恰好再发一次 0.4 */ });
it('keeps an idle binding to plain user-volume changes, throttled to 100 ms', async () => {
    /* bind 但不 drive；deck A [0] → 不发；setUserVolume 0.1、0.2，50 ms 后 0.3 → 100 ms 后只有一次 0.3 */ });
it('sends nothing before the user volume is known', async () => { /* bind + drive + 包络 → 不发送 */ });
it('lets a new binding on the same engine cancel a pending restore', async () => { /* yieldControl 后 bind(另一个 target) → advance(0.6) → 不发用户音量 */ });
```

- [ ] **Step 2：确认测试失败**

Run：`npx vitest run -c vitest.config.ts test/unit/services/gainEnvelope.test.ts test/unit/externalPlayback/externalVolumeMirror.test.ts`
Expected：FAIL，模块 / 导出不存在。

- [ ] **Step 3：按上面的算法实现**

- [ ] **Step 4：确认通过**

Run：同 Step 2，再加 `&& npm run typecheck`。Expected：PASS。

- [ ] **Step 5：提交**

```bash
git add src/services/gainEnvelope.ts src/services/externalPlayback/externalVolumeMirror.ts test/unit/services/gainEnvelope.test.ts test/unit/externalPlayback/externalVolumeMirror.test.ts
git commit -m "feat(apple-music): 「音乐」App 音量镜像" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin claude/apple-music-support-90e440
```

---

### Task 4：载体登记表与 blob 回收改道

**Files：**
- Create：`src/services/externalPlayback/carrierRegistry.ts`
- Create：`src/utils/mediaElementSources.ts`（`isUrlOnAudioElement`，即 `playbackBlobUrls.ts` 里 `isSoundingOnADeck` 的原样搬家）
- Modify：`src/services/playbackBlobUrls.ts`（:7-11、`retireBlobUrl` :37-46，新增 `releasePlaybackBlobUrl`）
- Modify：`src/services/onlinePlayback.ts`（:19-70：外部歌曲分支提到缓存查询之前，改走登记表）
- Modify：`src/hooks/usePlaybackQueueController.ts`（:571-573 过期请求的 revoke）
- Modify：`src/components/app/playback/restorePlaybackSource.ts`（`replaceBlobUrl` :56-64）
- 不改：
  - `src/services/prefetchService.ts`：:220 的跳过保留，预热源由登记表提供。
  - `createOnlineRecoveryController.ts`：`blob:` 源不走恢复，见 App.tsx:2673-2680。
  - `usePlaybackUiEffects.ts`：只在卸载时 revoke。
- Test：
  - `test/unit/externalPlayback/carrierRegistry.test.ts`（新）
  - `test/unit/playback/playbackBlobUrls.test.ts`（追加；mock `@/services/externalPlayback/carrierRegistry`）
  - `test/unit/onlinePlayback.test.ts`（追加，复用 `isExternalMock` / `sourceMock`）

**Interfaces：**
- Consumes：`omni.getAudioSource`、`toSafePlaybackUrl`、`getPlaybackSongKey`。
- Produces：

```ts
// carrierRegistry.ts
export interface CarrierRegistryDeps { create(song: SongResult): Promise<string>; revoke(url: string): void; isInUse(url: string): boolean }
export interface CarrierRegistry {
    acquire(song: SongResult): Promise<string>;   // +1 synchronously; same playback key -> same URL while held
    peek(song: SongResult): string | null;        // resolved URL of a held song
    release(song: SongResult): void;              // -1; no-op for an unknown song
    releaseUrl(url: string): boolean;             // same by URL; false when the URL is not a held carrier
    owns(url: string): boolean;
}
export const createCarrierRegistry: (deps: CarrierRegistryDeps) => CarrierRegistry;
export const carrierRegistry: CarrierRegistry;   // create = omni.getAudioSource(song, 'standard') -> toSafePlaybackUrl, else OnlineProviderError('not-playable')
export const acquireCarrier: (song: SongResult) => Promise<string>;
export const releaseCarrier: (song: SongResult) => void;
export interface CarrierSlot { want(song: SongResult | null): string | null }   // holds one song; null while minting
export const createCarrierSlot: (registry: CarrierRegistry) => CarrierSlot;

// src/utils/mediaElementSources.ts
export const isUrlOnAudioElement: (url: string) => boolean;

// playbackBlobUrls.ts
export const releasePlaybackBlobUrl: (url: string) => void;   // a held carrier is released, anything else revoked
// retireBlobUrl(url): a held carrier is released, never kept in the ledger and never revoked here
```

规则：
- **引用计数归零**：条目立即从表里删除，URL 进入「待回收」列表。之后每次 `acquire` / `release` / `releaseUrl` 都扫一遍这个列表，`isInUse` 为假的就 revoke。
- **重新取得**：同一首歌归零后再 `acquire`，铸一个新 URL。
- **铸造失败**：`create` 拒绝时删除条目，所有等待者都收到这个拒绝。
- **预热槽 `want(song)`**：
  - 歌曲（按 key）变了：先 release 旧的，再 acquire 新的；
  - resolve 后，如果仍然想要这首，就记下 URL；
  - 同一首歌失败过一次，在换歌或 `want(null)` 之前不再重试。
- **`loadOnlineSongAudioSource`**：外部歌曲改走 `acquireCarrier`，返回值仍是 `{ kind:'ok', audioSrc: url, blobUrl: url, replayGain: song.replayGain }`；被拒绝时按 `OnlineProviderError` 映射为 `unavailable`。
- **调用方不用改**：`playSong` 换歌时的 `retireBlobUrl(prev)` 会自动把载体改成 release。

- [ ] **Step 1：写失败测试**

```ts
// carrierRegistry.test.ts：deps.create 每次铸 `blob:${song.id}:${++minted}`，revoke = vi.fn()，isInUse 默认 false
it('hands out one URL per song while it is held', async () => {
    const [a, b] = await Promise.all([registry.acquire(APPLE), registry.acquire(APPLE)]);
    expect(a).toBe(b); expect(deps.create).toHaveBeenCalledTimes(1); expect(registry.peek(APPLE)).toBe(a);
});
it('revokes only after the last release', async () => { /* acquire ×2 → release 一次：没有 revoke；再 release：revoke(url)，owns(url) 为 false */ });
it('keeps a released carrier while a deck still renders it and sweeps it later', async () => {
    /* isInUse → true；release 到 0 → 没有 revoke；isInUse → false，再 acquire(另一首) → revoke(旧 url) */ });
it('mints a fresh carrier for a song acquired again after its last release', async () => { /* URL 不同 */ });
it('forgets a carrier that failed to mint', async () => { /* 第一次 create 拒绝 → acquire 拒绝；release 不抛；下一次 acquire 再调 create */ });
it('releases by URL and says whether it owned it', async () => { /* releaseUrl('blob:other') 为 false */ });
it('lets a slot hold one song at a time', async () => {
    /* want(A) → null；flush 后 want(A) → url；want(B) → A 被 release；want(null) → B 被 release */ });

// playbackBlobUrls.test.ts（registryMock.releaseUrl：url === 'blob:carrier' 时返回 true）
it('releases a carrier instead of holding or revoking it', () => {
    decksHolding('blob:carrier'); retireBlobUrl('blob:carrier');
    expect(registryMock.releaseUrl).toHaveBeenCalledWith('blob:carrier');
    decksHolding(); retireBlobUrl(null);
    expect(revoke).not.toHaveBeenCalledWith('blob:carrier');
});
it('releasePlaybackBlobUrl releases a carrier and revokes anything else', () => { /* 'blob:carrier' → releaseUrl；'blob:x' → revoke('blob:x') */ });

// onlinePlayback.test.ts（用一首与现有外部用例 key 不同的歌）
it('gives the same carrier to the same external song while it is held', async () => {
    /* 连调两次 loadOnlineSongAudioSource → 结果相同，sourceMock 只调用一次 */ });
it('reports an external song whose carrier cannot be minted as unavailable', async () => {
    /* sourceMock 拒绝 OnlineProviderError('not-playable') → { kind: 'unavailable', reason: 'not-playable' } */ });
```

- [ ] **Step 2：确认测试失败**

Run：`npx vitest run -c vitest.config.ts test/unit/externalPlayback/carrierRegistry.test.ts test/unit/playback/playbackBlobUrls.test.ts test/unit/onlinePlayback.test.ts`
Expected：新增用例 FAIL。

- [ ] **Step 3：实现登记表和改道**

- [ ] **Step 4：确认通过**

Run：`npx vitest run -c vitest.config.ts test/unit/externalPlayback test/unit/playback test/unit/onlinePlayback.test.ts test/unit/prefetchService.test.ts && npm run typecheck`
Expected：PASS（现有 `hands an external carrier back as a blob…` 不改也通过）。

- [ ] **Step 5：提交**

```bash
git add src/services/externalPlayback/carrierRegistry.ts src/utils/mediaElementSources.ts src/services/playbackBlobUrls.ts src/services/onlinePlayback.ts src/hooks/usePlaybackQueueController.ts src/components/app/playback/restorePlaybackSource.ts test/unit/externalPlayback/carrierRegistry.test.ts test/unit/playback/playbackBlobUrls.test.ts test/unit/onlinePlayback.test.ts
git commit -m "feat(apple-music): 外部歌曲共享载体登记表" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin claude/apple-music-support-90e440
```

---

### Task 5：Automix 混合过渡规则

**Files：**
- Modify：`src/services/automix/transitionStrategy.ts`（文件末尾加 `planForExternalPair`）
- Modify：`src/services/automix/automixSession.ts`
  - `AutomixTransitionRequest`（:156-169）
  - `requestTransition`：getStems :766-768、规划 :786、臂起条件 :800
  - `handleActiveDeckPlaying`：拒绝原因 :922、`useStems` :982、变速 :995、`planBlendShape` :1017、平衡 :1193
  - `settle` 清掉待拒绝标记
  - 返回对象加 `cutTransition`
- Modify：`src/services/externalPlayback/externalPlaybackGuards.ts`
- Modify：`src/services/automix/useAutomixDecks.ts`
  - 窗口 :566、守卫 :578、预热 :590-612、请求 :614-629
  - `onTailSrcChange(null)` :420-427 释放预热槽
  - 卸载 :812-815
- Test：
  - `test/unit/automix/automixSession.test.ts`（新增 describe `automix session, one side played by an external engine`）
  - `test/unit/externalPlayback/externalPlaybackGuards.test.ts`（追加）

**Interfaces：**
- Consumes：
  - Task 1 的 `rampFade` 与包络端口
  - Task 4 的 `carrierRegistry`、`createCarrierSlot`
  - `planCrossfade`、`clampCrossfadeSeconds`、`crossoverFor`
- Produces：

```ts
// automixSession.ts
export const EXTERNAL_PREROLL_SEC = 2.5;
export type AutomixExternalSide = 'from' | 'to';
export interface AutomixTransitionRequest { /* existing */ external?: AutomixExternalSide | null }
// on the session object:
cutTransition(reason: string): void;   // armed: the first sound refuses it; fading: both fades cut now (CUT_SECONDS), settle after +70 ms; idle: no-op

// transitionStrategy.ts
export const planForExternalPair: (settings: TransitionSettings, from: TransitionTrack, to: TransitionTrack,
    external: AutomixExternalSide, at?: number) => TransitionPlan;

// externalPlaybackGuards.ts
export const externalSideOf: (from: SongResult | null | undefined, to: SongResult | null | undefined) => 'from' | 'to' | 'both' | null;
```

规则：
- **`planForExternalPair`**：
  - 外部一侧剥成 `{ duration, lines: null, profile: null }`，另一侧保留 profile、去掉 `separated`；
  - 然后 `planCrossfade(from', to', clampCrossfadeSeconds(settings.crossfadeMaxSec), at)`，不看 `mode` 和 `performance`；
  - `reason` 前缀写 `external engine on one side, `。
- **`requestTransition`**：
  - `request.external` 有值时改走 `planForExternalPair`，并且不查 stems；
  - 臂起提前量 `lead = AUTOMIX_ARM_LEAD_SEC + (external === 'to' ? EXTERNAL_PREROLL_SEC : 0)`；
  - 释放计时器公式不变（它本来就覆盖整个 `startIn`）；
  - 把 `external` 记成 `plannedExternal`，settle 时清掉。
- **`handleActiveDeckPlaying`，当 `plannedExternal` 有值时**：
  - `planBlendShape` 的 `outgoingDb`、`nextBeatIn`、`periodSec` 一律传 null；
  - `useStems = false`；
  - 不调用 `applyTempoBend`，`applied = 1`，载体的 `playbackRate` 归同步控制器管；
  - 不启动平衡修正；
  - band、echo、build-up 本来就不会出现（plainBlend、`echoThrow: false`、没有 `expansion`）。

  `plannedExternal` 为空时一行逻辑都不变。
- **`cutTransition`**：
  - armed 时置 `pendingRefusal = reason`，在 :922 优先作为拒绝原因；
  - fading 时清掉计时器、停掉 stem 链，对两个 fade 各调 `rampFade`（tail → 0、active → 1，都是 `CUT_SECONDS`），再在 `CUT_SECONDS*1000 + 70` ms 后 `settle({ pauseTail: true })`；
  - 每次都打一行 `[Automix] cutting the blend, ${reason}`。
- **`useAutomixDecks`**：
  - 第一道窗口放宽到 `AUTOMIX_MAX_OVERLAP_SEC + AUTOMIX_ARM_LEAD_SEC + EXTERNAL_PREROLL_SEC`。
  - `side = externalSideOf(currentSong, nextSong)`。`side === 'both'` 时 `report(..., 'external playback engine on both sides, hard cut')`，替换原来 :578 的判断。
  - 紧接着：`side !== 'to'` 且 `duration - time > AUTOMIX_MAX_OVERLAP_SEC + AUTOMIX_ARM_LEAD_SEC` 时 return。这样非 `'to'` 的预热和臂起时机与今天完全一致，只是 `disabled` / `loop-one` / `queue-end` 这几行日志可能早 2.5 s 打出。
  - 预热：`const carrier = warmSlotRef.current.want(side === 'to' ? nextSong : null)`。`side === 'to'` 时 `nextWarmSrc = carrier`，否则沿用原表达式。
  - 请求带上 `external: side`。
  - `onTailSrcChange(null)` 时和卸载时调 `want(null)`。
  - `harvestDeck` 和 stems effect 里的 `involvesExternalPlayback` 保留。

- [ ] **Step 1：写失败测试**

```ts
// automixSession.test.ts —— BLENDABLE_FROM 没有 profile，所以 4 s 交叉淡化的 outStart = 96
const MIXED = { mode: 'automix' as const, crossfadeMaxSec: 4, performance: true };
it('plans a mixed pair as a plain crossfade of the crossfade setting', () => {
    const h = createHarness();
    const plan = h.arm({ time: 92.5, external: 'to', settings: MIXED, to: withIntro({ leadIn: 2 }) });
    expect(plan).toMatchObject({ kind: 'fade', style: 'plainBlend', overlap: 4, outStart: 96, inStart: 0, stretch: 1, echoThrow: false });
    expect(plan?.expansion).toBeUndefined();
    expect(h.stemAsks).toHaveLength(0);
});
it('arms an arriving external song the preroll ahead and holds the autoplay over it', () => {
    const h = createHarness();
    h.arm({ time: 92.4, external: 'to', settings: MIXED });
    expect(h.session.getPhase()).toBe('idle');
    h.arm({ time: 92.5, external: 'to', settings: MIXED });
    expect(h.autoplayHolds).toEqual([true]);
    vi.advanceTimersByTime((96 - 92.5 - 0.25) * 1000 - 100); expect(h.autoplayHolds).toEqual([true]);
    vi.advanceTimersByTime(200); expect(h.autoplayHolds).toEqual([true, false]);
});
it('arms a leaving external song with the ordinary lead', () => { /* external 'from'，time 92.5 → 仍为 idle；time 95 → armed */ });
it('blends a mixed pair without balance, bands, echo, a tempo bend or a beat snap', () => {
    const h = createHarness({ A: { loudnessDb: -10, bpm: 120, nextBeatIn: 0.1 }, B: { loudnessDb: -30 } });
    h.arm({ time: 95, external: 'from', settings: MIXED });
    h.elements.A.currentTime = 96; h.elements.A.playbackRate = 1.05;   // the sync's nudge must survive
    h.session.handleActiveDeckPlaying('local:next-song');
    vi.advanceTimersByTime(300);
    expect(lastCurve(h.chains.A.fadeNode)?.duration).toBe(4);
    expect(Array.from(lastCurve(h.chains.A.fadeNode)!.curve)).toEqual(Array.from(buildCrossfadeCurves(crossoverFor(null)).out));
    expect(h.chains.A.trimNode.events).toHaveLength(0);
    for (const deck of ['A', 'B'] as const) h.chains[deck].toneParams.forEach(p => expect(p.events).toHaveLength(0));
    expect(h.chains.A.throwParam.events).toHaveLength(0);
    expect(h.elements.A.playbackRate).toBe(1.05);
});
it('refuses an armed blend once it is cut', () => {
    /* external 'to' 在 92.5 臂起；cutTransition('Music did not start')；advanceTimersByTime(3_300)；handleActiveDeckPlaying →
       lastCurve(B.fadeNode) 为 null，finalTarget(A.fadeNode) 0，finalTarget(B.fadeNode) 1；再推进 200 ms → phase idle */ });
it('cuts a running blend at once', () => {
    /* external 'from' 在 95 臂起，A.currentTime 96，开始播放；cutTransition → A 最后一条包络 { seconds 0.05, points.at(-1) 0 }，
       B 为 1；推进 200 ms → phase idle，elements.A.pause 被调用 */ });
it('ignores a cut with no transition', () => { /* idle 时 cutTransition → 没有 fade 事件，没有包络 */ });

// externalPlaybackGuards.test.ts
it('names the external side of a song change', () => {
    expect(externalSideOf(neteaseSong, appleSong)).toBe('to');
    expect(externalSideOf(appleSong, neteaseSong)).toBe('from');
    expect(externalSideOf(appleSong, appleSong)).toBe('both');
    expect(externalSideOf(neteaseSong, neteaseSong)).toBeNull();
});
```

- [ ] **Step 2：确认测试失败**

Run：`npx vitest run -c vitest.config.ts test/unit/automix/automixSession.test.ts test/unit/externalPlayback/externalPlaybackGuards.test.ts`
Expected：新增用例 FAIL。

- [ ] **Step 3：实现**

- [ ] **Step 4：确认通过**

Run：`npx vitest run -c vitest.config.ts test/unit/automix test/unit/externalPlayback && npm run typecheck`
Expected：PASS，现有用例不改。

- [ ] **Step 5：提交**

```bash
git add src/services/automix/transitionStrategy.ts src/services/automix/automixSession.ts src/services/externalPlayback/externalPlaybackGuards.ts src/services/automix/useAutomixDecks.ts test/unit/automix/automixSession.test.ts test/unit/externalPlayback/externalPlaybackGuards.test.ts
git commit -m "feat(apple-music): Automix 允许 Apple 与其他平台交叉淡化" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin claude/apple-music-support-90e440
```

---

### Task 6：同步控制器：`'preroll'`、过渡期以载体为基准、三项加固

**Files：**
- Modify：`src/services/externalPlayback/externalPlaybackSync.ts`
  - `start` :144、`abortStart` :156、`lastOurReading` :118
  - `advanceAudibleWait` :246、`followPlaying` :294
  - `handleOtherTrack` / `musicReachedOurEnd` :337、:353
  - `handleCarrierPause` :402、`handleCarrierSeeked` :415
- Test：`test/unit/externalPlayback/externalPlaybackSync.test.ts`（追加）

**Interfaces：**
- Consumes：现有 `OmniExternalPlaybackEngine`、`ExternalPlaybackCarrier`。
- Produces：

```ts
export type ExternalPlaybackStartIntent = 'play' | 'idle' | 'preroll';
start(intent: ExternalPlaybackStartIntent): void;
/** Automix settled: Music becomes the position master again. */
endTransition(): void;
/** Also ends a pending preroll (pausing Music if its play was sent). */
abortStart(): void;
```

规则：
- **`start('preroll')`**：
  - `beginAudibleWait('preroll', carrier.currentTime)`，`startPlayLive = true`，`carrierMaster = true`，然后 `sendPlay`；
  - 不设 `held`，也永远不调用 `onHoldReleased`（session 不 hold）；
  - 等待期间仍然只做出声判断；「远离目标 > 1 s 补 seek 一次」的规则照旧。
- **预滚出声时**：
  - 载体暂停（Automix hold）→ 什么都不做；
  - 载体在播且 `carrierMaster` → `|est − carrier.currentTime| > SYNC_DRIFT_SEEK_SEC` 时 `sendSeek(carrier.currentTime)`；
  - 载体在播且已经 `endTransition` → 按开播 hold 的做法 `seekCarrier(est)`。
- **`carrierMaster` 期间的 `followPlaying`**：
  - 照常记录 `lastOurReading`；
  - 载体暂停时**不** `playCarrier()`；
  - 稳定期内什么都不做；
  - 稳定期外 `|drift| > SYNC_DRIFT_SEEK_SEC` 时 seek「音乐」App 到 `carrier.currentTime`；
  - 永远不调载体的 `playbackRate`。

  `endTransition()` 只清掉 `carrierMaster`。
- **预滚等待期间收到非内部的载体 `pause`**：结束等待（不报失败），然后照常 `sendPause`。
- **加固 (a)**：
  - `lastOurReading` 增加 `sampledAtMs`；
  - `musicReachedOurEnd(foreign)` 判断的是：`durationSec − (positionSec + (foreign.sampledAtMs − stored.sampledAtMs)/1000) ≤ SYNC_MUSIC_TRANSITION_WINDOW_SEC`。
- **加固 (b)**：`state.durationSec` 不是正数时视为 null，退回载体时长。
- **加固 (c)**：非内部的 `seeked` 清空 `lastOurReading`。

- [ ] **Step 1：写失败测试**

```ts
const startPreroll = async () => {
    sync.start('preroll'); await flushPromises();
    engine.emit(state({ positionSec: 0 }));
    clock += 250; engine.emit(state({ positionSec: 0.13 }));   // audible
};
it('prerolls Music without touching the held carrier', async () => {
    await startPreroll();
    expect(engine.play).toHaveBeenCalledWith(song, 0);
    clock += 1000; engine.emit(state({ positionSec: 1.2 }));
    expect(carrier.play).not.toHaveBeenCalled(); expect(carrier.currentTime).toBe(0);
    expect(engine.seek).not.toHaveBeenCalled(); expect(onHoldReleased).not.toHaveBeenCalled(); expect(onIssue).not.toHaveBeenCalled();
});
it('seeks Music back to the carrier once Automix starts it', async () => {
    await startPreroll();
    clock += 2000; engine.emit(state({ positionSec: 2.1 }));
    await carrier.play();                                   // Automix lifts its hold
    expect(engine.resume).not.toHaveBeenCalled(); expect(engine.play).toHaveBeenCalledTimes(1);
    clock += 100; engine.emit(state({ positionSec: 2.2 }));
    expect(engine.seek).toHaveBeenCalledWith(0); expect(carrier.playbackRate).toBe(1); expect(carrier.currentTime).toBe(0);
});
it('leaves Music alone for drift under a second while the carrier leads', async () => {
    /* 接上一条：clock += SYNC_SETTLE_MS；carrier.currentTime = 1；emit 1.5 → 没有新的 seek，playbackRate 1 */ });
it('follows Music again once the transition ends', async () => {
    /* endTransition()；carrier.currentTime 1，emit 1.3（稳定期外）→ playbackRate 1.05 */ });
it('fails a preroll that never becomes audible within 8 s', () => { /* start('preroll')；推进 8000 → onIssue failure，code 'not-playable' */ });
it('reports a rejected preroll play', async () => { /* engine.play 拒绝 → onIssue failure */ });
it('pauses Music when a preroll is aborted', async () => { /* start('preroll')；abortStart() → engine.pause；推进 8000 → 没有 onIssue */ });
it('ends the preroll wait on a carrier pause without a failure', async () => {
    /* start('preroll')；carrier.play()（Music 出声前就被释放）；carrier.pause() → engine.pause；推进 8000 → 没有 onIssue */ });
it('ages the last reading of ours to the foreign sample, so a 12 s crossfade still ends ours', async () => {
    await startPlaying();
    carrier.currentTime = 180; engine.emit(state({ positionSec: 180, durationSec: 197.72 }));   // 17.72 s left
    clock += 6000; carrier.currentTime = 186;
    engine.emit(state({ mediaId: OTHER_ID, positionSec: 0.5 }));                                // aged: 11.72 s left
    expect(engine.pause).toHaveBeenCalledTimes(1);
    expect(carrier.currentTime).toBe(carrier.duration); expect(onIssue).not.toHaveBeenCalled();
});
it('falls back to the carrier duration when Music reports a non-positive one', async () => {
    /* currentTime 60，emit { positionSec 60, durationSec 0 }；clock += SYNC_SETTLE_MS；另一首的读数 → takeover track-changed，currentTime 仍为 60 */ });
it('forgets the last reading when the listener seeks', async () => {
    /* emit 194.5 / 197.72；carrier.userSeek(30) → engine.seek(30)；clock += SYNC_SETTLE_MS；另一首的读数 → takeover track-changed，currentTime 30 */ });
```

- [ ] **Step 2：确认测试失败**

Run：`npx vitest run -c vitest.config.ts test/unit/externalPlayback/externalPlaybackSync.test.ts`
Expected：新增用例 FAIL；三条加固用例在旧代码下分别是「被判接管」/「提前完成」/「提前完成」。

- [ ] **Step 3：实现**

- [ ] **Step 4：确认通过**

Run：同 Step 2，再加 `&& npm run typecheck`。Expected：PASS，现有 71 条不改。

- [ ] **Step 5：提交**

```bash
git add src/services/externalPlayback/externalPlaybackSync.ts test/unit/externalPlayback/externalPlaybackSync.test.ts
git commit -m "feat(apple-music): 同步控制器预滚起播、过渡期以载体为基准并加固结尾判断" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin claude/apple-music-support-90e440
```

---

### Task 7：session：按 src 绑定、保留 tail、预滚、持有镜像

**Files：**
- Modify：`src/services/externalPlayback/externalPlaybackSession.ts`
  - input / deps :19-39
  - `update` :107-126、`isAutoplayHeld` :129、`mirrorVolume` :141-148
  - `attach` :162-187、`startSync` 的 `onIssue` :202-208、`tryBegin` :232-239
  - `abortHold` :293、`detach` :303、`dispose` :151
- Test：`test/unit/externalPlayback/externalPlaybackSession.test.ts`
  - `FakeSync` 增加 `endTransition: vi.fn()`，intent 类型放宽为 `ExternalPlaybackStartIntent`
  - 新增 describe，注入 fake 镜像；现有 `describe` 和 `input()` 不动

**Interfaces：**
- Consumes：Task 3 的 `ExternalVolumeMirror`；Task 6 的 `ExternalPlaybackStartIntent`、`endTransition`；`AutomixDeckId`；`getPlaybackSongKey`。
- Produces：

```ts
export type ExternalPlaybackSessionCarrier = NonNullable<ExternalPlaybackSessionInput['carrier']>;
export interface ExternalPlaybackDeck { id: AutomixDeckId; element: ExternalPlaybackSessionCarrier | null; src: string | null }
export interface ExternalPlaybackTransition { tail: { deck: AutomixDeckId; song: SongResult }; incoming: { deck: AutomixDeckId; song: SongResult } }
export interface ExternalPlaybackSessionInput {
    /* existing: song, audioSrc, carrier (the active deck), playerState, wantsAutoplay, isLyricsLoading */
    decks?: readonly ExternalPlaybackDeck[];
    transition?: ExternalPlaybackTransition | null;
}
export interface ExternalPlaybackSessionDeps {
    /* existing */
    cutTransition?(): void;
    audioNow?(): number | null;
    createMirror?(): ExternalVolumeMirror;   // test seam; default new ExternalVolumeMirror({ audioNow, now })
}
export interface ExternalPlaybackBinding {
    song: SongResult; src: string; key: string; carrier: ExternalPlaybackSessionCarrier;
    deck: AutomixDeckId | null; role: 'current' | 'tail' | 'incoming';
}
export const resolveExternalBinding: (input: ExternalPlaybackSessionInput, isExternal: (song: SongResult | null | undefined) => boolean) => ExternalPlaybackBinding | null;
// ExternalPlaybackSession:
isAutoplayHeld(song: SongResult | null, audioSrc: string | null, incomingSongKey?: string | null): boolean;
handleDeckEnvelope(deck: AutomixDeckId, envelope: DeckGainEnvelope): void;
handleFadeEnvelope(envelope: DeckGainEnvelope): void;
// mirrorVolume(volume) keeps its signature and now feeds mirror.setUserVolume
export { EXTERNAL_VOLUME_THROTTLE_MS } from './externalVolumeMirror';
```

规则：
- **`resolveExternalBinding`**（按顺序，第一条命中就返回；`key = 歌曲 key|src`）：
  1. `transition` 存在且 tail 歌曲是外部歌曲 → 绑定 `decks[tail.deck]` 的 src / element，role `'tail'`。
  2. `transition` 存在且 incoming 歌曲是外部歌曲，并且 `decks[incoming.deck].src` 非空、不等于 tail deck 的 src → role `'incoming'`。后一个条件排除的是「没有预热源时 active deck 暂时回落到旧 `audioSrc`」的情况。
  3. 当前歌曲是外部歌曲且 `audioSrc` 非空 → 取 `decks` 里 src 等于 `audioSrc` 的那个 deck；没有传 `decks` 时用 `input.carrier`，此时 deck 为 null。role `'current'`。
- **绑定变化**（key 或 carrier 变了）：
  - 旧 attachment 调 `dispose({ stopEngine })`。只有当新绑定的歌曲（没有绑定时看当前歌曲）也是外部歌曲时，`stopEngine` 才为假，与现状一致。
  - 停用时调 `mirror.unbind()`。
  - 新 attachment 的 intent：`'incoming'` → `'preroll'`；`'tail'` → `'idle'`（不为正在淡出的歌起播）；其他情况按 `wantsAutoplay`。
  - attach 时 `mirror.bind({ engine, mediaId, deck, carrier })`。
  - `'preroll'` 与 `'idle'` 一样立即把这个 key 记为已释放，所以 session 不 hold。
- **绑定不变、只有 role 变**：
  - `'incoming'` → `'current'`（过渡结束）：调 `sync.endTransition()`；
  - `'current'` ↔ `'tail'`：什么都不做。这是修问题 (a) 和中途取消回尾的关键。
- **`tryBegin`**：
  - `'preroll'` 不等歌词；
  - 顺序是先 `sync.start(intent)`，再在 intent 不是 `'idle'` 时调 `mirror.drive()`；
  - 删除原来的 `sendVolume(lastVolume)`，现有用例「play 之后紧跟音量」仍然成立。
- **载体监听**：session 已有的 play / pause watch 里，当前 attachment 的 `play` → `mirror.drive()`，`pause` → `mirror.yieldControl()`。
- **`playerState` 变为 PAUSED**：
  - 现有 `abortHold` 照旧；
  - 另外，attachment 处于预滚中（intent `'preroll'`，并且自 attach 以来载体还没 `play` 过）→ `sync.abortStart()`，intent 改为 `'idle'`，`mirror.yieldControl()`；
  - 不调 `clearAutoplayIntent`：这次推进的自动播放由 Automix 的 `suppressAutoplayRef` 管。
- **`onIssue`**：
  - 预滚中的 attachment 报 failure → 先 `deps.cutTransition?.()`，再 `deps.onIssue(issue)`，之后照旧 `replaceFailedSync`；
  - 任何 takeover 或 failure 都调一次 `mirror.yieldControl()`。
- **转发**：`isAutoplayHeld` 遇到 `getPlaybackSongKey(song) === incomingSongKey` 时返回 false；`handleDeckEnvelope` / `handleFadeEnvelope` / `mirrorVolume` 原样转给镜像；`dispose()` 再加一句 `mirror.dispose()`。

- [ ] **Step 1：写失败测试**

新 describe 的工具：
- `deckA = carrier`、`deckB = new FakeCarrier()`，两者 `readyState = 1`。
- `decks = (a, b) => [{ id: 'A', element: deckA, src: a }, { id: 'B', element: deckB, src: b }]`。
- `mirror = { bind, drive, yieldControl, unbind, dispose, setUserVolume, handleDeckEnvelope, handleFadeEnvelope }` 全部 `vi.fn()`，通过 `createMirror: () => mirror as unknown as ExternalVolumeMirror` 注入。

```ts
const outTo = { tail: { deck: 'A' as const, song: APPLE }, incoming: { deck: 'B' as const, song: NETEASE } };
const inTo = { tail: { deck: 'A' as const, song: NETEASE }, incoming: { deck: 'B' as const, song: APPLE } };
it('keeps the tail controller through the advance and stops Music only when the tail settles', () => {
    session.update(input({ decks: decks(SRC, null) }));
    const first = latest();
    session.update(input({ carrier: deckB, decks: decks(SRC, 'https://n'), transition: outTo }));
    session.update(input({ song: NETEASE, audioSrc: 'https://n', carrier: deckB, decks: decks(SRC, 'https://n'), transition: outTo }));
    expect(createSync).toHaveBeenCalledTimes(1); expect(first.options.carrier).toBe(deckA);
    expect(first.sync.dispose).not.toHaveBeenCalled(); expect(engine.setMonitoring).not.toHaveBeenCalledWith(false);
    session.update(input({ song: NETEASE, audioSrc: 'https://n', carrier: deckB, decks: decks(null, 'https://n'), transition: null }));
    expect(first.sync.dispose).toHaveBeenCalledWith({ stopEngine: true });
    expect(engine.setMonitoring).toHaveBeenLastCalledWith(false); expect(mirror.unbind).toHaveBeenCalled();
});
it('prerolls the arriving Apple song at arm without a hold or a lyric wait', () => {
    session.update(input({ song: NETEASE, audioSrc: 'https://n', carrier: deckB, decks: decks('https://n', SRC), transition: inTo, isLyricsLoading: true }));
    expect(latest().options.carrier).toBe(deckB); expect(latest().sync.start).toHaveBeenCalledWith('preroll');
    expect(session.isAutoplayHeld(APPLE, SRC, getPlaybackSongKey(APPLE))).toBe(false);
    expect(mirror.bind).toHaveBeenCalledWith(expect.objectContaining({ deck: 'B', carrier: deckB }));
    expect(mirror.drive.mock.invocationCallOrder[0]).toBeGreaterThan(latest().sync.start.mock.invocationCallOrder[0]);
});
it('keeps the prerolled controller when the advance commits it', () => { /* update(APPLE, SRC, decks('https://n', SRC), inTo) → createSync 仍只调用一次 */ });
it('hands the position back to Music when the transition settles', () => { /* 再 update(APPLE, SRC, decks(null, SRC), transition null) → endTransition 调用一次，dispose 未调用 */ });
it('does not bind an arriving Apple song to a deck still rendering the outgoing source', () => {
    /* inTo，decks('https://n', 'https://n') → createSync 未调用 */ });
it('aborts the preroll when the listener pauses during the lead', () => {
    /* 预滚后 update(..., playerState: PAUSED) → abortStart，mirror.yieldControl；clearAutoplayIntent 未调用 */ });
it('cuts the blend before routing a failed preroll', () => {
    /* 预滚后 options.onIssue(failure) → cutTransition 先于 onIssue，然后 dispose({ stopEngine: true }) */ });
it('keeps the same controller when a mid-blend cancel returns to the outgoing Apple song', () => {
    /* 照第一条走到 advance 已提交；然后 update(APPLE, SRC, carrier deckA, decks(SRC, null), transition null) →
       createSync 仍只一次，dispose 与第二次 start 都未调用 */ });
it("yields Music's volume when its carrier pauses and drives it again when it plays", async () => {
    /* attach（play）；await deckA.play() → drive；deckA.pause() → yieldControl */ });
it("yields Music's volume on a takeover", () => { /* options.onIssue(takeover track-changed) → yieldControl */ });
it('hands envelopes and the user volume to the mirror', () => { /* handleDeckEnvelope / handleFadeEnvelope / mirrorVolume 原样转发 */ });
```

- [ ] **Step 2：确认测试失败**

Run：`npx vitest run -c vitest.config.ts test/unit/externalPlayback/externalPlaybackSession.test.ts`
Expected：新增用例 FAIL；现有 24 条仍然 PASS 或因缺少导出而编译失败。

- [ ] **Step 3：实现**

- [ ] **Step 4：确认通过，现有用例一个不改**

Run：`npx vitest run -c vitest.config.ts test/unit/externalPlayback && npm run typecheck`
Expected：PASS。现有的 `mirrors volume only while an external song is current`、`tells Music the current volume right behind a play start…`、`swallows a refused volume command` 由真实镜像的「空闲绑定 + 100 ms 节流」和「drive 立即发送」满足。

- [ ] **Step 5：提交**

```bash
git add src/services/externalPlayback/externalPlaybackSession.ts test/unit/externalPlayback/externalPlaybackSession.test.ts
git commit -m "feat(apple-music): 外部播放 session 按载体绑定 deck、保留淡出 tail、预滚进入歌曲" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin claude/apple-music-support-90e440
```

---

### Task 8：App / hook 接线

**Files：**
- Modify：`src/services/automix/useAutomixDecks.ts`
  - 参数 :158-192
  - 端口 :384-435（加 `onDeckEnvelope`；`onTailSrcChange(null)` 里清 `transitionSongs`）
  - `checkTransitionPoint` :630-633：armed 后设置 `transitionSongs`
  - 返回 :817-841
- Modify：`src/hooks/useExternalPlaybackSync.ts`（整个文件，73 行）
- Modify：`src/App.tsx`
  - :524 旁边声明 `deckEnvelopeRef`
  - `useAutomixDecks` 调用 :1139-1161
  - `useExternalPlaybackSync` 调用 :1358-1365
- Test：`test/unit/hooks/useExternalPlaybackSync.test.ts`（新，沿用 `useAppleMusicLibrary.test.ts` mock `react` 的写法，并 mock `ExternalPlaybackSession` 类以捕获 deps 和 `update` 的入参）

**Interfaces：**
- Consumes：Task 1 的端口；Task 2 的 `registerPlaybackFadeEnvelopeListener`；Task 5 的 `cutTransition`；Task 7 的 session API。
- Produces：

```ts
// useAutomixDecks.ts
export interface AutomixTransitionSongs { tail: { deck: AutomixDeckId; song: SongResult }; incoming: { deck: AutomixDeckId; song: SongResult } }
// params: onDeckEnvelope?: (deck: AutomixDeckId, envelope: DeckGainEnvelope) => void   (read through a ref; ports are built once)
// returns additionally:
transitionSongs: AutomixTransitionSongs | null;
getDeckElement: (deck: AutomixDeckId) => HTMLAudioElement | null;
cutTransition: (reason: string) => void;

// useExternalPlaybackSync.ts
type UseExternalPlaybackSyncParams = {
    /* existing */
    audioContextRef: RefObject<AudioContext | null>;
    decks: { getElement(deck: AutomixDeckId): HTMLAudioElement | null; deckSrc(deck: AutomixDeckId): string | undefined };
    transition: ExternalPlaybackTransition | null;
    cutTransition: () => void;
};
// returns: { autoplayHeld: boolean; mirrorVolume: (volume: number) => void; handleDeckEnvelope: (deck: AutomixDeckId, envelope: DeckGainEnvelope) => void }
```

规则：
- **`transitionSongs`**：
  - 在 `requestTransition` 之后、`session.getPhase() === 'armed'` 时，用闭包里的值设置为 `{ tail: { deck: activeDeck, song: currentSong }, incoming: { deck: idleDeck, song: nextSong } }`。这时 `activeDeck` 还是臂起前的值。
  - `onTailSrcChange(null)` 时置 null。
- **hook 的 session deps** 增加：
  - `audioNow: () => audioContextRef.current?.currentTime ?? null`
  - `cutTransition: () => cutTransitionRef.current()`
- **hook 的 effect**：
  - 给 `update` 增加 `decks: (['A','B'] as const).map(id => ({ id, element: decks.getElement(id), src: decks.deckSrc(id) ?? null }))` 和 `transition`；
  - 依赖再加 `decks.deckSrc`（deck 的 src 一变它的 identity 就变）和 `transition`。
- **单独的 effect**：`registerPlaybackFadeEnvelopeListener(session.handleFadeEnvelope)`，卸载时传 null。
- **`autoplayHeld`**：`session.isAutoplayHeld(currentSong, audioSrc, transition ? getPlaybackSongKey(transition.incoming.song) : null)`。
- **App**：
  - `const deckEnvelopeRef = useRef<(deck: AutomixDeckId, envelope: DeckGainEnvelope) => void>(() => {});`
  - `useAutomixDecks({ …, onDeckEnvelope: (deck, envelope) => deckEnvelopeRef.current(deck, envelope) })`
  - `useExternalPlaybackSync({ …, audioContextRef, decks: { getElement: automix.getDeckElement, deckSrc: automix.deckSrc }, transition: automix.transitionSongs, cutTransition: () => automix.cutTransition('Music did not start in time') })`
  - 之后 `deckEnvelopeRef.current = externalPlayback.handleDeckEnvelope;`
  - `usePlaybackAudioBridge` 的 `isAutoplayHeld` 不变。

- [ ] **Step 1：写失败测试**

```ts
it('feeds the session both decks by the source each renders, and the transition songs', () => {
    /* deckSrc A→'blob:a'、B→undefined；transition = inTo；运行 effects → update 入参 decks 为
       [{ id:'A', element: elA, src:'blob:a' }, { id:'B', element: elB, src: null }]，transition 为 inTo */ });
it('does not hold the song a transition is bringing in', () => { /* isAutoplayHeld 第三个参数为 incoming 歌曲的 key */ });
it('routes pause-fade envelopes to the session while mounted', () => {
    /* 挂载 → registerPlaybackFadeEnvelopeListener(session.handleFadeEnvelope)；清理 → 以 null 调用 */ });
it('reads the audio clock and the cut through the latest props', () => {
    /* deps.audioNow() → audioContextRef.current.currentTime；deps.cutTransition() → 调到传入的 cutTransition */ });
it('hands deck envelopes to the session', () => { /* 返回的 handleDeckEnvelope('B', env) → session.handleDeckEnvelope('B', env) */ });
```

- [ ] **Step 2：确认测试失败**

Run：`npx vitest run -c vitest.config.ts test/unit/hooks/useExternalPlaybackSync.test.ts`
Expected：FAIL。

- [ ] **Step 3：实现接线**

- [ ] **Step 4：确认通过，并跑全部相关测试**

Run：`npx vitest run -c vitest.config.ts test/unit/hooks test/unit/automix test/unit/externalPlayback test/unit/playback test/unit/services test/unit/onlinePlayback.test.ts && npm run typecheck`
Expected：PASS。

- [ ] **Step 5：提交**

```bash
git add src/services/automix/useAutomixDecks.ts src/hooks/useExternalPlaybackSync.ts src/App.tsx test/unit/hooks/useExternalPlaybackSync.test.ts
git commit -m "feat(apple-music): 接上增益包络、deck 绑定与预滚" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin claude/apple-music-support-90e440
```

---

### Task 9：真机验收（controller + 用户）

**会在用户的 Mac 上播放音乐、改「音乐」App 的音量。开始前先告诉用户。**

- [ ] **Step 1：完整单测与类型检查**

Run：`npm run test:unit && npm run typecheck`
Expected：与基线相比没有新增失败（`crashLog.test.ts` 的 2 条是已知的基线失败）。

- [ ] **Step 2：`npm run dev:electron` 逐项验收**

交叉淡化模式（5 s）和 automix 模式各听一遍：

1. 网易云 → Apple、QQ → Apple 各 3 次：过渡一开始「音乐」App 就在出声，淡入连续，没有 1.5 s 晚启。日志里有 `external engine on one side, plain crossfade`。
2. Apple → 网易云各 3 次：「音乐」App 一直淡到过渡结束才停，之后「音乐」App 的音量滑块回到 Folia 的音量。
3. Apple → Apple：硬切，和以前一样。网易云 → 网易云：听感和日志形状都和改动前一致。
4. Apple 歌曲暂停 / 继续（设置里开着淡入淡出）：先淡出再停，继续时淡入；暂停后打开「音乐」App，音量不是 0。
5. 网易云 → Apple 臂起后、过渡开始前按暂停：「音乐」App 停下，8 s 后没有「播放失败」提示。
6. 过渡中途拖动进度条、暂停（取消回尾），两个方向各一次：留下的那首继续播，「音乐」App 没有被重新起播。
7. Apple → 网易云淡出时，在「音乐」App 里换一首歌：Folia 提示接管，这首歌以正常音量播放。
8. 预滚失败：臂起后立刻退出「音乐」App。过渡硬切，出现跳歌倒计时，「音乐」App 没有留在 0 音量。
9. 对齐：同一组过渡录屏或开日志，观察 `setVolume` 节奏与淡化同步，主观上没有可察觉的错位（目标误差 ≤ 100 ms）。

把结果追加到 spec 末尾的 `## 真机验收结果`。不通过的项要记下现象，回到对应任务修复。

- [ ] **Step 3：提交**

```bash
git add docs/superpowers/specs/2026-10-12-apple-music-crossfade-design.md
git commit -m "docs(apple-music): 交叉淡化真机验收记录" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin claude/apple-music-support-90e440
```

---

## Self-review

**Spec 覆盖：**
- §1 包络端口 → Task 1（Automix）、Task 2（暂停 / 继续）。
- §2 外部音量镜像 → Task 3（逻辑）、Task 7（由 session 持有，接管原 `mirrorVolume`）、Task 8（端口接线）。
- §3 共享载体 → Task 4（登记表与回收改道）、Task 5（Automix 预热槽）。
- §4 Automix 混合过渡：
  - 守卫、强制普通交叉淡化、关掉各项效果、预滚 → Task 5；
  - 拒绝路径 `cutTransition` → Task 5。
- §5 session / 同步控制器：
  - 按 src 绑定、保留 tail、预滚、不叠加 hold 与歌词门控、暂停 / 继续镜像 → Task 7；
  - `'preroll'`、载体为基准、settle 后交回「音乐」App → Task 6。
- 错误处理：
  - 预滚失败 → Task 6 超时 + Task 5 / 7 切过渡；
  - 接管 → Task 3 / 7 `yieldControl`；
  - IPC 慢 → Task 3 只保留最新值；
  - 「不留在 0」→ Task 3 恢复规则 + Task 7 的 unbind / dispose。
- 测试一节 → 各任务 Step 1；回归 → Task 8 Step 4、Task 9 Step 1；真机 → Task 9。
- 成功标准 1–5：Task 1、3、5、7、8 的单测 + Task 9。
- 外加的三项加固（老化读数、非正 duration、听者 seek 清读数）→ Task 6。

**类型一致性：**
- `DeckGainEnvelope` 只在 `src/services/gainEnvelope.ts` 定义一次，crossfadeGraph、automixSession、playbackFade、mirror、session、hook 都从这里取。
- `AutomixDeckId` 只从 `automixSession.ts` 取。
- `AutomixTransitionSongs`（useAutomixDecks）和 `ExternalPlaybackTransition`（session）结构相同，App 直接传。
- `ExternalPlaybackStartIntent` 同时用于同步控制器和 session 测试里的 `FakeSync`。
- `scheduleCrossfade` 仍返回 `boolean`，`scheduleCrossfadeEnvelopes(...).ok` 与它等价。
- `EXTERNAL_VOLUME_THROTTLE_MS` 搬到镜像文件，session 再导出。

**已自行裁定的歧义：**
1. spec 说「`scheduleCrossfade` 返回曲线」，但现有 crossfadeGraph 测试断言 `toBe(true/false)`，而成功标准 5 要求现有测试不动。所以保留 `boolean`，曲线由新的 `scheduleCrossfadeEnvelopes` 返回。
2. `scheduleStemWindow` 不发包络：混合过渡强制关掉 stems，非混合过渡没有消费者。
3. 「偏差超过阈值时 seek『音乐』App」的阈值定为 `SYNC_DRIFT_SEEK_SEC = 1`。过渡期间不调载体速率。settle 后交回「音乐」App 当基准，剩下的偏差由 ±5 % 速率吸收。
4. 混合过渡的 crossover 用 `crossoverFor(null)` = 0.45，不吸附节拍（spec 的「没有节拍对齐」）。时长在 automix 模式下也取交叉淡化滑块。
5. 预滚失败时，先由 session 调 `cutTransition`：armed 则在第一次出声时拒绝，fading 则 50 ms 内切断。然后才走现有失败路由（跳歌或暂停）。
6. 恢复时发的「用户音量」，取 `syncOutputGain` 最后一次传进来的值（静音时为 0），与现有的静音镜像一致。
7. 音频桥自己的 `!isLyricsLoading` 自动播放门控不改，它对所有来源一视同仁。spec 去掉的只是 session 自己的歌词门控。
8. 镜像对用户音量保留 100 ms 尾部节流，其余发送「最多一条在途、只保留最新值」。空闲绑定时只同步纯用户音量，从不发包络值；包络只在驱动中生效。
9. `prefetchService` 不改：预热源由登记表提供，音频预取的跳过保留。
10. `checkTransitionPoint` 的第一道窗口放宽 2.5 s，再用第二道窗口把非 `'to'` 的情况恢复成原时机。只有几条日志可能提前打出。
