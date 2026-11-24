import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

// test/component/playerSwipeHint.spec.ts
// 播放页左右滑动切歌：手势真的发 TouchEvent，箭头跟手点亮、提交时滑出，竖直滑动与从按钮上起手都不切歌。
// 探针见 dev/probes/playerSwipeHint.probe.tsx。

test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

const hint = (page: Page) => page.locator('[data-testid="player-swipe-hint"]');
const nextCount = (page: Page) => page.locator('[data-probe-next]');
const prevCount = (page: Page) => page.locator('[data-probe-prev]');

type Point = { x: number; y: number };

const dispatchTouch = (page: Page, type: 'touchstart' | 'touchmove' | 'touchend', point: Point, selector?: string) => page.evaluate(
    ({ eventType, at, targetSelector }) => {
        const target = targetSelector ? document.querySelector(targetSelector) : document.body;
        if (!target) throw new Error(`missing touch target ${targetSelector}`);
        const makeTouch = (x: number, y: number) => new Touch({
            identifier: 1,
            target,
            clientX: x,
            clientY: y,
            pageX: x,
            pageY: y,
            screenX: x,
            screenY: y,
            radiusX: 2,
            radiusY: 2,
            force: 1,
        });
        const touch = makeTouch(at.x, at.y);
        const active = eventType === 'touchend' ? [] : [touch];
        target.dispatchEvent(new TouchEvent(eventType, {
            touches: active,
            targetTouches: active,
            changedTouches: [touch],
            bubbles: true,
            cancelable: true,
            composed: true,
        }));
    },
    { eventType: type, at: point, targetSelector: selector },
);

const start = { x: 300, y: 420 };

test('left swipe switches to the next track and slides the arrow out', async ({ page, mount }) => {
    await mount('playerSwipeHint');
    await dispatchTouch(page, 'touchstart', start);
    await dispatchTouch(page, 'touchmove', { x: 180, y: 430 });
    // 手指还在屏幕上：箭头已经按方向点亮。
    await expect(hint(page)).toHaveAttribute('data-player-swipe-direction', 'next');

    await dispatchTouch(page, 'touchend', { x: 180, y: 430 });
    await expect(nextCount(page)).toHaveText('1');
    await expect(prevCount(page)).toHaveText('0');
    // 提交：箭头顺着方向滑出去，然后在动画结束后收干净。
    await expect(hint(page)).toHaveAttribute('data-player-swipe-commit', 'next');
    await expect(hint(page)).not.toHaveAttribute('data-player-swipe-commit', 'next', { timeout: 2000 });
});

test('right swipe switches to the previous track', async ({ page, mount }) => {
    await mount('playerSwipeHint');
    await dispatchTouch(page, 'touchstart', start);
    await dispatchTouch(page, 'touchmove', { x: 430, y: 410 });
    await expect(hint(page)).toHaveAttribute('data-player-swipe-direction', 'prev');

    await dispatchTouch(page, 'touchend', { x: 430, y: 410 });
    await expect(prevCount(page)).toHaveText('1');
    await expect(nextCount(page)).toHaveText('0');
});

test('a short or vertical drag does not switch', async ({ page, mount }) => {
    await mount('playerSwipeHint');

    await dispatchTouch(page, 'touchstart', start);
    await dispatchTouch(page, 'touchmove', { x: 340, y: 420 });
    await dispatchTouch(page, 'touchend', { x: 340, y: 420 });

    await dispatchTouch(page, 'touchstart', start);
    await dispatchTouch(page, 'touchmove', { x: 310, y: 540 });
    await dispatchTouch(page, 'touchend', { x: 310, y: 540 });

    await expect(nextCount(page)).toHaveText('0');
    await expect(prevCount(page)).toHaveText('0');
    await expect(hint(page)).not.toHaveAttribute('data-player-swipe-direction', 'next');
});

test('a swipe that starts on a button is left to the button', async ({ page, mount }) => {
    await mount('playerSwipeHint');
    const button = '[data-probe-action="button"]';
    await dispatchTouch(page, 'touchstart', { x: 40, y: 36 }, button);
    await dispatchTouch(page, 'touchmove', { x: 220, y: 40 }, button);
    await dispatchTouch(page, 'touchend', { x: 220, y: 40 }, button);

    await expect(nextCount(page)).toHaveText('0');
    await expect(prevCount(page)).toHaveText('0');
});

