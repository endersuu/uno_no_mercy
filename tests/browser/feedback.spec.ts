import { test, expect, type Page, type Browser } from "@playwright/test";
async function pair(browser: Browser) {
  const ca = await browser.newContext(),
    cb = await browser.newContext();
  const a = await ca.newPage(),
    b = await cb.newPage();
  await a.goto("/");
  await a.getByRole("button", { name: "创建房间" }).click();
  await expect(a.locator(".waiting")).toBeVisible();
  await b.goto(a.url());
  await b.getByRole("button", { name: "加入房间" }).click();
  await expect(a.locator(".hand .card")).toHaveCount(7);
  await expect(b.locator(".hand .card")).toHaveCount(7);
  return { a, b, ca, cb };
}
async function makePlayable(p: Page) {
  if (!(await p.locator(".hand .card:enabled").count())) {
    await p.locator("#draw").click();
    await expect(p.locator(".action-receipt b")).toContainText("抽了");
    await expect(p.locator("#app")).toHaveAttribute("data-animating", "false");
    await expect(p.locator(".new-card-tag").first()).toBeVisible();
  }
}
async function play(p: Page) {
  await p.locator(".hand .card:enabled").first().click();
  if (await p.locator("#colors").isVisible())
    await p.locator('[data-color="blue"]').click();
}
test("card flight acknowledges accepted play, blocks double clicks, then unlocks; pause interrupts safely", async ({
  browser,
}) => {
  const { a, b, ca, cb } = await pair(browser);
  await makePlayable(a);
  const before = Number(await a.locator("#app").getAttribute("data-revision"));
  const previousTop = await a
    .locator(".discard .card")
    .getAttribute("aria-label");
  await play(a);
  await expect(a.locator("#app")).toHaveAttribute("data-animating", "true");
  await expect(a.locator(".flying-card").first()).toBeVisible();
  await expect(a.locator(".hand .card:enabled")).toHaveCount(0);
  await expect(a.locator(".action-receipt b")).toContainText("打出了");
  await expect(a.locator(".discard .card")).toHaveAttribute(
    "aria-label",
    previousTop!,
  );
  await a.screenshot({ path: "/tmp/uno-card-flight.png", fullPage: true });
  await expect(a.locator("#app")).toHaveAttribute("data-animating", "false");
  await expect(a.locator("#app")).toHaveAttribute(
    "data-revision",
    String(before + 1),
  );
  await expect(a.locator(".flying-card")).toHaveCount(0);
  await expect(b.locator(".action-receipt b")).toContainText("打出了");
  await expect(b.locator("#app")).toHaveAttribute("data-animating", "false");
  // Interrupt another accepted action before its presentation has finished.
  const turnPage = (await a.locator(".table-status").textContent())?.includes(
    "轮到你",
  )
    ? a
    : b;
  if (await turnPage.locator("#roulette:enabled").count()) {
    await turnPage.locator("#roulette").click();
    await turnPage.locator('[data-color="red"]').click();
  } else if (await turnPage.locator(".hand .card:enabled").count())
    await play(turnPage);
  else await turnPage.locator("#draw").click();
  await expect(turnPage.locator("#app")).toHaveAttribute(
    "data-animating",
    "true",
  );
  await a.locator("#pause").click();
  await expect(a.locator("#rules")).toBeVisible();
  await expect(b.locator(".pause-banner")).toBeVisible();
  await expect(a.locator(".flying-card")).toHaveCount(0);
  await a.locator("#rules-done").click();
  await a.locator("#resume").click();
  await expect(a.locator(".pause-banner")).toHaveCount(0);
  await a.reload();
  await expect(a.locator(".hand")).toBeVisible();
  await expect(a.locator(".flying-card")).toHaveCount(0);
  await ca.close();
  await cb.close();
});
test("reduced motion preserves action explanations without flying cards", async ({
  browser,
}) => {
  const { a, b, ca, cb } = await pair(browser);
  await a.emulateMedia({ reducedMotion: "reduce" });
  await makePlayable(a);
  await play(a);
  await expect(a.locator(".action-receipt b")).toContainText("打出了");
  await expect(a.locator(".flying-card")).toHaveCount(0);
  await expect(a.locator("#app")).toHaveAttribute("data-animating", "false");
  await expect(a.locator("#game-announcement")).toContainText("打出了");
  await ca.close();
  await cb.close();
});
