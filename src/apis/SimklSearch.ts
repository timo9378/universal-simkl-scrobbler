import { CorrectionApi } from '@apis/CorrectionApi';
import { SimklApi } from '@apis/SimklApi';
import { CacheItems } from '@common/Cache';
import { RequestError } from '@common/RequestError';
import { Shared } from '@common/Shared';
import { Utils } from '@common/Utils';
import { EpisodeItem, Item, ScrobbleItem } from '@models/Item';
import {
	createSimklScrobbleItem,
	SimklEpisodeItem,
	SimklMovieItem,
	SimklScrobbleItem,
	SimklShowItemValues,
} from '@models/SimklItem';

/**
 * Matching a service's playback against a Simkl database entry.
 *
 * This is where the fork diverges most from upstream, because Simkl offers two
 * things Trakt did not:
 *
 * - **`GET /search/id`** resolves an item directly from an external id, including
 *   `netflix`, `hulu` and `crunchyroll`. When a service hands us its own numeric id
 *   we try that first; a fuzzy title search is only the fallback.
 * - **`GET /tv/episodes/{showId}`** returns every episode of a show in one response,
 *   with season, episode number, title and air date. Upstream needed a chain of
 *   requests to approximate this — per-episode lookup, then a seasons request to
 *   convert absolute anime numbering, then a TMDB search by episode title. All of
 *   that is now local work over a single response, so `findEpisode()` costs one
 *   request instead of up to four and no longer depends on TMDB for episode
 *   resolution.
 *
 * The heuristics upstream learned the hard way are kept, just applied to the full
 * episode list instead of to extra network round-trips: the absolute-numbering
 * conversion, and the rule that a low episode number in a season beyond Simkl's
 * known maximum means Simkl is simply behind, not that the numbering is absolute.
 *
 * Field-name traps worth knowing: text search returns `ids.simkl_id` while id search
 * and the item endpoints return `ids.simkl`, and `ids.tmdb` comes back as a *string*.
 * `simklIdOf()`/`tmdbIdOf()` exist to absorb that.
 */

export type SimklSearchItem = SimklSearchShowItem | SimklSearchMovieItem;

export type SimklSearchEpisodeItem = SimklSearchEpisodeItemEpisode & SimklSearchShowItem;

export interface SimklSearchEpisodeItemEpisode {
	episode: SimklEpisodeItemEpisode;
}

export interface SimklEpisodeItemEpisode {
	season: number;
	number: number;
	title: string;
	ids: {
		simkl: number;
		tmdb: number;
	};
	/** Format: yyyy-MM-ddTHH:mm:ss.SSSZ */
	first_aired: string | null;
	/** Ready-to-use simkl.in URL, or `undefined` when Simkl has no still. */
	image_url?: string;
}

export interface SimklSearchShowItem {
	show: SimklSearchShowItemShow;
}

export interface SimklSearchShowItemShow {
	title: string;
	year: number;
	ids: {
		simkl: number;
		tmdb: number;
	};
}

export interface SimklSearchMovieItem {
	movie: SimklSearchMovieItemMovie;
}

export interface SimklSearchMovieItemMovie {
	title: string;
	year: number;
	ids: {
		simkl: number;
		tmdb: number;
	};
	/** Format: yyyy-MM-dd */
	released: string;
	/** Ready-to-use simkl.in URL, or `undefined` when Simkl has no poster. */
	image_url?: string;
}

export type ExactItemDetails =
	| {
			type: 'episode' | 'movie';
			/** Simkl id — of the **show** when `type` is `episode`. */
			id: number;
			season?: number;
			number?: number;
	  }
	| {
			url: string;
	  };

/** Raw entry from `/search/*` and the `/movies/{id}` `/tv/{id}` endpoints. */
interface SimklRawItem {
	title?: string;
	year?: number;
	type?: string;
	released?: string;
	first_aired?: string;
	/** Path fragment for simkl.in, e.g. `97/978264e8bbc2303`. */
	poster?: string;
	ids?: {
		simkl?: number;
		simkl_id?: number;
		slug?: string;
		tmdb?: string | number;
	};
}

