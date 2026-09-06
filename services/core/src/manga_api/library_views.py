"""辞書（タイトルと著者の対応）の経路が話す形。

``/api/library/entries`` の読み書き、``/api/library/import`` のまとめた
取り込み、``/api/library/suggest`` の外部サービス補完で使う。補完の結果を
「先頭を既定として示しつつ、候補も全部返す」形にしてあるのは、画面が選び直せる
ようにするため。

記録そのものは ``manga_core.manga_database``、外部への問い合わせは
``manga_core.api_client``。ここにあるのは境界で受け渡す形だけ。
"""

from pydantic import BaseModel, Field, field_validator

# 作品名として妥当な長さ。これを超えるものは打ち間違いか攻撃とみなす
MAX_TITLE_LENGTH = 200


class LibraryEntry(BaseModel):
    """タイトルと著者の対応"""

    title: str
    author: str


class LibraryEntries(BaseModel):
    """辞書の中身"""

    entries: list[LibraryEntry]


class SuggestRequest(BaseModel):
    """外部サービスへの問い合わせ依頼"""

    title: str = Field(
        description="調べたい作品名。空白のみは受け付けない",
        max_length=MAX_TITLE_LENGTH,
    )

    @field_validator("title")
    @classmethod
    def _reject_blank_title(cls, value: str) -> str:
        """中身の無い作品名を境界で断る。

        空文字はどの作品にも当たってしまい、外部サービスへの問い合わせも
        無駄になる。前後の空白を落としたうえで空なら受け付けない。
        """
        stripped = value.strip()
        if not stripped:
            raise ValueError("作品名を入力してください")
        return stripped


class AuthorCandidate(BaseModel):
    """検索で見つかった作品と、その著者"""

    title: str
    author: str
    source: str
    similarity: float


class Suggestion(BaseModel):
    """補完の結果。近い順に候補を並べ、先頭を既定として示す"""

    title: str | None = None
    author: str | None = None
    candidates: list[AuthorCandidate] = Field(default_factory=list)


class LibraryImportRequest(BaseModel):
    """整理済みの蔵書から拾った対を、まとめて辞書へ入れる依頼"""

    entries: list[LibraryEntry]


class LibraryConflict(BaseModel):
    """辞書へ入れられなかった作品名と、その食い違いの中身。

    ``kept_author`` は辞書に残したままの著者。辞書にまだ無い作品名で、
    蔵書の側の著者が割れていた場合は null になる。``incoming_authors`` は
    蔵書から来た著者で、割れていれば複数入る。両方を返すのは、利用者が
    「辞書は A、蔵書は B」と読めるようにするため。黙って捨てると
    「押したのに変わらない」だけになり、どちらが正しいのか確かめられない。
    """

    title: str
    kept_author: str | None = None
    incoming_authors: list[str]


class LibraryImportResult(BaseModel):
    """取り込みの結果。入れた対・既に在った対・断った作品名"""

    # 3 つとも必ず返す。空でも省かないのは、受け取る画面が「無い」と
    # 「まだ来ていない」を取り違えないようにするため
    imported: list[LibraryEntry]
    unchanged: list[LibraryEntry]
    conflicts: list[LibraryConflict]
