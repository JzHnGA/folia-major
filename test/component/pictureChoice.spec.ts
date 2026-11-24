import { expect, test } from './fixtures';

// test/component/pictureChoice.spec.ts
// 设置页「播放后进入的视图」三张图片卡片：在窄的设置栏里不能把第三张挤到下一行，
// 否则第二行只孤零零一张卡片（用户截图里的布局问题）。见 dev/probes/pictureChoice.probe.tsx。

test('three picture choices stay on one row in a narrow settings column', async ({ mount }) => {
    const component = await mount('pictureChoice');
    const choices = component.locator('[data-probe-picture-choice] [role="group"] button');
    await expect(choices).toHaveCount(3);

    const boxes = await choices.evaluateAll(nodes => nodes.map(node => {
        const box = node.getBoundingClientRect();
        return { top: Math.round(box.top), left: box.left, right: box.right };
    }));
    expect(new Set(boxes.map(box => box.top)).size).toBe(1);

    const column = await component.locator('[data-probe-picture-choice]').boundingBox();
    expect(column).not.toBeNull();
    for (const box of boxes) {
        expect(box.left).toBeGreaterThanOrEqual(column!.x);
        expect(box.right).toBeLessThanOrEqual(column!.x + column!.width + 1);
    }
});
