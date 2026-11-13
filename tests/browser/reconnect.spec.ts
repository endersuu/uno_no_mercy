import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

function observeJoins(page: Page) {
  const observed = { attempts: 0, occupied: 0 };
  function packet(payload: string, incoming: boolean) {
    for (const frame of payload.split("\x1e")) {
      if (!(incoming ? /^43\d+\[/ : /^42\d+\[/).test(frame)) continue;
      const data = JSON.parse(frame.slice(frame.indexOf("[")));
      if (incoming) {
        if (data[0]?.error === "这个席位已在另一个页面连接。")
          observed.occupied++;
      } else if (data[0] === "command" && data[1]?.type === "join") {
        observed.attempts++;
      }
    }
  }
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => packet(String(payload), false));
    socket.on("framereceived", ({ payload }) => packet(String(payload), true));
  });
  page.on("request", (request) => {
    if (request.url().includes("/socket.io/") && request.method() === "POST")
      packet(request.postData() ?? "", false);
  });
  page.on("response", async (response) => {
    if (
      response.url().includes("/socket.io/") &&
      response.request().method() === "GET"
    ) {
      try {
        packet(await response.text(), true);
      } catch {
        // Closing a context can abort an outstanding polling response.
      }
    }
  });
  return observed;
}

async function pair(browser: Browser) {
  const ca = await browser.newContext(),
    cb = await browser.newContext();
  const a = await ca.newPage(),
    b = await cb.newPage();
  await a.goto("/");
  await a.locator("#name").fill("Alice");
  await a.getByRole("button", { name: "创建房间" }).click();
  await expect(a).toHaveURL(/room=/);
  await b.goto(a.url());
  await b.locator("#name").fill("Bob");
  await b.getByRole("button", { name: "加入房间" }).click();
  for (const page of [a, b]) {
    await expect(page.locator(".hand .card")).toHaveCount(7);
    await expect(page.locator("#app")).toHaveAttribute(
      "data-animating",
      "false",
    );
  }
  const room = new URL(a.url()).searchParams.get("room")!;
  const token = await a.evaluate(
    (id) => sessionStorage.getItem(`uno-token-${id}`),
    room,
  );
  expect(token).toBeTruthy();
  return { ca, cb, a, b, room, token: token!, url: a.url() };
}

async function seedSeat(context: BrowserContext, room: string, token: string) {
  await context.addInitScript(
    ({ room, token }) => {
      sessionStorage.setItem(`uno-token-${room}`, token);
      sessionStorage.setItem("uno-name", "Alice");
    },
    { room, token },
  );
}

test("a saved seat waits for its old connection, then restores the same hand automatically", async ({
  browser,
}) => {
  const { ca, cb, a, b, room, token, url } = await pair(browser);
  const replacement = await browser.newContext();
  try {
    const cards = await a
      .locator(".hand [data-card]")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-card")),
      );
    await seedSeat(replacement, room, token);
    await replacement.addInitScript(() => {
      Reflect.set(window, "__resumeOpeningSeen", false);
      new MutationObserver(() => {
        if (document.querySelector('.game[data-opening="true"], .opening-card'))
          Reflect.set(window, "__resumeOpeningSeen", true);
      }).observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
      });
    });
    const restored = await replacement.newPage();
    const joins = observeJoins(restored);
    await restored.goto(url);
    await expect.poll(() => joins.occupied).toBeGreaterThan(0);
    await expect(restored.locator("#reconnect-status")).toBeVisible();
    // A duplicate page must not steal the live player's seat.
    await expect(a.locator(".hand .card")).toHaveCount(7);
    await expect(b.locator(".pause-banner")).toHaveCount(0);
    await expect(restored.locator(".hand")).toHaveCount(0);

    await ca.close();
    await expect(restored.locator(".hand .card")).toHaveCount(7, {
      timeout: 10_000,
    });
    expect(
      await restored
        .locator(".hand [data-card]")
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("data-card")),
        ),
    ).toEqual(cards);
    expect(joins.attempts).toBeGreaterThan(1);
    await expect(restored.locator(".game")).toHaveAttribute(
      "data-opening",
      "false",
    );
    await expect(restored.locator(".flying-card")).toHaveCount(0);
    expect(
      await restored.evaluate(() => Reflect.get(window, "__resumeOpeningSeen")),
    ).toBe(false);
    await expect(b.locator(".pause-banner")).toHaveCount(0);
    await expect(restored.locator("#reconnect-status")).toHaveCount(0);
  } finally {
    await Promise.all([ca.close(), cb.close(), replacement.close()]);
  }
});

test("a missing room is a terminal resume error and does not keep retrying", async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const room = "missing-reconnect-room";
    await seedSeat(context, room, "saved-test-seat");
    const page = await context.newPage();
    const joins = observeJoins(page);
    await page.goto(`/?room=${room}`);
    await expect(page.locator("#toast")).toContainText("房间不存在");
    await expect(page.locator("#reconnect-status")).toHaveCount(0);
    await expect(page.locator("#entry button")).toBeEnabled();
    // Observe multiple retry intervals to distinguish a stopped retry from a delay.
    await page.waitForTimeout(3500);
    expect(joins.attempts).toBe(1);
  } finally {
    await context.close();
  }
});

test("choosing a new room cancels a pending seat recovery", async ({
  browser,
}) => {
  const { ca, cb, room, token, url } = await pair(browser);
  const replacement = await browser.newContext();
  try {
    await seedSeat(replacement, room, token);
    const page = await replacement.newPage();
    const joins = observeJoins(page);
    await page.goto(url);
    await expect.poll(() => joins.occupied).toBeGreaterThan(0);
    await expect(page.locator("#reconnect-status")).toBeVisible();
    await page.locator("#new-room").click();
    await expect(page).not.toHaveURL(/room=/);
    const attempts = joins.attempts;
    await ca.close();
    await page.waitForTimeout(3500);
    expect(joins.attempts).toBe(attempts);
    await expect(page.locator("#reconnect-status")).toHaveCount(0);
    await expect(page.locator(".hand")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "创建房间" })).toBeEnabled();
  } finally {
    await Promise.all([ca.close(), cb.close(), replacement.close()]);
  }
});

test("seat recovery stops after its deadline without taking over a live player", async ({
  browser,
}) => {
  const { ca, cb, a, b, room, token, url } = await pair(browser);
  const replacement = await browser.newContext();
  try {
    await seedSeat(replacement, room, token);
    const page = await replacement.newPage();
    await page.clock.install({ time: new Date() });
    const joins = observeJoins(page);
    await page.goto(url);
    await expect.poll(() => joins.occupied).toBeGreaterThan(0);
    await expect(page.locator("#reconnect-status")).toBeVisible();
    // Advance wall time without firing Socket.IO's heartbeat timers early.
    await page.clock.setSystemTime(new Date(Date.now() + 56_000));
    await expect(page.locator("#reconnect-status")).toHaveCount(0);
    await expect(page.locator("#toast")).toContainText("未能恢复席位");
    await expect(page.locator("#entry button")).toBeEnabled();
    const attempts = joins.attempts;
    await page.waitForTimeout(2500);
    expect(joins.attempts).toBe(attempts);
    await expect(a.locator(".hand .card")).toHaveCount(7);
    await expect(b.locator(".pause-banner")).toHaveCount(0);
  } finally {
    await Promise.all([ca.close(), cb.close(), replacement.close()]);
  }
});
