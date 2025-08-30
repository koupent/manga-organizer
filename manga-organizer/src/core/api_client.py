"""
API clients for fetching manga metadata from external sources
"""
import requests
import time
import logging
import difflib
from abc import ABC, abstractmethod
from typing import List, Dict, Optional, Tuple

logger = logging.getLogger(__name__)


def calculate_similarity(query: str, candidate: str) -> float:
    """Calculate similarity between two strings (0.0 to 1.0)"""
    # Normalize strings for comparison
    query_lower = query.lower().strip()
    candidate_lower = candidate.lower().strip()
    
    # Check exact match first
    if query_lower == candidate_lower:
        return 1.0
    
    # Check if query is contained in candidate or vice versa
    if query_lower in candidate_lower or candidate_lower in query_lower:
        return 0.9
    
    # Use SequenceMatcher for fuzzy matching
    return difflib.SequenceMatcher(None, query_lower, candidate_lower).ratio()


class MangaAPIClient(ABC):
    """Abstract base class for manga API clients"""
    
    @abstractmethod
    def search_manga(self, title: str) -> List[Dict]:
        """Search for manga by title"""
        pass
    
    @abstractmethod
    def get_author_name(self, manga_data: Dict) -> Optional[str]:
        """Extract author name from manga data, preferring Japanese"""
        pass


# MyAnimeList client removed - using only AniList for better Japanese name support

class AniListClient(MangaAPIClient):
    """AniList API client using GraphQL"""
    
    BASE_URL = "https://graphql.anilist.co"
    RATE_LIMIT_DELAY = 0.5  # Conservative rate limiting
    
    def __init__(self):
        self.last_request_time = 0
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'MangaOrganizer/1.0',
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        })
    
    def _rate_limit(self):
        """Enforce rate limiting"""
        current_time = time.time()
        time_since_last = current_time - self.last_request_time
        if time_since_last < self.RATE_LIMIT_DELAY:
            time.sleep(self.RATE_LIMIT_DELAY - time_since_last)
        self.last_request_time = time.time()
    
    def search_manga(self, title: str) -> List[Dict]:
        """Search for manga on AniList"""
        self._rate_limit()
        
        query = '''
        query ($search: String) {
            Page(page: 1, perPage: 5) {
                media(search: $search, type: MANGA, sort: POPULARITY_DESC) {
                    id
                    title {
                        romaji
                        english
                        native
                    }
                    staff {
                        edges {
                            role
                            node {
                                name {
                                    full
                                    native
                                }
                            }
                        }
                    }
                }
            }
        }
        '''
        
        variables = {'search': title}
        
        try:
            response = self.session.post(
                self.BASE_URL,
                json={'query': query, 'variables': variables},
                timeout=10
            )
            response.raise_for_status()
            
            data = response.json()
            results = []
            
            for item in data.get('data', {}).get('Page', {}).get('media', []):
                title_data = item.get('title', {})
                item_title = title_data.get('romaji') or title_data.get('english', '')
                item_title_jp = title_data.get('native', '')
                
                # Calculate similarity with query
                similarity = max(
                    calculate_similarity(title, item_title),
                    calculate_similarity(title, item_title_jp) if item_title_jp else 0
                )
                
                # Skip if similarity is too low (threshold: 0.3)
                if similarity < 0.3:
                    continue
                
                # Extract author information from staff
                authors = []
                for edge in item.get('staff', {}).get('edges', []):
                    role = edge.get('role', '').lower()
                    # Look for story/original creator roles
                    if any(r in role for r in ['story', 'original', 'creator', 'author', '原作']):
                        node = edge.get('node', {})
                        name_data = node.get('name', {})
                        
                        # STRONGLY prefer native (Japanese) name
                        author_name = name_data.get('native')
                        if not author_name:
                            # Fallback to full name if no native name
                            author_name = name_data.get('full', '')
                        
                        if author_name and author_name not in authors:
                            authors.append(author_name)
                
                if authors:
                    results.append({
                        'title': item_title,
                        'title_japanese': item_title_jp,
                        'authors': authors,
                        'anilist_id': item.get('id'),
                        'source': 'AniList',
                        'similarity': similarity
                    })
            
            # Sort by similarity score
            results.sort(key=lambda x: x.get('similarity', 0), reverse=True)
            
            logger.info(f"AniList search for '{title}' returned {len(results)} results")
            return results
            
        except requests.exceptions.RequestException as e:
            logger.error(f"AniList API error: {e}")
            return []
        except Exception as e:
            logger.error(f"Unexpected error in AniList search: {e}")
            return []
    
    def get_author_name(self, manga_data: Dict) -> Optional[str]:
        """Extract author name, preferring Japanese (native) name"""
        authors = manga_data.get('authors', [])
        if authors:
            # Return first author (usually the main author)
            return authors[0]
        return None


class MangaMetadataFetcher:
    """Fetches manga metadata using AniList API for accurate Japanese author names"""
    
    def __init__(self):
        # AniList provides the best Japanese author names
        self.anilist_client = AniListClient()
        self._cache = {}  # Simple in-memory cache with 30 second TTL
        self._cache_timestamps = {}  # Track cache timestamps
        self.cache_ttl = 30  # 30 seconds TTL
    
    def search(self, title: str) -> List[Dict]:
        """Search for manga using AniList API for accurate Japanese names"""
        # Check cache first with TTL
        cache_key = title.lower()
        current_time = time.time()
        
        if cache_key in self._cache:
            timestamp = self._cache_timestamps.get(cache_key, 0)
            if current_time - timestamp < self.cache_ttl:
                logger.info(f"Using cached results for '{title}'")
                return self._cache[cache_key]
        
        # Search AniList for manga
        try:
            results = self.anilist_client.search_manga(title)
            
            # Cache the results with timestamp
            self._cache[cache_key] = results
            self._cache_timestamps[cache_key] = current_time
            
            logger.info(f"Found {len(results)} results for '{title}' from AniList")
            return results
            
        except Exception as e:
            logger.error(f"AniList search failed: {e}")
            return []
    
    def get_author_suggestion(self, title: str) -> Optional[Tuple[str, str]]:
        """Get the best author suggestion for a title
        Returns: (author_name, source) or None
        """
        results = self.search(title)
        
        if results:
            # Return the first result (most popular)
            first_result = results[0]
            authors = first_result.get('authors', [])
            if authors:
                source = first_result.get('source', 'Unknown')
                return (authors[0], source)
        
        return None