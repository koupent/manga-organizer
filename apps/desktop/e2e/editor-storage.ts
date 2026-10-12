/** 操作テストは案内を既読にする。案内自体は editor-guide.spec.ts で未読から検証する。 */
export const editorStorage = {
  cookies: [],
  origins: [
    "http://127.0.0.1:4173",
    "http://localhost:4173",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
  ].map((origin) => ({
    origin,
    localStorage: [{ name: "manga-organizer:editor.hideGuide", value: "true" }],
  })),
};
