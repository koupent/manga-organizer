import json
import logging
import sqlite3
from pathlib import Path

logger = logging.getLogger(__name__)


class MangaDatabase:
    def __init__(self, db_path: Path | None = None):
        if db_path is None:
            # Store database in application directory for portability
            import sys

            if getattr(sys, "frozen", False):
                # Running as compiled executable
                app_dir = Path(sys.executable).parent
            else:
                # Running as script - use the project root
                app_dir = Path(__file__).parent.parent.parent

            db_dir = app_dir / "data"
            db_dir.mkdir(exist_ok=True)
            db_path = db_dir / "manga_info.db"
            logger.info(f"Database location: {db_path}")

        self.db_path = db_path
        self.conn = None
        self.init_database()

    def init_database(self):
        """Initialize database connection and create tables if they don't exist"""
        try:
            self.conn = sqlite3.connect(str(self.db_path))
            cursor = self.conn.cursor()

            # Create manga info table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS manga_info (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL UNIQUE,
                    author TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Create index for faster searches
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_title 
                ON manga_info (title)
            """)

            self.conn.commit()
            logger.info(f"Database initialized at {self.db_path}")

        except sqlite3.Error as e:
            logger.error(f"Database initialization error: {e}")
            raise

    def save_manga_info(self, title: str, author: str) -> bool:
        """Save or update manga information"""
        try:
            cursor = self.conn.cursor()

            # Try to insert, if exists then update
            cursor.execute(
                """
                INSERT INTO manga_info (title, author)
                VALUES (?, ?)
                ON CONFLICT(title) DO UPDATE SET
                    author = excluded.author,
                    updated_at = CURRENT_TIMESTAMP
            """,
                (title, author),
            )

            self.conn.commit()
            logger.info(f"Saved manga info: {title} by {author}")
            return True

        except sqlite3.Error as e:
            logger.error(f"Error saving manga info: {e}")
            return False

    def add_manga_info(self, title: str, author: str) -> bool:
        """まだ無い作品名だけを足す。既にあれば何もせず False を返す。

        ``save_manga_info`` と違い、既にある著者を**絶対に上書きしない**。
        この表は以降のすべての整理で著者欄を埋める表なので、利用者が手で
        直した著者を書き換えると、直した覚えが黙って消える。

        「無いことを確かめてから書く」を 2 文で書くと、その隙に別の経路が
        同じ作品名を入れられる。1 文にして SQLite 側で決めさせる。
        """
        try:
            cursor = self.conn.cursor()
            cursor.execute(
                """
                INSERT INTO manga_info (title, author)
                VALUES (?, ?)
                ON CONFLICT(title) DO NOTHING
            """,
                (title, author),
            )

            self.conn.commit()
            return cursor.rowcount > 0

        except sqlite3.Error as e:
            logger.error(f"Error adding manga info: {e}")
            return False

    def get_author_by_title(self, title: str) -> str | None:
        """Get author name by manga title"""
        try:
            cursor = self.conn.cursor()
            cursor.execute(
                """
                SELECT author FROM manga_info
                WHERE title = ?
            """,
                (title,),
            )

            result = cursor.fetchone()
            return result[0] if result else None

        except sqlite3.Error as e:
            logger.error(f"Error getting author: {e}")
            return None

    def search_titles(self, query: str, limit: int = 10) -> list[tuple[str, str]]:
        """Search for manga titles matching the query"""
        try:
            cursor = self.conn.cursor()
            cursor.execute(
                """
                SELECT title, author FROM manga_info
                WHERE title LIKE ?
                ORDER BY 
                    CASE WHEN title = ? THEN 0 ELSE 1 END,
                    title
                LIMIT ?
            """,
                (f"%{query}%", query, limit),
            )

            return cursor.fetchall()

        except sqlite3.Error as e:
            logger.error(f"Error searching titles: {e}")
            return []

    def get_all_titles(self) -> list[str]:
        """Get all manga titles from database"""
        try:
            cursor = self.conn.cursor()
            cursor.execute("""
                SELECT DISTINCT title FROM manga_info
                ORDER BY title
            """)

            return [row[0] for row in cursor.fetchall()]

        except sqlite3.Error as e:
            logger.error(f"Error getting all titles: {e}")
            return []

    def get_recent_manga(self, limit: int = 10) -> list[tuple[str, str]]:
        """Get recently added/updated manga"""
        try:
            cursor = self.conn.cursor()
            cursor.execute(
                """
                SELECT title, author FROM manga_info
                ORDER BY updated_at DESC, title ASC
                LIMIT ?
            """,
                (limit,),
            )

            return cursor.fetchall()

        except sqlite3.Error as e:
            logger.error(f"Error getting recent manga: {e}")
            return []

    def get_all_manga(self) -> list[tuple[str, str, str, str]]:
        """Get all manga with full details"""
        try:
            cursor = self.conn.cursor()
            cursor.execute("""
                SELECT title, author, created_at, updated_at 
                FROM manga_info
                ORDER BY title ASC
            """)

            return cursor.fetchall()

        except sqlite3.Error as e:
            logger.error(f"Error getting all manga: {e}")
            return []

    def update_manga_info(
        self, old_title: str, new_title: str, new_author: str
    ) -> bool:
        """Update existing manga information"""
        try:
            cursor = self.conn.cursor()

            # Check if new title already exists (if title is being changed)
            if old_title != new_title:
                cursor.execute(
                    "SELECT COUNT(*) FROM manga_info WHERE title = ?", (new_title,)
                )
                if cursor.fetchone()[0] > 0:
                    logger.error(f"Title '{new_title}' already exists in database")
                    return False

            # Update the entry
            cursor.execute(
                """
                UPDATE manga_info 
                SET title = ?, author = ?, updated_at = CURRENT_TIMESTAMP
                WHERE title = ?
            """,
                (new_title, new_author, old_title),
            )

            self.conn.commit()

            if cursor.rowcount > 0:
                logger.info(
                    f"Updated manga: '{old_title}' -> '{new_title}' by {new_author}"
                )
                return True
            else:
                logger.warning(f"No manga found with title: {old_title}")
                return False

        except sqlite3.Error as e:
            logger.error(f"Error updating manga info: {e}")
            return False

    def delete_manga(self, title: str) -> bool:
        """Delete manga entry from database"""
        try:
            cursor = self.conn.cursor()
            cursor.execute(
                """
                DELETE FROM manga_info
                WHERE title = ?
            """,
                (title,),
            )

            self.conn.commit()
            return cursor.rowcount > 0

        except sqlite3.Error as e:
            logger.error(f"Error deleting manga: {e}")
            return False

    def export_to_json(self, output_path: Path) -> bool:
        """Export database to JSON file"""
        try:
            cursor = self.conn.cursor()
            cursor.execute("""
                SELECT title, author, created_at, updated_at 
                FROM manga_info
                ORDER BY title
            """)

            data = []
            for row in cursor.fetchall():
                data.append(
                    {
                        "title": row[0],
                        "author": row[1],
                        "created_at": row[2],
                        "updated_at": row[3],
                    }
                )

            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)

            logger.info(f"Exported database to {output_path}")
            return True

        except (OSError, sqlite3.Error) as e:
            logger.error(f"Error exporting database: {e}")
            return False

    def import_from_json(self, input_path: Path) -> bool:
        """Import data from JSON file"""
        try:
            with open(input_path, encoding="utf-8") as f:
                data = json.load(f)

            cursor = self.conn.cursor()
            for item in data:
                cursor.execute(
                    """
                    INSERT INTO manga_info (title, author)
                    VALUES (?, ?)
                    ON CONFLICT(title) DO UPDATE SET
                        author = excluded.author,
                        updated_at = CURRENT_TIMESTAMP
                """,
                    (item["title"], item["author"]),
                )

            self.conn.commit()
            logger.info(f"Imported {len(data)} entries from {input_path}")
            return True

        except (OSError, json.JSONDecodeError, sqlite3.Error) as e:
            logger.error(f"Error importing data: {e}")
            return False

    def close(self):
        """Close database connection"""
        if self.conn:
            self.conn.close()
            self.conn = None

    def __del__(self):
        """Destructor to ensure database connection is closed"""
        self.close()