test('a swipe that starts in an ignore region is left alone', async ({ page, mount }) => {
    await mount('playerSwipeHint');
    const region = '[data-probe-ignore]';
    await dispatchTouch(page, 'touchstart', { x: 100, y: 700 }, region);
    await dispatchTouch(page, 'touchmove', { x: 260, y: 704 }, region);
    await dispatchTouch(page, 'touchend', { x: 260, y: 704 }, region);

    await expect(nextCount(page)).toHaveText('0');
    await expect(prevCount(page)).toHaveText('0');
    await expect(hint(page)).not.toHaveAttribute('data-player-swipe-direction', 'next');
});

test('a rail that stops propagation still gets the swipe (capture phase)', async ({ page, mount }) => {
    await mount('playerSwipeHint');
    const rail = '[data-probe-stopping]';
    await dispatchTouch(page, 'touchstart', { x: 300, y: 700 }, rail);
    await dispatchTouch(page, 'touchmove', { x: 180, y: 704 }, rail);
    await dispatchTouch(page, 'touchend', { x: 180, y: 704 }, rail);

    await expect(nextCount(page)).toHaveText('1');
});

test('steps aside while a sheet is open', async ({ page, mount }) => {
    await mount('playerSwipeHint');
    await page.evaluate(() => {
        const sheet = document.createElement('div');
        sheet.dataset.probeSheet = 'true';
        sheet.setAttribute('data-folia-sheet', 'true');
        document.body.appendChild(sheet);
    });

    await dispatchTouch(page, 'touchstart', start);
    await dispatchTouch(page, 'touchmove', { x: 180, y: 430 });
    await dispatchTouch(page, 'touchend', { x: 180, y: 430 });

    await expect(nextCount(page)).toHaveText('0');
    await page.evaluate(() => document.querySelector('[data-probe-sheet]')?.remove());
});

test('does nothing outside the player view', async ({ page, mount }) => {
    await mount('playerSwipeHint');
    await page.evaluate(async () => {
        const storeModulePath = '/src/stores/useAppViewStore.ts';
        const { useAppViewStore } = await import(storeModulePath);
        useAppViewStore.setState({ view: 'home' });
    });

    await dispatchTouch(page, 'touchstart', start);
    await dispatchTouch(page, 'touchmove', { x: 180, y: 430 });
    await dispatchTouch(page, 'touchend', { x: 180, y: 430 });

    await expect(nextCount(page)).toHaveText('0');
    await expect(prevCount(page)).toHaveText('0');
});

test('steps aside while a blocking window is open', async ({ page, mount }) => {
    await mount('playerSwipeHint');
    await page.evaluate(() => {
        const blocker = document.createElement('div');
        blocker.dataset.probeBlocker = 'true';
        blocker.setAttribute('data-folia-keyboard-window', 'true');
        document.body.appendChild(blocker);
    });

    await dispatchTouch(page, 'touchstart', start);
    await dispatchTouch(page, 'touchmove', { x: 180, y: 430 });
    await dispatchTouch(page, 'touchend', { x: 180, y: 430 });

    await expect(nextCount(page)).toHaveText('0');
    await page.evaluate(() => document.querySelector('[data-probe-blocker]')?.remove());
});

test('a second finger cancels the gesture and clears the lit arrow', async ({ page, mount }) => {
    await mount('playerSwipeHint');
    await page.evaluate(() => {
        const target = document.body;
        const makeTouch = (x: number, y: number, id: number) => new Touch({
            identifier: id,
            target,
            clientX: x,
            clientY: y,
            pageX: x,
            pageY: y,
            screenX: x,
            screenY: y,
            radiusX: 2,
            radiusY: 2,
            force: 1,
        });
        const send = (type: string, touches: Touch[], changed: Touch[]) => target.dispatchEvent(new TouchEvent(type, {
            touches,
            targetTouches: touches,
            changedTouches: changed,
            bubbles: true,
            cancelable: true,
            composed: true,
        }));
        const first = makeTouch(300, 420, 1);
        const second = makeTouch(120, 620, 2);
        send('touchstart', [first], [first]);
        send('touchmove', [makeTouch(180, 430, 1)], [makeTouch(180, 430, 1)]);
        // 第二根手指落下：这一下手势作废，箭头也要收掉。
        send('touchstart', [makeTouch(180, 430, 1), second], [second]);
        send('touchend', [], [makeTouch(180, 430, 1), second]);
    });

    await expect(nextCount(page)).toHaveText('0');
    await expect(prevCount(page)).toHaveText('0');
    await expect(hint(page)).not.toHaveAttribute('data-player-swipe-direction', 'next');
});
