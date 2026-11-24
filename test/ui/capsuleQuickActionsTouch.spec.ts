import { expect, test, type Page } from '@playwright/test';
import { APP_VERSION, GUIDE_VERSION_STORAGE_KEY, waitForAppMounted } from '../helpers/appState';

// test/ui/capsuleQuickActionsTouch.spec.ts
// 手机上胶囊上方那排命令：手指没有悬停，播放页上点开胶囊、或者一暂停就直接浮出，4 秒没碰连胶囊一起收起，
// 点别处立刻收；手指点开的这排没有音量（手机有实体音量键），按钮放大到 44px。桌面上开发时看不出来，钉在这里。

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }, screenshot: 'only-on-failure' });

const SONGS = [
    { id: 1, name: 'Current', artists: [{ id: 10, name: 'Alpha' }], album: { id: 20, name: 'Album' }, durationMs: 180_000 },
    { id: 2, name: 'Next', artists: [{ id: 10, name: 'Alpha' }], album: { id: 20, name: 'Album' }, durationMs: 180_000 },
];

const openPlayerWithSong = async (page: Page) => {
    // 假时钟照常走，只在要看 4 秒那一下时快进，不按真实时间等。
    await page.clock.install();
    await page.addInitScript(([version, guideKey]) => {
        localStorage.clear();
        localStorage.setItem('library_suite_prompt_seen', 'true');
        localStorage.setItem('folia_app_language', 'zh-CN');
        localStorage.setItem('open_player_on_launch', 'true');
        localStorage.setItem('visualizer_mode', 'classic');
        localStorage.setItem('static_mode', 'true');
        localStorage.setItem(guideKey, version);
    }, [APP_VERSION, GUIDE_VERSION_STORAGE_KEY] as const);
    await page.route('**/__mock_netease__/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await page.goto('/');
    await waitForAppMounted(page);
    await expect.poll(async () => page.evaluate(async (songs) => {
        try {
            const dbModulePath = '/src/services/db.ts';
            const { saveToCache } = await import(dbModulePath);
            await saveToCache('last_song', songs[0]);
            await saveToCache('last_queue', songs);
            return true;
        } catch {
            return false;
        }
    }, SONGS)).toBe(true);
    await page.reload();
    await waitForAppMounted(page);
    await expect(page.locator('[data-ponder="player-bar"]')).toBeVisible();
};

/** 直接写播放状态：这里要的只是「从播放到暂停」那一下，不需要真的出声。 */
const setPlayerState = (page: Page, state: 'PLAYING' | 'PAUSED') => page.evaluate(async ([storePath, next]) => {
    const { usePlaybackStore } = await import(storePath) as {
        usePlaybackStore: { getState: () => { setPlayerState: (value: string) => void } };
    };
    usePlaybackStore.getState().setPlayerState(next);
}, ['/src/stores/usePlaybackStore.ts', state] as const);

const quickActions = (page: Page) => page.getByTestId('capsule-quick-actions');

const readPlayerState = (page: Page) => page.evaluate(async (storePath) => {
    const { usePlaybackStore } = await import(storePath) as { usePlaybackStore: { getState: () => { playerState: string } } };
    return usePlaybackStore.getState().playerState;
}, '/src/stores/usePlaybackStore.ts');

test('a tap on the capsule floats the row up without volume, and it folds away after 4 seconds or a tap elsewhere', async ({ page }) => {
    await openPlayerWithSong(page);
    await setPlayerState(page, 'PLAYING');
    const capsule = page.locator('[data-ponder="player-bar"]');
    await expect(quickActions(page)).toHaveCount(0);

    // 点在收起的胶囊正中偏下、进度条外的内边距上：这里浏览器会补发 click（点在进度条上不发），
    // 胶囊撑开后这个位置是播放键。Chromium 的 click 还落在原来的节点上，别的浏览器可能按新布局落，
    // 所以这一下只点出那排、不能动播放状态。
    const collapsedBox = (await capsule.boundingBox())!;
    await page.touchscreen.tap(collapsedBox.x + collapsedBox.width / 2, collapsedBox.y + collapsedBox.height - 4);
    await expect(quickActions(page)).toBeVisible();
    await expect(page.getByTestId('command-palette-panel')).toHaveCount(0);
    expect(await readPlayerState(page)).toBe('PLAYING');
    await expect(quickActions(page).locator('[data-capsule-action="playback-volume"]')).toHaveCount(0);
    const box = await quickActions(page).locator('[data-capsule-action="open-command-palette"]').boundingBox();
    expect(box?.width).toBe(44);

    // 还在 4 秒里：浮着；过了 4 秒：连同胶囊一起收起。
    await page.clock.fastForward(2_500);
    await expect(quickActions(page)).toBeVisible();
    await page.clock.fastForward(2_000);
    await expect(quickActions(page)).toHaveCount(0);

    await capsule.tap();
    await expect(quickActions(page)).toBeVisible();
    await page.touchscreen.tap(195, 200);
    await expect(quickActions(page)).toHaveCount(0);
});

test('with the row up, a second tap on the capsule opens the command palette', async ({ page }) => {
    await openPlayerWithSong(page);
    await setPlayerState(page, 'PLAYING');
    const capsule = page.locator('[data-ponder="player-bar"]');

    await capsule.tap();
    await expect(quickActions(page)).toBeVisible();
    // 点胶囊上标题那一行的空处，不点到里面的按钮。
    const capsuleBox = await capsule.boundingBox();
    await page.touchscreen.tap(capsuleBox!.x + 16, capsuleBox!.y + 16);
    await expect(page.getByTestId('command-palette-panel')).toBeVisible();
});

test('pausing floats the row up on its own and it folds away 4 seconds later', async ({ page }) => {
    await openPlayerWithSong(page);
    await setPlayerState(page, 'PLAYING');
    await expect(quickActions(page)).toHaveCount(0);

    await setPlayerState(page, 'PAUSED');
    await expect(quickActions(page)).toBeVisible();
    await page.clock.fastForward(4_500);
    await expect(quickActions(page)).toHaveCount(0);
});

/** 用 CDP 发一次真正的单指拖动（按下、几步移动、抬起），胶囊的 touch 监听收得到。 */
const dragOnCapsule = async (page: Page, from: { x: number; y: number }, to: { x: number; y: number }) => {
    const cdp = await page.context().newCDPSession(page);
    const point = (x: number, y: number) => [{ x, y, id: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from.x, from.y) });
    for (let step = 1; step <= 5; step += 1) {
        const x = from.x + ((to.x - from.x) * step) / 5;
        const y = from.y + ((to.y - from.y) * step) / 5;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(x, y) });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
};

