import express from 'express';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import cors from 'cors';
import axios from 'axios';
import FlixHQ from './flixhq'; // Import from the TypeScript file
import { Redis } from 'ioredis';
import dotenv from 'dotenv';
import cacheUtils from './utils/cache';

// Load environment variables from .env file
dotenv.config();

// -----------------------
// Caching (Redis + memory fallback)
// -----------------------

// Redis client setup
let redis: Redis | null = null;
let redisConnectionAttempts = 0;
const MAX_REDIS_CONNECTION_ATTEMPTS = 3;

if (process.env.REDIS_HOST) {
  try {
    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      connectTimeout: 5000,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => {
        if (times >= MAX_REDIS_CONNECTION_ATTEMPTS) {
          // Stop retrying after max attempts
          return null;
        }
        return Math.min(times * 200, 1000);
      }
    });
    
    redis.on('error', (err) => {
      console.error('Redis connection error:', err.message);
      redisConnectionAttempts++;
      
      if (redisConnectionAttempts >= MAX_REDIS_CONNECTION_ATTEMPTS) {
        console.warn(`Failed to connect to Redis after ${MAX_REDIS_CONNECTION_ATTEMPTS} attempts. Disabling Redis cache.`);
        // Disconnect and set to null to prevent further connection attempts
        if (redis) {
          redis.disconnect();
          redis = null;
        }
      }
    });
    
    redis.on('connect', () => {
      console.log(`Successfully connected to Redis at ${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`);
      // Reset connection attempts on successful connection
      redisConnectionAttempts = 0;
    });
  } catch (err) {
    console.error('Failed to initialize Redis client:', err);
    redis = null;
  }
}
export { redis };

// Very simple in-memory cache structure { value, expiryTimestamp }
const memoryCache = new Map<string, { value: string; expiresAt: number }>();

const CACHE_TTL_SECONDS = 60 * 60 * 12; // 43_200 seconds (12 hours)

// Helper: get value from cache (Redis if connected, else memory)
async function cacheGet<T>(key: string): Promise<T | null> {
  // Try Redis first if available
  if (redis) {
    try {
      return await cacheUtils.get<T>(redis, key);
    } catch (err) {
      // Redis get error, fall back to memory cache
    }
  }

  // Fallback to in-memory cache
  const cached = memoryCache.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    memoryCache.delete(key); // expired
    return null;
  }
  return JSON.parse(cached.value);
}

// Helper: set value in cache (Redis if connected, else memory)
async function cacheSet<T>(key: string, value: T, ttlSeconds: number): Promise<T> {
  // Use Redis if available
  if (redis) {
    try {
      return await cacheUtils.set(redis, key, async () => value, ttlSeconds);
    } catch (err) {
      // Fall back to memory cache on error
      memoryCache.set(key, { 
        value: JSON.stringify(value), 
        expiresAt: Date.now() + ttlSeconds * 1000 
      });
    }
  } else {
    memoryCache.set(key, { 
      value: JSON.stringify(value), 
      expiresAt: Date.now() + ttlSeconds * 1000 
    });
  }
  return value;
}

// Helper: fetch from cache or call fetcher function
async function cacheFetch<T>(key: string, fetcher: () => Promise<T>, ttlSeconds: number = CACHE_TTL_SECONDS): Promise<T> {
  if (redis) {
    try {
      return await cacheUtils.fetch(redis, key, fetcher, ttlSeconds);
    } catch (err) {
      // Fall back to direct fetch on error
      return fetcher();
    }
  }
  
  // Check memory cache
  const cached = await cacheGet<T>(key);
  if (cached !== null) return cached;
  
  // Fetch and cache
  const value = await fetcher();
  await cacheSet(key, value, ttlSeconds);
  return value;
}

const app = express();
const PORT = process.env.PORT || 3000; // Using port 3001 to avoid conflicts