/** Raw entry from `/tv/episodes/{showId}`. */
interface SimklRawEpisode {
	title?: string;
	season?: number;
	episode?: number;
	/** `episode` for regular entries, `special` for specials. */
	type?: string;
	date?: string;
	/** Path fragment for simkl.in, e.g. `33/33681465b4843c3fd`. */
	img?: string;
	ids?: {
		simkl_id?: number;
	};
}

/**
 * Service ids Simkl's `/search/id` understands, keyed by this extension's service id.
 * Only keys verified against the live API are listed; anything else falls through to
 * the title search.
 */
const SERVICE_ID_KEYS: Record<string, string> = {
	netflix: 'netflix',
	crunchyroll: 'crunchyroll',
};

/**
 * Simkl serves its own artwork from simkl.in; `poster` and `img` are path fragments
 * like `97/978264e8bbc2303`, not URLs. Using them means no TMDB key and no extra
 * request — upstream's image service (`uts.rafaelgomes.xyz`) now 404s, so TMDB is
 * only a fallback for items Simkl has no artwork for.
 *
 * The two live under different paths and want different suffixes, and both mistakes
 * fail quietly rather than loudly: an episode fragment under `/posters/` 404s, and
 * `/episodes/..._m.webp` returns 200 with a ~576-byte blank instead of the still.
 * Posters take `_m`, episode stills take `_w`.
 */
const posterUrl = (path?: string | null): string | undefined =>
	path ? `https://simkl.in/posters/${path}_m.webp` : undefined;

const stillUrl = (path?: string | null): string | undefined =>
	path ? `https://simkl.in/episodes/${path}_w.webp` : undefined;

const simklIdOf = (raw: SimklRawItem): number => raw.ids?.simkl ?? raw.ids?.simkl_id ?? 0;

const tmdbIdOf = (raw: SimklRawItem): number => {
	const tmdb = raw.ids?.tmdb;
	return typeof tmdb === 'string' ? Number.parseInt(tmdb, 10) || 0 : (tmdb ?? 0);
};

/** Strips articles and punctuation so titles from different sources compare equal. */
const normalizeTitle = (title: string): string =>
	title
		.toLowerCase()
		.replace(/(?<begin>^|\s)(?:a|an|the)(?<end>\s)/g, '$<begin>$<end>')
		.replace(/[^\w]/g, '');

class _SimklSearch extends SimklApi {
	/**
	 * Full episode lists keyed by Simkl show id, for the lifetime of the page. A list
	 * can be 80+ entries, so this is deliberately not persisted alongside the much
	 * smaller item caches; the `itemsToSimklItems` mapping already short-circuits
	 * repeat lookups of the same episode across sessions.
	 */
	private episodeLists = new Map<number, SimklRawEpisode[]>();

	constructor() {
		super();
	}

