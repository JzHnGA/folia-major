import { expect, test, type Page } from '@playwright/test';
import { mockNeteaseApi } from './helpers/appFixtures';
import { APP_VERSION, GUIDE_VERSION_STORAGE_KEY, waitForAppMounted } from '../helpers/appState';

// test/ui/mobileTutorialTour.spec.ts
// iOS 新手教程（带示范动画的完整版）：首启在首页自动打开，按顺序走完 15 步，每步的标题都换了、该有示范动画的有，
// 最后一步「开始使用」关掉并记下看过，重新打开应用不再弹。每一步截一张图放进测试输出，方便人工看排版。

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

const STEPS: Array<{ id: string; demo?: string }> = [
    { id: 'welcome', demo: 'welcome' },
    { id: 'tabs' },
    { id: 'search', demo: 'search' },
    { id: 'wallPlay', demo: 'wallPlay' },
    { id: 'barTap', demo: 'barTap' },
    { id: 'barSwipe', demo: 'barSwipe' },
    { id: 'barExpand', demo: 'barExpand' },
    { id: 'scratchpad' },
    { id: 'tools' },
    { id: 'account' },
    { id: 'sync' },
    { id: 'faceId' },
    { id: 'nightstand' },
    { id: 'widgets', demo: 'widgets' },
    { id: 'finish', demo: 'finish' },
];

const openFreshApp = async (page: Page) => {
    await page.addInitScript(([version, guideKey]) => {
        if (sessionStorage.getItem('tour-test-seeded')) return;
        sessionStorage.setItem('tour-test-seeded', '1');
        localStorage.clear();
        localStorage.setItem('library_suite_prompt_seen', 'true');
        localStorage.setItem('library_suite', 'bravais');
        localStorage.setItem('folia_app_language', 'en');
        localStorage.setItem('static_mode', 'true');
        localStorage.setItem(guideKey, version);
    }, [APP_VERSION, GUIDE_VERSION_STORAGE_KEY] as const);
    await mockNeteaseApi(page, 'guest');
    await page.goto('/?nightstand=1');
    await waitForAppMounted(page);
};

test('the first-launch tour walks through every step with its demo, then stays closed', async ({ page }) => {
    await openFreshApp(page);
    const tour = page.getByTestId('mobile-tutorial');
    await expect(tour).toBeVisible({ timeout: 20_000 });

    const titles = new Set<string>();
    for (const [index, step] of STEPS.entries()) {
        await expect(tour).toHaveAttribute('data-mobile-tutorial-step', step.id);
        await expect(tour.getByText(`Step ${index + 1} of ${STEPS.length}`)).toBeVisible();
        if (step.demo) await expect(page.getByTestId(`mobile-tutorial-demo-${step.demo}`)).toBeVisible();
        const title = await tour.locator('#mobile-tutorial-title').innerText();
        expect(titles.has(title), `step ${step.id} repeats a title`).toBe(false);
        titles.add(title);
        await page.waitForTimeout(1200);
        await page.screenshot({ path: test.info().outputPath(`${String(index + 1).padStart(2, '0')}-${step.id}.png`) });
        const isLast = index === STEPS.length - 1;
        await tour.getByRole('button', { name: isLast ? 'Start listening' : 'Next' }).click();
    }

    await expect(tour).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('folia_mobile_tutorial_v2'))).toBe('seen');
    await page.reload();
    await waitForAppMounted(page);
    await page.waitForTimeout(2500);
    await expect(tour).toHaveCount(0);
});
