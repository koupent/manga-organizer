import { expect, test } from "@playwright/test";
import {
  defaultCrop,
  restoredEdit,
  rotatedSize,
  type CropRect,
  type ImageSize,
  type Operation,
} from "../src/components/CropFrame";

/**
 * 前回の加工から枠を復元する計算そのものを検証する（#66 画面側）。
 *
 * 記録（manifest）は ZIP の中にあり、本を配る側が自由に書ける。加工の並びを
 * そのまま信じて枠に写すと、画像の外に出た枠や 1px の枠が「前回の範囲」として
 * 出る。利用者から見れば枠が消えたようにしか見えず、そのまま確定すれば
 * 見当違いの範囲で本文が上書きされる。
 *
 * ブラウザを開かない検証だが、この app に用意されている実行系は Playwright
 * だけなので e2e/ に置く。中で page を使わないので、ブラウザは起動しない。
 * 別の実行系（vitest など）を足すなら、そちらへ移してよい。
 */

/** 検証に使う元画像。2:3 ではないので、既定の枠には必ず余りができる */
const ORIGINAL: ImageSize = { width: 1000, height: 800 };

/** 画素の丸め方までは問わない。枠として同じ位置・同じ大きさかを見る */
const TOLERANCE = 0.5;

/**
 * 画面が実際に置く枠と向き。
 *
 * CoverEditor は復元できなければ既定の枠（見えている向きでの 2:3 中央）に
 * 落とす。復元側が null を返すか既定を返すかは作りの問題で、利用者に見えるのは
 * この結果だけなので、そちらで確かめる。
 */
function shownEdit(operations: Operation[], original: ImageSize) {
  const restored = restoredEdit(operations, original);
  const angle = restored?.angle ?? 0;
  return {
    crop: restored?.crop ?? defaultCrop(rotatedSize(original, angle)),
    angle,
  };
}

function expectFrame(actual: CropRect, expected: CropRect, message: string) {
  const shown = (crop: CropRect) =>
    `x=${Math.round(crop.x)} y=${Math.round(crop.y)} ` +
    `${Math.round(crop.width)}×${Math.round(crop.height)}`;
  expect(
    Math.max(
      Math.abs(actual.x - expected.x),
      Math.abs(actual.y - expected.y),
      Math.abs(actual.width - expected.width),
      Math.abs(actual.height - expected.height),
    ),
    `${message}（枠は ${shown(actual)}、期待は ${shown(expected)}）`,
  ).toBeLessThan(TOLERANCE);
}

test.describe("前回の枠の復元: 壊れた記録を枠にしない", () => {
  /**
   * 受け付けてはいけない記録。どれも JSON としては読めるので、
   * 形だけ見て素通しすると枠まで届く。
   */
  const damaged: { label: string; box: unknown; consequence: string }[] = [
    {
      label: "負の座標",
      box: [-100, 0, 500, 750],
      consequence: "枠が画像の左外へ出て、掴めない部分ができる",
    },
    {
      label: "元画像より大きい範囲",
      box: [0, 0, 4000, 6000],
      consequence: "枠が画像を突き抜け、選んだ範囲が画像の外を指す",
    },
    {
      label: "数でない値",
      // Number(null) は 0、Number("") も 0 になる。素通しすると
      // 「左上から 400×600」という、記録には無い範囲が生まれる
      box: [null, "", "400", "600"],
      consequence: "記録に無い範囲が前回の範囲として出る",
    },
    {
      label: "真偽値",
      // Number(false)=0、Number(true)=1。順序の検査は通ってしまう
      box: [false, false, true, true],
      consequence: "1px の枠になり、画面上は枠が消えたようにしか見えない",
    },
  ];

  for (const { label, box, consequence } of damaged) {
    test(`${label}の記録は既定の枠に戻す`, () => {
      // Act
      const shown = shownEdit([{ kind: "crop", params: { box } }], ORIGINAL);

      // Assert - 触っていない状態と同じ枠から始める
      expect(shown.angle).toBe(0);
      expectFrame(shown.crop, defaultCrop(ORIGINAL), consequence);
    });
  }

  test("まっとうな記録は、その範囲を枠にする", () => {
    // Arrange - 元画像の中に収まり、既定の枠とは重ならない範囲。
    // これが復元できないなら、上の 4 つが「常に既定へ倒す」で通ってしまう
    const box = [100, 150, 500, 750];

    // Act
    const shown = shownEdit([{ kind: "crop", params: { box } }], ORIGINAL);

    // Assert
    expect(shown.angle).toBe(0);
    expectFrame(
      shown.crop,
      { x: 100, y: 150, width: 400, height: 600 },
      "前回の範囲を復元できていない",
    );
  });
});

test.describe("前回の枠の復元: 範囲を選ばない記録", () => {
  test("加工が 1 つも無ければ、既定の枠にする", () => {
    // Arrange - 記録はあるが、範囲を選ぶ加工は 1 つも無い
    // 制御: 元画像そのものは 2:3 ではない。全面を枠にすると必ず崩れる
    expect(ORIGINAL.width / ORIGINAL.height).not.toBeCloseTo(2 / 3, 3);

    // Act
    const shown = shownEdit([], ORIGINAL);

    // Assert - 触っていないときと同じ枠。1000×800 は見開きなので、全面
    // ではなく中央の 2:3 から始める（片側を選んで表紙にする絵）
    expect(shown.angle).toBe(0);
    expectFrame(
      shown.crop,
      defaultCrop(ORIGINAL),
      "元画像の全面を前回の範囲として出している",
    );
  });

  test("回転だけの記録は、向きを保ったまま既定の枠にする", () => {
    // Arrange - 回した後の絵。枠はこの座標で持つ
    const shownSize = rotatedSize(ORIGINAL, 90);

    // Act
    const shown = shownEdit(
      [{ kind: "rotate", params: { degrees: 90 } }],
      ORIGINAL,
    );

    // Assert - 回転は前回のまま残る。落とすと、開き直しただけで
    // 前回の向きが失われる
    expect(shown.angle, "前回の回転が失われている").toBe(90);

    // Assert - 枠は回した絵に対する既定の枠。回した後は縦長（800×1000）に
    // なるので、見開きの中央の 2:3 ではなく画像の全体になる（#146）
    expectFrame(
      shown.crop,
      defaultCrop(shownSize),
      "回した絵の全面を前回の範囲として出している",
    );
  });
});