test('swiping up on the collapsed capsule expands it, and swiping down folds it again', async ({ page }) => {
    await openPlayerWithSong(page);
    await setPlayerState(page, 'PLAYING');
    const capsule = page.locator('[data-ponder="player-bar"]');
    await expect(quickActions(page)).toHaveCount(0);

    const box = (await capsule.boundingBox())!;
    const x = box.x + box.width / 2;
    await dragOnCapsule(page, { x, y: box.y + box.height / 2 }, { x, y: box.y + box.height / 2 - 60 });
    await expect(quickActions(page)).toBeVisible();
    // 上滑不是点：不切歌、不开命令面板。
    await expect(page.getByTestId('command-palette-panel')).toHaveCount(0);

    const expanded = (await capsule.boundingBox())!;
    await dragOnCapsule(page, { x, y: expanded.y + 20 }, { x, y: expanded.y + 80 });
    await expect(quickActions(page)).toHaveCount(0);
});

test('on the player page a left swipe on the capsule moves to the next song once', async ({ page }) => {
    await openPlayerWithSong(page);
    // 测试里没有真的音源，切过去的歌放不出来会退回；这里只看胶囊认了一次「下一首」，整屏的滑动没有再切一次。
    const swipes: string[] = [];
    page.on('console', message => {
        if (/swipe/i.test(message.text())) swipes.push(message.text());
    });
    const capsule = page.locator('[data-ponder="player-bar"]');
    const box = (await capsule.boundingBox())!;
    // 从胶囊右侧起手往左划，离进度条的圆点远一点（圆点附近留给拖动定位）。
    const y = box.y + box.height / 2;
    await dragOnCapsule(page, { x: box.x + box.width * 0.75, y }, { x: box.x + box.width * 0.75 - 160, y });
    await expect.poll(() => swipes.filter(line => line.includes('capsule swipe: next')).length).toBe(1);
    await page.waitForTimeout(300);
    expect(swipes).toEqual(['[player] capsule swipe: next']);
});
