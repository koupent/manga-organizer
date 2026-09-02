"""作品名から著者を引く経路の検証。

外部サービス（AniList）へ実際には出ず、応答の形だけを再現する。ここが
壊れていると画面では「著者が出ない」としか見えないので、応答の解釈まで
踏み込んで確かめる。
"""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from manga_core.api_client import (  # noqa: E402
    AniListClient,
    MangaMetadataFetcher,
    calculate_similarity,
)


def media(
    romaji: str,
    native: str,
    staff: list[tuple[str, str, str]],
    media_id: int = 1,
) -> dict:
    """AniList が返す 1 作品ぶんの形を組み立てる"""
    return {
        "id": media_id,
        "title": {"romaji": romaji, "english": romaji, "native": native},
        "staff": {
            "edges": [
                {
                    "role": role,
                    "node": {"name": {"full": full, "native": native_name}},
                }
                for role, full, native_name in staff
            ]
        },
    }


class FakeResponse:
    def __init__(self, payload: dict):
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return self._payload


def responding_with(*items: dict):
    """GraphQL の応答を返す post の代わり"""

    def post(self, url, json=None, timeout=None):  # noqa: A002 - requests に合わせる
        return FakeResponse({"data": {"Page": {"media": list(items)}}})

    return post


class SimilarityTest(unittest.TestCase):
    def test_exact_match_scores_highest(self):
        self.assertEqual(1.0, calculate_similarity("ワンピース", "ワンピース"))

    def test_contained_title_scores_high(self):
        # Arrange / Act
        score = calculate_similarity("ワンピース", "ワンピース 第1部")

        # Assert - 部分一致は近いものとして扱う
        self.assertGreaterEqual(score, 0.9)

    def test_unrelated_title_scores_low(self):
        self.assertLess(calculate_similarity("ワンピース", "宇宙兄弟"), 0.3)

    def test_empty_query_scores_zero(self):
        # Arrange / Act - 空文字はどんな文字列にも含まれてしまう
        score = calculate_similarity("", "何でもよい作品")

        # Assert - 問い合わせが空なら似ているとは言えない
        self.assertEqual(0.0, score)

    def test_blank_query_scores_zero(self):
        # Arrange / Act - 空白だけの入力も中身は無い
        score = calculate_similarity("   ", "何でもよい作品")

        # Assert
        self.assertEqual(0.0, score)


class AniListSearchTest(unittest.TestCase):
    def search(self, *items: dict, query: str = "ワンピース") -> list[dict]:
        with mock.patch("requests.Session.post", new=responding_with(*items)):
            return AniListClient().search_manga(query)

    def test_extracts_the_japanese_author_name(self):
        # Arrange - 著者は native 名を優先する
        item = media(
            "One Piece",
            "ワンピース",
            [("Story & Art", "Eiichiro Oda", "尾田栄一郎")],
        )

        # Act
        results = self.search(item)

        # Assert
        self.assertEqual(["尾田栄一郎"], results[0]["authors"])
        self.assertEqual("AniList", results[0]["source"])

    def test_falls_back_to_the_romanised_name(self):
        # Arrange - native 名が無いこともある
        item = media("Some Manga", "", [("Story", "Jane Doe", "")])

        # Act
        results = self.search(item, query="Some Manga")

        # Assert
        self.assertEqual(["Jane Doe"], results[0]["authors"])

    def test_ignores_staff_who_are_not_the_author(self):
        # Arrange
        item = media(
            "One Piece",
            "ワンピース",
            [
                ("Assistant", "Someone Else", "誰か"),
                ("Story & Art", "Eiichiro Oda", "尾田栄一郎"),
            ],
        )

        # Act
        results = self.search(item)

        # Assert
        self.assertEqual(["尾田栄一郎"], results[0]["authors"])

    def test_orders_results_by_closeness_to_the_query(self):
        # Arrange - 人気順に届くが、近さで並べ直す
        far = media(
            "One Peace Party",
            "ワンピース パーティー",
            [("Story", "Far Author", "遠い著者")],
            media_id=2,
        )
        near = media(
            "One Piece",
            "ワンピース",
            [("Story", "Eiichiro Oda", "尾田栄一郎")],
            media_id=3,
        )

        # Act
        results = self.search(far, near)

        # Assert
        self.assertEqual("尾田栄一郎", results[0]["authors"][0])

    def test_drops_results_that_are_not_close_enough(self):
        # Arrange
        far = media(
            "Totally Different",
            "宇宙兄弟",
            [("Story", "Far Author", "遠い著者")],
        )

        # Act
        results = self.search(far)

        # Assert - 似ていないものは候補にしない
        self.assertEqual([], results)

    def test_returns_nothing_when_the_request_fails(self):
        # Arrange
        def failing_post(self, url, json=None, timeout=None):  # noqa: A002
            raise RuntimeError("圏外")

        # Act
        with mock.patch("requests.Session.post", new=failing_post):
            results = AniListClient().search_manga("ワンピース")

        # Assert
        self.assertEqual([], results)


