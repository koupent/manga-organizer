"""辞書（タイトルと著者の対応）の経路が話す形。

``/api/library/entries`` の読み書きと、``/api/library/suggest`` の外部サービス
補完で使う。補完の結果を「先頭を既定として示しつつ、候補も全部返す」形に
してあるのは、画面が選び直せるようにするため。

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