// TMDB API configuration
export const TMDB_API_KEY ='61e2290429798c561450eb56b26de19b';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/';
const POSTER_SIZE = 'w500';
const BACKDROP_SIZE = 'original';

// Middleware
(app as any).use(cors());
(app as any).use(express.json());

// Initialize FlixHQ provider
const flixhq = new FlixHQ();

// Define episode interface for FlixHQ results
interface FlixHQEpisode {
  id: string;
  title: string;
  number?: number;
  season?: number;
  url: string;
}

// Types for TMDB responses
interface TMDBSearchResponse {
  page: number;
  results: any[];
  total_results: number;
  total_pages: number;
}

interface TMDBMovieDetails {
  id: number;
  title: string;
  overview: string;
  poster_path: string;
  backdrop_path: string;
  release_date: string;
}

interface TMDBTVDetails {
  id: number;
  name: string;
  overview: string;
  poster_path: string;
  backdrop_path: string;
  first_air_date: string;
  number_of_seasons: number;
}

interface TMDBEpisodeDetails {
  id: number;
  name: string;
  overview: string;
  still_path: string;
  episode_number: number;
  season_number: number;
  air_date: string;
}

// TMDB API helper functions
async function searchTMDB(query: string, type: string = 'multi'): Promise<TMDBSearchResponse> {
    const cacheKey = `tmdb:search:${type}:${encodeURIComponent(query.toLowerCase())}`;
    
    return cacheFetch<TMDBSearchResponse>(cacheKey, async () => {
        const response = await axios.get(`${TMDB_BASE_URL}/search/${type}`, {
            params: {
                api_key: TMDB_API_KEY,
                query: query,
                include_adult: false
            }
        });
        return response.data;
    });
}

async function getTMDBDetails(id: string, type: string): Promise<TMDBMovieDetails | TMDBTVDetails> {
    const cacheKey = `tmdb:details:${type}:${id}`;
    
    return cacheFetch<TMDBMovieDetails | TMDBTVDetails>(cacheKey, async () => {
        const response = await axios.get(`${TMDB_BASE_URL}/${type}/${id}`, {
            params: {
                api_key: TMDB_API_KEY
            }
        });
        return response.data;
    });
}

// Title matching helper function
function isTitleSimilarEnough(title1: string, title2: string): boolean {
    title1 = title1.toLowerCase().trim();
    title2 = title2.toLowerCase().trim();

    // Check for exact match
    if (title1 === title2) {
        return true;
    }

    // Split titles into words
    const words1 = title1.split(/\s+/).filter(w => w.length > 0);
    const words2 = title2.split(/\s+/).filter(w => w.length > 0);

    // If one title is very short, require a higher overlap or direct substring match
    // Adjusted to be a bit more flexible for short titles
    if (words1.length <= 2 || words2.length <= 2) {
        const isSubstring = title1.includes(title2) || title2.includes(title1);
        if (isSubstring) {
            return true;
        }
    }

    // Calculate word overlap (how many words they have in common)
    const commonWords = words1.filter(word => words2.includes(word));
    // Use Math.min for a stricter ratio - how much of the *shorter* title is in the longer one
    const wordOverlapRatio = commonWords.length / Math.min(words1.length, words2.length);

    // If they share less than 70% of words (can be adjusted), they're probably different
    if (wordOverlapRatio < 0.7) {
        return false;
    }

    return true;
}

// Define FlixHQ search result types
interface FlixHQSearchResult {
    id: string;
    title: string;
    type: string;
    releaseDate?: string;
    seasons?: number;
}

interface FlixHQSearchResponse {
    results: FlixHQSearchResult[];
}