class AuthorCandidateTest(unittest.TestCase):
    def candidates(self, *items: dict, query: str = "ワンピース") -> list[dict]:
        with mock.patch("requests.Session.post", new=responding_with(*items)):
            return MangaMetadataFetcher().get_author_candidates(query)

    def test_flattens_every_author_into_candidates(self):
        # Arrange - 原作と作画で 2 人載ることがある
        item = media(
            "One Piece",
            "ワンピース",
            [
                ("Story", "Eiichiro Oda", "尾田栄一郎"),
                ("Original Creator", "Another Person", "別の人"),
            ],
        )

        # Act
        found = self.candidates(item)

        # Assert
        self.assertEqual(["尾田栄一郎", "別の人"], [entry["author"] for entry in found])
        self.assertEqual("ワンピース", found[0]["title"])

    def test_does_not_repeat_the_same_author(self):
        # Arrange - 別々の作品に同じ著者が出る
        first = media(
            "One Piece", "ワンピース", [("Story", "Oda", "尾田栄一郎")], media_id=1
        )
        second = media(
            "One Piece Party",
            "ワンピース パーティー",
            [("Story", "Oda", "尾田栄一郎")],
            media_id=2,
        )

        # Act
        found = self.candidates(first, second)

        # Assert
        self.assertEqual(["尾田栄一郎"], [entry["author"] for entry in found])

    def test_returns_nothing_when_no_author_is_found(self):
        self.assertEqual([], self.candidates())

    def test_drops_only_the_broken_candidates(self):
        # Arrange - 外部サービスの応答は値が欠けることがある
        found = [
            {
                "title": "One Piece",
                "title_japanese": "ワンピース",
                "authors": ["尾田栄一郎"],
                "source": "AniList",
                "similarity": 1.0,
            },
            {
                "title": "Broken Score",
                "title_japanese": "類似度が壊れた作品",
                "authors": ["類似度が壊れた著者"],
                "source": "AniList",
                "similarity": None,
            },
            {
                "title": None,
                "title_japanese": None,
                "authors": ["題名が欠けた著者"],
                "source": "AniList",
                "similarity": 0.8,
            },
        ]

        # Act
        with mock.patch.object(AniListClient, "search_manga", return_value=found):
            candidates = MangaMetadataFetcher().get_author_candidates("ワンピース")

        # Assert - 1 件壊れていても全体を落とさず、正常な候補だけ残す
        self.assertEqual(["尾田栄一郎"], [entry["author"] for entry in candidates])
        self.assertEqual("ワンピース", candidates[0]["title"])
        self.assertEqual(1.0, candidates[0]["similarity"])

    def test_survives_a_non_numeric_similarity(self):
        # Arrange - 数値にならない文字列が混じることもある
        found = [
            {
                "title": "One Piece",
                "title_japanese": "ワンピース",
                "authors": ["尾田栄一郎"],
                "source": "AniList",
                "similarity": "とても近い",
            }
        ]

        # Act
        with mock.patch.object(AniListClient, "search_manga", return_value=found):
            candidates = MangaMetadataFetcher().get_author_candidates("ワンピース")

        # Assert - 例外にせず、その候補だけ捨てる
        self.assertEqual([], candidates)


class CacheTest(unittest.TestCase):
    def test_does_not_ask_twice_for_the_same_title(self):
        # Arrange
        item = media("One Piece", "ワンピース", [("Story", "Oda", "尾田栄一郎")])
        calls = []

        def counting_post(self, url, json=None, timeout=None):  # noqa: A002
            calls.append(json)
            return FakeResponse({"data": {"Page": {"media": [item]}}})

        fetcher = MangaMetadataFetcher()

        # Act
        with mock.patch("requests.Session.post", new=counting_post):
            fetcher.get_author_candidates("ワンピース")
            fetcher.get_author_candidates("ワンピース")

        # Assert - 打つたびに問い合わせない
        self.assertEqual(1, len(calls))
        self.assertIn("ワンピース", json.dumps(calls[0], ensure_ascii=False))


if __name__ == "__main__":
    unittest.main()