	async find(
		item: ScrobbleItem,
		caches: CacheItems<['itemsToSimklItems', 'simklItems', 'urlsToSimklItems']>,
		exactItemDetails?: ExactItemDetails,
		cancelKey = 'default'
	): Promise<SimklScrobbleItem | null> {
		let simklItem: SimklScrobbleItem | null = null;
		const databaseId = item.getDatabaseId();
		// Both correction paths — a stored suggestion and a pasted URL — go through the
		// same indirection, because neither key is the Simkl item's own database id.
		// (Upstream could use a suggestion's id directly, since a Trakt suggestion *was*
		// the episode id; a Simkl episode suggestion names the show plus numbers.)
		const lookupKey = exactItemDetails
			? 'id' in exactItemDetails
				? CorrectionApi.getSuggestionDatabaseId(exactItemDetails)
				: exactItemDetails.url
			: null;
		let simklDatabaseId = lookupKey
			? caches.urlsToSimklItems.get(lookupKey)
			: caches.itemsToSimklItems.get(databaseId);
		const cacheItem = simklDatabaseId ? caches.simklItems.get(simklDatabaseId) : null;
		if (cacheItem && cacheItem.type !== 'show') {
			simklItem = createSimklScrobbleItem(cacheItem);
			return simklItem;
		}
		try {
			let searchItem: SimklSearchEpisodeItem | SimklSearchMovieItem;
			if (exactItemDetails) {
				searchItem = await this.findExactItem(exactItemDetails, caches, cancelKey);
			} else if (item.type === 'episode') {
				searchItem = await this.findEpisode(item, caches, cancelKey);
			} else {
				searchItem = (await this.findItem(item, cancelKey)) as SimklSearchMovieItem;
			}
			if ('episode' in searchItem) {
				const { episode, show } = searchItem;
				const firstAired = episode.first_aired;
				const releaseDate = firstAired ? Utils.unix(firstAired) : undefined;
				simklItem = new SimklEpisodeItem({
					id: episode.ids.simkl,
					tmdbId: episode.ids.tmdb,
					title: episode.title,
					year: show.year,
					season: episode.season,
					number: episode.number,
					releaseDate,
					imageUrl: episode.image_url,
					show: {
						id: show.ids.simkl,
						tmdbId: show.ids.tmdb,
						title: show.title,
						year: show.year,
					},
				});
			} else {
				const { movie } = searchItem;
				const released = movie.released;
				const releaseDate = released ? Utils.unix(released) : undefined;
				simklItem = new SimklMovieItem({
					id: movie.ids.simkl,
					tmdbId: movie.ids.tmdb,
					title: movie.title,
					year: movie.year,
					releaseDate,
					imageUrl: movie.image_url,
				});
			}
			if (Shared.pageType === 'content') {
				await Shared.events.dispatch('SEARCH_SUCCESS', null, { searchItem });
			}
		} catch (err) {
			if (Shared.pageType === 'content' && Shared.errors.validate(err)) {
				await Shared.events.dispatch('SEARCH_ERROR', null, { error: err });
			}
			throw err;
		}
		if (simklItem) {
			simklDatabaseId = simklItem.getDatabaseId();
			caches.itemsToSimklItems.set(databaseId, simklDatabaseId);
			caches.simklItems.set(simklDatabaseId, {
				...simklItem.save(),
				watchedAt: undefined,
			});
			if (lookupKey) {
				caches.urlsToSimklItems.set(lookupKey, simklDatabaseId);
			}
		}
		return simklItem;
	}

	/**
	 * Resolves a user-supplied correction — either a suggestion (already a Simkl id) or
	 * a simkl.com URL. `CorrectionDialog` normalizes URLs to `/movies/{id}` or
	 * `/tv/{id}/season-{n}/episode-{n}` before they get here.
	 */
	async findExactItem(
		details: ExactItemDetails,
		caches: CacheItems<['simklItems', 'urlsToSimklItems']>,
		cancelKey = 'default'
	): Promise<SimklSearchEpisodeItem | SimklSearchMovieItem> {
		let showId: number;
		let season: number;
		let number: number;

		if ('id' in details) {
			if (details.type === 'movie') {
				return { movie: await this.fetchMovie(details.id, cancelKey) };
			}
			if (!details.season || !details.number) {
				// Corrections stored before episode suggestions carried season/number can't be
				// resolved — Simkl has no lookup that takes a bare episode id.
				throw new RequestError({
					status: 404,
					text: 'This episode correction is missing the season and episode numbers; please set it again.',
				});
			}
			showId = details.id;
			season = details.season;
			number = details.number;
		} else {
			const movieMatch = /\/movies\/(?<id>\d+)/.exec(details.url);
			if (movieMatch?.groups) {
				return {
					movie: await this.fetchMovie(Number.parseInt(movieMatch.groups.id, 10), cancelKey),
				};
			}

			const episodeMatch =
				/\/(?:tv|anime)\/(?<show>\d+).*?\/season-(?<season>\d+)\/episode-(?<episode>\d+)/.exec(
					details.url
				);
			if (!episodeMatch?.groups) {
				throw new RequestError({ status: 404, text: `Unrecognized Simkl URL: ${details.url}` });
			}
			showId = Number.parseInt(episodeMatch.groups.show, 10);
			season = Number.parseInt(episodeMatch.groups.season, 10);
			number = Number.parseInt(episodeMatch.groups.episode, 10);
		}

		const showItem = await this.findShowById(showId, caches, cancelKey);
		const episodes = await this.fetchEpisodes(showId, cancelKey);
		const episode = episodes.find((entry) => entry.season === season && entry.episode === number);
		if (!episode) {
			throw new RequestError({
				status: 404,
				text: `Season ${season} episode ${number} is not in Simkl's list for show ${showId}.`,
			});
		}
		return { episode: this.toEpisode(episode, showItem), show: showItem.show };
	}