// Helper to find best matching media (movie or TV series)
function findBestFlixHQMatch(searchResults: FlixHQSearchResponse, tmdbDetails: TMDBMovieDetails | TMDBTVDetails, type: string): FlixHQSearchResult | null {
    const isMovie = type === 'MOVIE';
    const tmdbTitle = (isMovie ? (tmdbDetails as TMDBMovieDetails).title : (tmdbDetails as TMDBTVDetails).name).toLowerCase();

    const relevantResults = searchResults.results.filter((m: FlixHQSearchResult) => m.type === type);

    if (relevantResults.length === 0) {
        console.log(`No relevant ${type} results found in FlixHQ search for "${tmdbTitle}".`);
        return null;
    }

    let bestMatch: FlixHQSearchResult | null = null;

    // --- TV Series Specific Matching (Prioritize Seasons) ---
    if (!isMovie) {
        const tmdbNumberOfSeasons = (tmdbDetails as TMDBTVDetails).number_of_seasons;
        if (tmdbNumberOfSeasons !== undefined) {
            // 1. Try to find an exact title match AND season count match
            const foundMatch = relevantResults.find((show: FlixHQSearchResult) => {
                const flixHQSeasons = show.seasons; // Assuming flixhq.js provides this
                return isTitleSimilarEnough(show.title, tmdbTitle) &&
                       flixHQSeasons === tmdbNumberOfSeasons;
            });
            bestMatch = foundMatch || null;

            if (bestMatch) {
                console.log(`Found exact title & season match on FlixHQ: ${bestMatch.title} (ID: ${bestMatch.id}) - Seasons: ${bestMatch.seasons}`);
                return bestMatch;
            }

            // 2. Try to find the closest season count among similar titles
            const matchingTitleShows = relevantResults.filter((show: FlixHQSearchResult) => isTitleSimilarEnough(show.title, tmdbTitle));
            if (matchingTitleShows.length > 0) {
                const reducedMatch = matchingTitleShows.reduce((closest: FlixHQSearchResult, current: FlixHQSearchResult) => {
                    const currentSeasons = current.seasons || 0;
                    const closestSeasons = closest.seasons || 0;
                    const diffCurrent = Math.abs(currentSeasons - tmdbNumberOfSeasons);
                    const diffClosest = Math.abs(closestSeasons - tmdbNumberOfSeasons);

                    if (diffCurrent < diffClosest) {
                        return current;
                    }
                    return closest;
                }, matchingTitleShows[0]);
                bestMatch = reducedMatch || null;
                if (bestMatch) {
                    console.log(`Found closest season match on FlixHQ: ${bestMatch.title} (ID: ${bestMatch.id}) - Seasons: ${bestMatch.seasons}`);
                    return bestMatch;
                }
                return null;
            }
        }
    }

    // --- Movie Specific Matching (Prioritize Year) & TV Series Fallback ---
    // This logic applies for movies, or if TV series couldn't be matched by seasons
    const tmdbYear = (isMovie ? (tmdbDetails as TMDBMovieDetails).release_date : (tmdbDetails as TMDBTVDetails).first_air_date)?.substring(0, 4);
    const tmdbYearNum = parseInt(tmdbYear || '0');

    // 1. Try to find an exact title and year match (for movies, or if TV seasons fail)
    const exactMatch = relevantResults.find((m: FlixHQSearchResult) => {
        const flixYear = m.releaseDate ? m.releaseDate.split('-')[0] : undefined;
        return isTitleSimilarEnough(m.title, tmdbTitle) && flixYear === tmdbYear;
    });
    bestMatch = exactMatch || null;

    if (bestMatch) {
        console.log(`Found exact title & year match on FlixHQ: ${bestMatch.title} (ID: ${bestMatch.id}) - Year: ${bestMatch.releaseDate}`);
        return bestMatch;
    }

    // If this is a movie and we didn't find an exact year match, abort further matching unless TMDB year is unknown
    if (isMovie && tmdbYear && tmdbYear.trim() !== '') {
        console.log(`No exact title & year match found for movie "${tmdbTitle}" (${tmdbYear}). Rejecting non-matching year results.`);
        return null;
    }

    // 2. Try to find the closest year match among similar titles (for movies, or if TV seasons fail)
    const matchingTitleResults = relevantResults.filter((m: FlixHQSearchResult) => isTitleSimilarEnough(m.title, tmdbTitle));

    if (matchingTitleResults.length > 0) {
        if (tmdbYearNum > 0) {
            const yearMatch = matchingTitleResults.reduce((closest: FlixHQSearchResult, current: FlixHQSearchResult) => {
                const currentYear = parseInt(current.releaseDate ? current.releaseDate.split('-')[0] : '0');
                const closestYear = parseInt(closest.releaseDate ? closest.releaseDate.split('-')[0] : '0');
                const diffCurrent = Math.abs(currentYear - tmdbYearNum);
                const diffClosest = Math.abs(closestYear - tmdbYearNum);

                if (diffCurrent < diffClosest) {
                    return current;
                }
                return closest;
            }, matchingTitleResults[0]);
            bestMatch = yearMatch || null;
            if (bestMatch) {
                console.log(`Found closest year match on FlixHQ: ${bestMatch.title} (ID: ${bestMatch.id}) - Year: ${bestMatch.releaseDate}`);
                return bestMatch;
            }
            return null;
        } else {
            // If TMDB year is unknown, just pick the first similar title
            bestMatch = matchingTitleResults[0] || null;
            if (bestMatch) {
                console.log(`Found similar title (no TMDB year) match on FlixHQ: ${bestMatch.title} (ID: ${bestMatch.id}) - Year: ${bestMatch.releaseDate}`);
                return bestMatch;
            }
            return null;
        }
    }

    // 3. Fallback: For TV series only, if no good match by specific criteria, use the first relevant result
    if (!isMovie) {
        bestMatch = relevantResults[0] || null;
        if (bestMatch) {
            const fallbackYear = bestMatch.releaseDate ? bestMatch.releaseDate.split('-')[0] : 'Unknown';
            console.log(`Fallback (TV): Used first relevant result on FlixHQ: ${bestMatch.title} (ID: ${bestMatch.id}) - Year: ${fallbackYear} (Type: ${bestMatch.type})`);
            return bestMatch;
        }
    }

    console.log(`No suitable ${type} results found on FlixHQ after applying strict filters.`);
    return null;
}

