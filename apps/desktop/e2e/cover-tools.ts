import { expect, type Page } from "@playwright/test";

export async function openCoverTools(page: Page, name?: string) {
  if (await page.getByRole("dialog").count())
    await page.keyboard.press("Escape");
  const cards = page.getByTestId("editable-page");
  await expect(cards.first()).toBeVisible({ timeout: 30_000 });
  const card = name
    ? cards.filter({ has: page.getByRole("group", { name, exact: true }) })
    : cards.first();
  await card.getByRole("button", { name: /の操作/ }).click();
  await card.getByRole("menuitem", { name: "サムネイルの画像調整" }).click();
}

export async function saveCoverTools(page: Page) {
  await page.getByTestId("apply-thumbnail").click();
  await page.getByTestId("split-confirm").click();
  await expect(page.getByTestId("split-status")).toHaveAttribute(
    "data-state",
    "done",
  );
  await expect(page.getByTestId("split-confirm")).toBeDisabled();
  await openCoverTools(page);
  await expect(page.getByTestId("crop-frame")).toBeVisible();
}