	async fetchMovie(id: number, cancelKey = 'default'): Promise<SimklSearchMovieItemMovie> {
		await this.activate();
		const responseText = await this.requests.send({
			url: this.withParams(`${this.API_URL}/movies/${id}`, { extended: 'full' }),
			method: 'GET',
			cancelKey,
		});
		const raw = JSON.parse(responseText) as SimklRawItem;
		if (!simklIdOf(raw)) {
			throw new RequestError({ status: 404, text: responseText });
		}
		return {
			title: raw.title ?? '',
			year: raw.year ?? 0,
			released: raw.released ?? '',
			ids: { simkl: simklIdOf(raw), tmdb: tmdbIdOf(raw) },
			image_url: posterUrl(raw.poster),
		};
	}

	/**
	 * Looks the item up by a service's own id when Simkl accepts that id space. The
	 * result is title-checked before being trusted: a service id can refer to a
	 * season, an episode or a regional variant, and a silent mismatch here would
	 * scrobble the wrong show.
	 */
	async findByServiceId(item: Item, cancelKey = 'default'): Promise<SimklRawItem | null> {
		const key = SERVICE_ID_KEYS[item.serviceId];
		const id = item.id;
		if (!key || !id || !/^\d+$/.test(id)) {
			return null;
		}
		try {
			await this.activate();
			const responseText = await this.requests.send({
				url: this.withParams(`${this.SEARCH_URL}/id`, {
					[key]: id,
					type: item.type === 'movie' ? 'movie' : 'show',
				}),
				method: 'GET',
				cancelKey,
			});
			const results = JSON.parse(responseText) as SimklRawItem[];
			const match = results[0];
			if (!match || !simklIdOf(match)) {
				return null;
			}
			const expected = normalizeTitle(item.title);
			const found = normalizeTitle(match.title ?? '');
			if (expected && found && !found.includes(expected) && !expected.includes(found)) {
				return null;
			}
			return match;
		} catch (_err) {
			return null;
		}
	}

	async findItem(item: Item, cancelKey = 'default'): Promise<SimklSearchItem> {
		const isMovie = item.type === 'movie';

		const byServiceId = await this.findByServiceId(item, cancelKey);
		if (byServiceId) {
			return this.toSearchItem(byServiceId, isMovie);
		}

		await this.activate();
		const responseText = await this.requests.send({
			url: this.withParams(`${this.SEARCH_URL}/${isMovie ? 'movie' : 'tv'}`, {
				q: item.title,
				extended: 'full',
			}),
			method: 'GET',
			cancelKey,
		});
		const searchItems = JSON.parse(responseText) as SimklRawItem[];

		let searchItem: SimklRawItem | undefined;
		if (searchItems.length === 1) {
			// If there is only one search result, use it
			searchItem = searchItems[0];
		} else {
			// Try to match by name and year, or just name if year isn't available
			const itemTitle = item.title.toLowerCase();
			const itemYear = item.year;
			searchItem = searchItems.find(
				(current) =>
					(current.title ?? '').toLowerCase() === itemTitle &&
					(!itemYear || !current.year || itemYear === current.year)
			);
			if (!searchItem && !isMovie && searchItems.length > 1) {
				// No exact title match — try TMDB cross-reference.
				// TMDB has better localized title support, so searching TMDB for the
				// original title and matching the TMDB ID against Simkl results can
				// resolve cases where Simkl lists a show under a different (e.g. English) name.
				try {
					const { TmdbApi } = await import('@apis/TmdbApi');
					const tmdbShow = await TmdbApi.searchTvShow(item.title, item.year);
					if (tmdbShow) {
						searchItem = searchItems.find((current) => tmdbIdOf(current) === tmdbShow.id);
					}
				} catch (_err) {
					// TMDB cross-reference failed, will fall back to first result
				}
			}
			if (!searchItem) {
				// Couldn't match, so just use the first result
				searchItem = searchItems[0];
			}
		}
		if (!searchItem || !simklIdOf(searchItem)) {
			throw new RequestError({
				status: 404,
				text: responseText,
				extra: {
					item: item.save(),
				},
			});
		}
		return this.toSearchItem(searchItem, isMovie);
	}

