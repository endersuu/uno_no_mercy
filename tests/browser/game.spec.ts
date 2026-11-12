import { test, expect, type Page } from "@playwright/test";
test("two humans: invite, privacy, rules pause, reconnect, complete round, rematch, leave", async ({
  browser,
}) => {
  // A full random round includes a readable animation beat for every move.
  test.setTimeout(240_000);
  const aContext = await browser.newContext(),
    bContext = await browser.newContext();
  const a = await aContext.newPage(),
    b = await bContext.newPage();
  const errors: string[] = [];
  for (const p of [a, b]) p.on("pageerror", (e) => errors.push(e.message));
  await a.goto("/");
  await a.getByRole("button", { name: "游戏规则" }).click();
  await expect(a.locator("#rules")).toBeVisible();
  await a.locator("#rules-done").click();
  await a.locator("#name").fill("Alice");
  await a.getByRole("button", { name: "创建房间" }).click();
  await expect(a.locator(".waiting")).toBeVisible();
  const url = a.url();
  await a.screenshot({ path: "/tmp/uno-waiting.png", fullPage: true });
  await b.goto(url);
  await b.locator("#name").fill("Bob");
  await b.getByRole("button", { name: "加入房间" }).click();
  await expect(a.locator(".hand .card")).toHaveCount(7);
  await expect(b.locator(".hand .card")).toHaveCount(7);
  await expect(a.locator(".opponent")).toContainText("Bob");
  await expect(a.locator(".game")).not.toContainText("undefined");
  await a.screenshot({ path: "/tmp/uno-table.png", fullPage: true });
  const third = await browser.newPage();
  await third.goto(url);
  await third.getByRole("button", { name: "加入房间" }).click();
  await expect(third.locator("#toast")).toContainText("不能加入");
  await third.close();
  await a.locator("#pause").click();
  await expect(a.locator("#rules")).toBeVisible();
  await expect(b.locator(".pause-banner")).toContainText("对手正在查看规则");
  await expect(b.locator(".hand .card:enabled")).toHaveCount(0);
  await a.locator("#rules-done").click();
  await a.locator("#resume").click();
  await expect(b.locator(".pause-banner")).toHaveCount(0);
  const ids = await b
    .locator("[data-card]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-card")));
  await b.reload();
  await expect(b.locator(".hand .card")).toHaveCount(7);
  expect(
    await b
      .locator("[data-card]")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-card"))),
  ).toEqual(ids);
  await expect(a.locator(".pause-banner")).toHaveCount(0);
  async function move(p: Page) {
    await expect(p.locator("#app")).toHaveAttribute("data-animating", "false");
    const before = await p.locator("#app").getAttribute("data-revision");
    if (await p.locator("#roulette:enabled").count()) {
      await p.locator("#roulette").click();
      await p.locator('[data-color="red"]').click();
    } else if (await p.locator(".hand .card:enabled").count()) {
      // Prefer high penalties to reach a natural finish without hundreds of low-number turns.
      const candidates = p.locator(".hand .card:enabled");
      const labels = await candidates.evaluateAll((els) =>
        els.map((el) => el.getAttribute("aria-label") ?? ""),
      );
      const score = (label: string) =>
        label.includes("+10")
          ? 100
          : label.includes("+6")
            ? 60
            : label.includes("+4") || label.includes("抽四")
              ? 40
              : label.includes("抽二")
                ? 20
                : label.includes("全弃")
                  ? 15
                  : 0;
      const best = labels.reduce(
        (best, label, i) => (score(label) > score(labels[best]) ? i : best),
        0,
      );
      await candidates.nth(best).click();
      if (await p.locator("#colors").isVisible())
        await p.locator('[data-color="blue"]').click();
    } else if (await p.locator("#draw:enabled").count())
      await p.locator("#draw").click();
    else return false;
    await expect(p.locator("#app")).not.toHaveAttribute(
      "data-revision",
      before!,
    );
    await expect(p.locator("#app")).toHaveAttribute("data-animating", "false");
    return true;
  }
  for (let i = 0; i < 400; i++) {
    if (await a.locator(".result").count()) break;
    if (!(await move(a))) await move(b);
  }
  await expect(a.locator(".result")).toBeVisible();
  await expect(b.locator(".result")).toBeVisible();
  await a.locator("#rematch").click();
  await expect(a.locator("#rematch")).toHaveText("已准备，等待对手…");
  await b.locator("#rematch").click();
  await expect(a.locator(".result")).toHaveCount(0);
  await expect(a.locator(".hand .card")).toHaveCount(7);
  await b.locator("#leave-room").click();
  await b.locator("#confirm-leave").click();
  await expect(a.locator(".result")).toContainText("对手离开了房间");
  await a.locator("#back-home").click();
  await expect(a.locator(".landing")).toBeVisible();
  const absent = await browser.newPage();
  await absent.goto(url);
  await absent.getByRole("button", { name: "加入房间" }).click();
  await expect(absent.locator("#toast")).toContainText("已销毁");
  await absent.close();
  expect(errors).toEqual([]);
  await aContext.close();
  await bContext.close();
});
test("mobile landing, room and rules have no horizontal overflow", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const p = await context.newPage();
  await p.goto("/");
  await expect(p.getByRole("button", { name: "创建房间" })).toBeEnabled();
  expect(
    await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await p.screenshot({ path: "/tmp/uno-mobile.png", fullPage: true });
  await p.getByRole("button", { name: "游戏规则" }).click();
  await expect(p.locator("#rules")).toBeVisible();
  await p.locator("#rules-done").click();
  await p.getByRole("button", { name: "创建房间" }).click();
  await expect(p.locator(".waiting")).toBeVisible();
  expect(
    await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await context.close();
});