// Basic search endpoint for FlixHQ
(app as any).get('/search', async (req: ExpressRequest, res: ExpressResponse) => {
    try {
        const { query, page = 1 } = req.query as { query?: string, page?: string };

        if (!query) {
            return res.status(400).json({ error: 'Query parameter is required' });
        }

        console.log(`Searching FlixHQ for "${query}"`);
        const cacheKey = `flixhq:search:${query}:${page}`;
        const searchResults = await cacheFetch(cacheKey, async () => {
            return flixhq.search(query, parseInt(page as string));
        }, 60 * 60); // Cache for 1 hour
        
        res.json(searchResults);
    } catch (error: any) {
        console.error('Search error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

// Get media info endpoint
(app as any).get('/info/:mediaId', async (req: ExpressRequest, res: ExpressResponse) => {
    try {
        const { mediaId } = req.params;

        console.log(`Fetching media info for ID: ${mediaId}`);
        const cacheKey = `flixhq:info:${mediaId}`;
        const mediaInfo = await cacheFetch(cacheKey, async () => {
            return flixhq.fetchMediaInfo(mediaId);
        }, 60 * 60 * 6); // Cache for 6 hours
        
        res.json(mediaInfo);
    } catch (error: any) {
        console.error('Media info error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

// Get episode sources endpoint
(app as any).get('/sources/:episodeId', async (req: ExpressRequest, res: ExpressResponse) => {
    try {
        const { episodeId } = req.params;
        const { mediaId, server } = req.query as { mediaId?: string, server?: string };

        console.log(`Fetching sources for episode ID: ${episodeId}`);
        
        // Sources are cached for a shorter time as they might change more frequently
        const cacheKey = `flixhq:sources:${episodeId}:${mediaId || ''}:${server || ''}`;
        const sources = await cacheFetch(cacheKey, async () => {
            return flixhq.fetchEpisodeSources(episodeId, mediaId || '', server);
        }, 60 * 30); // Cache for 30 minutes
        
        if (!sources.sources || sources.sources.length === 0) {
            console.log('Warning: No sources found for this episode ID');
        } else {
            console.log(`Found ${sources.sources.length} sources for this episode.`);
        }

        res.json(sources);
    } catch (error: any) {
        console.error('Sources error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

// Movie endpoint: /movie/{tmdbId}/{server?}
(app as any).get('/movie/:tmdbId/:server?', async (req: ExpressRequest, res: ExpressResponse) => {
    try {
        const { tmdbId, server: serverName } = req.params;

        // Get movie details from TMDB API
        const tmdbDetails = await getTMDBDetails(tmdbId, 'movie') as TMDBMovieDetails;

        // Prepare search query for FlixHQ (prefer TMDB title)
        const searchQuery = tmdbDetails.title;
        const searchResults = await flixhq.search(searchQuery);

        let movie = findBestFlixHQMatch(searchResults, tmdbDetails, 'MOVIE');

        if (!movie) {
            return res.status(404).json({
                error: 'Movie not found on FlixHQ after multiple attempts'
            });
        }

        // Fetch movie info from FlixHQ
        const movieInfo = await flixhq.fetchMediaInfo(movie.id);

        // For movies, get the first episode (which is the movie itself)
        if (movieInfo.episodes && movieInfo.episodes.length > 0) {
            const episode = movieInfo.episodes[0];

            // Get all available servers and sources
            const embedLinks = await flixhq.fetchMovieEmbedLinks(episode.id, serverName || null);

            // Normalise result so that "sources" is always an array
            let resultSources: any[];
            if (Array.isArray(embedLinks.sources)) {
                resultSources = embedLinks.sources;
            } else if (embedLinks.url) {
                resultSources = [{
                    server: embedLinks.server || serverName || 'unknown',
                    url: embedLinks.url,
                    isM3U8: embedLinks.isM3U8,
                    quality: embedLinks.quality,
                    subtitles: embedLinks.subtitles || []
                }];
            } else {
                resultSources = [];
            }

            return res.json({
                tmdbId: tmdbId,
                tmdbTitle: tmdbDetails.title,
                tmdbPosterPath: tmdbDetails.poster_path,
                tmdbBackdropPath: tmdbDetails.backdrop_path,
                tmdbPosterUrl: tmdbDetails.poster_path ? `${TMDB_IMAGE_BASE_URL}${POSTER_SIZE}${tmdbDetails.poster_path}` : null,
                tmdbBackdropUrl: tmdbDetails.backdrop_path ? `${TMDB_IMAGE_BASE_URL}${BACKDROP_SIZE}${tmdbDetails.backdrop_path}` : null,
                title: movieInfo.title,
                image: movieInfo.image,
                description: movieInfo.description || tmdbDetails.overview,
                sources: resultSources,
                requestedServer: serverName || 'all'
            });
        } else {
            return res.status(404).json({
                error: 'No sources found for this movie on FlixHQ',
                tmdbDetails: tmdbDetails
            });
        }
    } catch (error: any) {
        console.error('Movie endpoint error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

// TV Series endpoint: /tv/{tmdbId}/{season}/{episode}/{server?}
(app as any).get('/tv/:tmdbId/:season/:episode/:server?', async (req: ExpressRequest, res: ExpressResponse) => {
    try {
        const { tmdbId, season, episode, server: serverName } = req.params;
        const seasonNum = parseInt(season);
        const episodeNum = parseInt(episode);

        // Get TMDB details in parallel
        const [tmdbDetails, episodeDetails] = await Promise.all([
            getTMDBDetails(tmdbId, 'tv') as Promise<TMDBTVDetails>,
            axios.get(
                `${TMDB_BASE_URL}/tv/${tmdbId}/season/${seasonNum}/episode/${episodeNum}`,
                { params: { api_key: TMDB_API_KEY } }
            ).then(res => res.data as TMDBEpisodeDetails).catch(() => null) // Handle cases where episode details might not be found
        ]);

        if (!tmdbDetails) {
            return res.status(404).json({ error: 'TV show not found on TMDB' });
        }

        // Prepare search query for FlixHQ (prefer TMDB name)
        const searchQuery = tmdbDetails.name;
        const searchResults = await flixhq.search(searchQuery);

        let tvShow = findBestFlixHQMatch(searchResults, tmdbDetails, 'TVSERIES');

        if (!tvShow) {
            return res.status(404).json({
                error: 'TV show not found on FlixHQ after multiple attempts'
            });
        }

        // Fetch TV show info from FlixHQ
        const tvInfo = await flixhq.fetchMediaInfo(tvShow.id);

        // Find the requested episode
        const targetEpisode = tvInfo.episodes?.find(
            (ep: any) => ep.season === seasonNum && ep.number === episodeNum
        );

        if (!targetEpisode) {
            // Return a more concise list of available episodes
            const availableSeasons: { [key: number]: number[] } = {};
            tvInfo.episodes?.forEach((ep: FlixHQEpisode) => {
                const season = ep.season || 0;
                const number = ep.number || 0;
                if (!availableSeasons[season]) {
                    availableSeasons[season] = [];
                }
                availableSeasons[season].push(number);
            });

            return res.status(404).json({
                error: `Episode not found on FlixHQ for Season ${seasonNum}, Episode ${episodeNum}`,
                availableSeasons
            });
        }

        // Get all available servers and sources for the episode
        const embedLinks = await flixhq.fetchTvEpisodeEmbedLinks(targetEpisode.id, serverName || null);

        // Normalise result so that "sources" is always an array
        let resultSources: any[];
        if (Array.isArray(embedLinks.sources)) {
            resultSources = embedLinks.sources;
        } else if (embedLinks.url) {
            resultSources = [{
                server: embedLinks.server || serverName || 'unknown',
                url: embedLinks.url,
                isM3U8: embedLinks.isM3U8,
                quality: embedLinks.quality,
                subtitles: embedLinks.subtitles || []
            }];
        } else {
            resultSources = [];
        }

        return res.json({
            tmdbId: tmdbId,
            tmdbTitle: tmdbDetails.name,
            tmdbPosterPath: tmdbDetails.poster_path,
            tmdbBackdropPath: tmdbDetails.backdrop_path,
            tmdbPosterUrl: tmdbDetails.poster_path ? `${TMDB_IMAGE_BASE_URL}${POSTER_SIZE}${tmdbDetails.poster_path}` : null,
            tmdbBackdropUrl: tmdbDetails.backdrop_path ? `${TMDB_IMAGE_BASE_URL}${BACKDROP_SIZE}${tmdbDetails.backdrop_path}` : null,
            episodeName: episodeDetails?.name || targetEpisode.title,
            title: tvInfo.title, // FlixHQ show title
            episode: targetEpisode.title, // FlixHQ episode title
            season: seasonNum,
            number: episodeNum,
            image: tvInfo.image,
            description: episodeDetails?.overview || tmdbDetails.overview,
            sources: resultSources,
            requestedServer: serverName || 'all'
        });
    } catch (error: any) {
        console.error('TV endpoint error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

(app as any).listen(PORT, () => {
    // Minimal server startup message
    console.log(`Starting server on port ${PORT}... 🚀`);
    if (!process.env.REDIS_HOST) {
        console.warn('Redis not found. Cache disabled.');
    }
    
    if (!process.env.TMDB_KEY) {
        console.warn('TMDB API key not found. Using default key.');
    }
});
export default app;