	toSearchItem(raw: SimklRawItem, isMovie: boolean): SimklSearchItem {
		const ids = { simkl: simklIdOf(raw), tmdb: tmdbIdOf(raw) };
		if (isMovie) {
			return {
				movie: {
					title: raw.title ?? '',
					year: raw.year ?? 0,
					released: raw.released ?? '',
					ids,
					image_url: posterUrl(raw.poster),
				},
			};
		}
		return { show: { title: raw.title ?? '', year: raw.year ?? 0, ids } };
	}

	async findShow(
		item: EpisodeItem,
		caches: CacheItems<['simklItems', 'urlsToSimklItems']>,
		cancelKey = 'default'
	): Promise<SimklSearchShowItem> {
		const showKey = `show?q=${encodeURIComponent(item.show.title)}`;
		const cached = this.getCachedShow(showKey, caches);
		if (cached) {
			return cached;
		}
		const { show } = (await this.findItem(item.show, cancelKey)) as SimklSearchShowItem;
		return this.cacheShow(showKey, show, caches);
	}

	async findShowById(
		showId: number,
		caches: CacheItems<['simklItems', 'urlsToSimklItems']>,
		cancelKey = 'default'
	): Promise<SimklSearchShowItem> {
		const showKey = `show?simkl=${showId}`;
		const cached = this.getCachedShow(showKey, caches);
		if (cached) {
			return cached;
		}
		await this.activate();
		const responseText = await this.requests.send({
			url: this.withParams(`${this.API_URL}/tv/${showId}`, { extended: 'full' }),
			method: 'GET',
			cancelKey,
		});
		const raw = JSON.parse(responseText) as SimklRawItem;
		if (!simklIdOf(raw)) {
			throw new RequestError({ status: 404, text: responseText });
		}
		return this.cacheShow(
			showKey,
			{
				title: raw.title ?? '',
				year: raw.year ?? 0,
				ids: { simkl: simklIdOf(raw), tmdb: tmdbIdOf(raw) },
			},
			caches
		);
	}

	private getCachedShow(
		showKey: string,
		caches: CacheItems<['simklItems', 'urlsToSimklItems']>
	): SimklSearchShowItem | null {
		const simklDatabaseId = caches.urlsToSimklItems.get(showKey);
		const cacheItem = simklDatabaseId
			? (caches.simklItems.get(simklDatabaseId) as SimklShowItemValues | undefined)
			: null;
		if (!cacheItem) {
			return null;
		}
		return {
			show: {
				title: cacheItem.title,
				year: cacheItem.year,
				ids: { simkl: cacheItem.id, tmdb: cacheItem.tmdbId },
			},
		};
	}

	private cacheShow(
		showKey: string,
		show: SimklSearchShowItemShow,
		caches: CacheItems<['simklItems', 'urlsToSimklItems']>
	): SimklSearchShowItem {
		const simklDatabaseId = `show_${show.ids.simkl.toString()}`;
		caches.simklItems.set(simklDatabaseId, {
			type: 'show',
			id: show.ids.simkl,
			tmdbId: show.ids.tmdb,
			title: show.title,
			year: show.year,
		});
		caches.urlsToSimklItems.set(showKey, simklDatabaseId);
		return { show };
	}

