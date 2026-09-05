import js from "@eslint/js";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * 画面コードの検査。整形は見ず、機械的に見つかる欠陥だけを見る。
 *
 * eslint-plugin-react-hooks は 7 系で React Compiler の規則一式を同梱するが、
 * ここでは依存配列と呼び出し位置の 2 つだけを有効にする。残りは既存コードへの
 * 影響が読み切れず、この検査を入れる目的（過去に実際に出た欠陥を機械的に
 * 止める）から外れるため入れない。
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "test-results/**",
      "playwright-report/**",
      "src-tauri/**",
      // openapi-typescript の生成物。手で直さないので検査しない
      "src/api/schema.ts",
    ],
  },
  {
    files: ["src/**/*.{ts,tsx}", "e2e/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [jsxA11y.flatConfigs.recommended],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",

      // 入力部品は ui/ の薄い包みを通して置く。素の input を探すだけでは
      // 中身に届かず、対応済みの label まで未対応として挙がる
      "jsx-a11y/label-has-associated-control": [
        "error",
        { controlComponents: ["Input", "Checkbox"] },
      ],

      // 以下 4 つは既存の画面に未対応が残っており、直すには操作そのものを
      // 変えることになる。挙動を変えない範囲に留めるため warn に落とす。
      //
      // - PageGrid のカード: dnd-kit が role="button" と tabIndex を付ける
      //   ので焦点は当たるが、選択の切っ掛けが click しかない。error へ
      //   戻すには Enter / Space での選択を足す
      // - PageGrid の原寸表示と SplitCard の拡大部: 背面を押して閉じる /
      //   拡大する当たり判定。前者は Esc、後者は隣の拡大ボタンで代えが
      //   利く。error へ戻すには当たり判定自体を操作要素として名乗らせる
      // - PlanList の行: Delete で外すために li を焦点対象にしている。
      //   error へ戻すには一覧の役割を listbox / option などへ組み直す
      "jsx-a11y/click-events-have-key-events": "warn",
      "jsx-a11y/no-static-element-interactions": "warn",
      "jsx-a11y/no-noninteractive-element-interactions": "warn",
      "jsx-a11y/no-noninteractive-tabindex": "warn",
    },
  },
  {
    // E2E は Playwright（Node）から、評価する式はブラウザの中で動く
    files: ["e2e/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
);
