# RAR のテスト素材

この環境（Dev Container / Windows ホストとも）には RAR を**作れる**道具が無い。
`rarfile` は目次を読めるが書き込みはできず、`py7zr` は 7z しか作れない。それでも
「本物の RAR で目次が読めること」「本物の RAR で読めない場合があること」は
実際の RAR で確かめないと意味が無いため、ごく小さいものだけをここへ置く。

出所は [rarfile](https://github.com/markokr/rarfile) の sdist（`test/files/`）で、
どちらも本物の RAR ツールが作った書庫。rarfile は ISC ライセンス
（Copyright (c) 2005-2024 Marko Kreen）で、再配布に必要な表示はこの節をもって行う。

| ファイル | 大きさ | 何であるか | テストでの役割 |
|---|---|---|---|
| `rar5-subdirs.rar` | 542 B | RAR5。`sub/dir1/file1.txt` などの下位フォルダと Unicode 名を含む | 手で組み立てた RAR3 だけでなく、**本物の RAR5 の目次も読めること**の錨 |
| `rar3-comment-plain.rar` | 300 B | RAR3。書庫コメント付き | コメントの復号だけは外部ツールが要るため、**目次を読めない**側の実例 |

`rar3-comment-plain.rar` を手で組み立てないのは、`rarfile.rar3_decompress` が
無圧縮（method 0x30）のコメントだけは外部ツール無しで返してしまうため。
自作のコメント付き RAR は「読めてしまう」ので、実例の代わりにならない。

分割ボリュームの片割れ（`rar3-vols.part2.rar`）は同じ sdist にあるが 100 KB ある。
`NeedFirstVolume` はヘッダのフラグだけで決まり、手で組み立てたものでも同じ例外に
なることを確認済みなので、こちらは置かずにテスト内で組み立てる。

テスト側の入口は `services/core/tests/test_toc_rar_7z.py`。