	/**
	 * Every episode of a show, including specials, in one request. Sorted so absolute
	 * numbering can be computed by walking the list.
	 */
	async fetchEpisodes(showId: number, cancelKey = 'default'): Promise<SimklRawEpisode[]> {
		const cached = this.episodeLists.get(showId);
		if (cached) {
			return cached;
		}
		await this.activate();
		const responseText = await this.requests.send({
			url: this.withParams(`${this.API_URL}/tv/episodes/${showId}`, { extended: 'full' }),
			method: 'GET',
			cancelKey,
		});
		const parsed = JSON.parse(responseText) as SimklRawEpisode[];
		if (!Array.isArray(parsed)) {
			throw new RequestError({ status: 404, text: responseText });
		}
		const episodes = parsed
			.filter((entry) => entry.type === 'episode' && !!entry.season && !!entry.episode)
			.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));
		this.episodeLists.set(showId, episodes);
		return episodes;
	}

	async findEpisode(
		item: EpisodeItem,
		caches: CacheItems<['simklItems', 'urlsToSimklItems']>,
		cancelKey = 'default'
	): Promise<SimklSearchEpisodeItem> {
		// Nothing to match on — e.g. NRK history items with an empty subtitle. Fail as a
		// 404 so the notification layer says "not found" rather than blaming Simkl.
		if (!item.season && !item.number && !item.title) {
			throw new RequestError({
				status: 404,
				text: `Not enough information to search for episode: ${item.getFullTitle()}`,
			});
		}

		const showItem = await this.findShow(item, caches, cancelKey);
		const episodes = await this.fetchEpisodes(showItem.show.ids.simkl, cancelKey);
		const episode = this.resolveEpisode(item, episodes);
		if (!episode) {
			throw new RequestError({
				status: 404,
				text: 'Episode not found.',
				extra: {
					item: item.save(),
					showItem,
				},
			});
		}
		return { episode: this.toEpisode(episode, showItem), show: showItem.show };
	}

	/**
	 * Picks the episode from the show's full list, in decreasing order of confidence:
	 * the given season/episode pair, then the episode number read as an absolute
	 * (cross-season) number, then the title.
	 */
	resolveEpisode(item: EpisodeItem, episodes: SimklRawEpisode[]): SimklRawEpisode | null {
		const exact =
			item.season && item.number
				? episodes.find((entry) => entry.season === item.season && entry.episode === item.number)
				: undefined;
		if (exact) {
			return exact;
		}

		if (item.number) {
			const maxSeason = episodes.length ? (episodes[episodes.length - 1].season ?? 0) : 0;
			// A low episode number in a season Simkl doesn't know about yet means Simkl is
			// behind, not that the numbering is absolute — converting here would wrongly map
			// the episode into season 1.
			const isNewSeason = item.number <= 25 && !!item.season && item.season > maxSeason;
			if (!isNewSeason) {
				const absolute = episodes[item.number - 1];
				if (absolute) {
					return absolute;
				}
			}
		}

		if (item.title) {
			const wanted = normalizeTitle(item.title);
			const byTitle = episodes.find((entry) => normalizeTitle(entry.title ?? '') === wanted);
			if (byTitle) {
				return byTitle;
			}
		}

		return null;
	}

	toEpisode(raw: SimklRawEpisode, showItem: SimklSearchShowItem): SimklEpisodeItemEpisode {
		return {
			season: raw.season ?? 0,
			number: raw.episode ?? 0,
			title: raw.title ?? '',
			ids: {
				simkl: raw.ids?.simkl_id ?? 0,
				// Simkl has no per-episode TMDB id. TmdbApi builds episode image paths from
				// the show's id plus season/number anyway; it only checks this field for
				// presence, so carrying the show's id through keeps images working.
				tmdb: showItem.show.ids.tmdb,
			},
			first_aired: raw.date ?? null,
			image_url: stillUrl(raw.img),
		};
	}
}

export const SimklSearch = new _SimklSearch();
