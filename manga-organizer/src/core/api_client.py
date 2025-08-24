"""
API clients for fetching manga metadata from external sources
"""
import requests
import json
import time
import logging
import difflib
from abc import ABC, abstractmethod
from typing import List, Dict, Optional, Tuple
from pathlib import Path

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


class JikanClient(MangaAPIClient):
    """MyAnimeList API client using Jikan v4"""
    
    BASE_URL = "https://api.jikan.moe/v4"
    RATE_LIMIT_DELAY = 0.5  # 2 requests per second max
    
    def __init__(self):
        self.last_request_time = 0
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'MangaOrganizer/1.0'
        })
    
    def _rate_limit(self):
        """Enforce rate limiting"""
        current_time = time.time()
        time_since_last = current_time - self.last_request_time
        if time_since_last < self.RATE_LIMIT_DELAY:
            time.sleep(self.RATE_LIMIT_DELAY - time_since_last)
        self.last_request_time = time.time()
    
    def search_manga(self, title: str) -> List[Dict]:
        """Search for manga on MyAnimeList"""
        self._rate_limit()
        
        try:
            url = f"{self.BASE_URL}/manga"
            params = {
                'q': title,
                'type': 'manga',
                'limit': 10,  # Get more results to find better matches
                'order_by': 'popularity',
                'sort': 'desc'
            }
            
            response = self.session.get(url, params=params, timeout=10)
            response.raise_for_status()
            
            data = response.json()
            results = []
            
            for item in data.get('data', []):
                # Calculate similarity with query
                item_title = item.get('title', '')
                item_title_jp = item.get('title_japanese', '')
                
                # Check similarity with both titles
                similarity = max(
                    calculate_similarity(title, item_title),
                    calculate_similarity(title, item_title_jp) if item_title_jp else 0
                )
                
                # Skip if similarity is too low (threshold: 0.3)
                if similarity < 0.3:
                    continue
                
                # Get author information
                authors = []
                for author in item.get('authors', []):
                    # MyAnimeList typically returns names in romanized format
                    author_name = author.get('name', '')
                    if author_name:
                        authors.append(author_name)
                
                if authors:
                    results.append({
                        'title': item_title,
                        'title_japanese': item_title_jp,
                        'authors': authors,
                        'mal_id': item.get('mal_id'),
                        'source': 'MAL',
                        'similarity': similarity
                    })
            
            # Sort by similarity score
            results.sort(key=lambda x: x.get('similarity', 0), reverse=True)
            
            logger.info(f"Jikan search for '{title}' returned {len(results)} results")
            return results
            
        except requests.exceptions.RequestException as e:
            logger.error(f"Jikan API error: {e}")
            return []
        except Exception as e:
            logger.error(f"Unexpected error in Jikan search: {e}")
            return []
    
    def get_author_name(self, manga_data: Dict) -> Optional[str]:
        """Extract author name, MyAnimeList usually provides Japanese names"""
        authors = manga_data.get('authors', [])
        if authors:
            # Return first author (usually the main author)
            # MyAnimeList names are typically in Japanese format already
            return authors[0]
        return None


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
    """Fetches manga metadata from multiple sources"""
    
    def __init__(self):
        self.jikan_client = JikanClient()
        self.anilist_client = AniListClient()
        self._cache = {}  # Simple in-memory cache
    
    def search(self, title: str) -> List[Dict]:
        """Search for manga across all sources"""
        # Check cache first
        cache_key = title.lower()
        if cache_key in self._cache:
            logger.info(f"Using cached results for '{title}'")
            return self._cache[cache_key]
        
        all_results = []
        
        # Try AniList FIRST (better Japanese names)
        try:
            anilist_results = self.anilist_client.search_manga(title)
            all_results.extend(anilist_results)
        except Exception as e:
            logger.warning(f"AniList search failed: {e}")
        
        # Also try MyAnimeList for more results
        try:
            mal_results = self.jikan_client.search_manga(title)
            all_results.extend(mal_results)
        except Exception as e:
            logger.warning(f"MAL search failed: {e}")
        
        # Deduplicate by title and author combination
        seen = set()
        unique_results = []
        for result in all_results:
            # Create a key from title and first author
            title_key = result.get('title', '').lower()
            authors = result.get('authors', [])
            author_key = authors[0].lower() if authors else ''
            key = f"{title_key}:{author_key}"
            
            if key not in seen:
                seen.add(key)
                unique_results.append(result)
        
        # Cache the results
        self._cache[cache_key] = unique_results
        
        logger.info(f"Total unique results for '{title}': {len(unique_results)}")
        return unique_results
    
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