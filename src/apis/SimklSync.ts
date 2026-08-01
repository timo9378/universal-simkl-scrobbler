import { SimklApi } from '@apis/SimklApi';
import { Cache, CacheItem } from '@common/Cache';
import { Shared } from '@common/Shared';
import { Utils } from '@common/Utils';
import { ScrobbleItem } from '@models/Item';
import { SyncStore } from '@stores/SyncStore';

/**
 * History sync against Simkl. Three things work differently from upstream's Trakt
 * implementation, and all three are visible in this file:
 *
 * 1. **Reading history is a POST, not a GET.** Trakt had
 *    `GET /sync/history/episodes/{id}` returning every watch of that item. Simkl's
 *    equivalent is `POST /sync/watched` with an array of item identities, answering
 *    `{result, list, last_watched_at}` per entry.
 * 2. **Simkl stores only the last watch.** There is no list of watch events, so
 *    `otherWatches` is always empty here. Upstream used it to warn about rewatches;
 *    that warning simply can't be produced from Simkl's data.
 * 3. **Removal is by item identity, not by a sync id.** Trakt returned a per-watch
 *    `id` that `/sync/history/remove` accepted. Simkl's remove endpoint takes the
 *    same media objects as the add endpoint, so `syncId` is unused — see
 *    `buildMediaPayload()`.
 */

/** One entry of the `POST /sync/watched` request array. */
interface SimklWatchedQuery {
	simkl: number;
	type: 'show' | 'movie';
	season?: number;
	episode?: number;
}

/**
 * One entry of the `POST /sync/watched` response array; echoes the query keys. This
 * is what gets cached as `simklHistoryItems` — upstream cached Trakt's watch-log
 * entries there instead.
 */
export interface SimklWatchedResult extends SimklWatchedQuery {
	result: boolean | 'not_found';
	list: string | null;
	last_watched_at: string | null;
}

export interface SimklSyncResponse {
	added: {
		movies: number;
		shows: number;
		episodes: number;
	};
	not_found: {
		movies: SimklSyncNotFound[];
		shows: SimklSyncNotFound[];
		episodes: SimklSyncNotFound[];
	};
}

export interface SimklSyncNotFound {
	ids?: {
		simkl?: number;
	};
}

/** Shape accepted by both `/sync/history` and `/sync/history/remove`. */
interface SimklMediaPayload {
	movies?: {
		ids: { simkl: number };
		watched_at?: string;
	}[];
	shows?: {
		ids: { simkl: number };
		seasons?: {
			number: number;
			episodes: { number: number; watched_at?: string }[];
		}[];
	}[];
}

class _SimklSync extends SimklApi {
	constructor() {
		super();
	}

	/**
	 * Builds the media object for one item. Episodes are addressed through their show
	 * plus season/episode numbers rather than an episode id: Simkl resolves those
	 * reliably, whereas episode-level Simkl ids only exist for items we looked up via
	 * `/tv/episodes/{id}`.
	 */
	buildMediaPayload(item: ScrobbleItem, watchedAt?: string): SimklMediaPayload | null {
		if (!item.simkl) {
			return null;
		}
		if (item.simkl.type === 'episode') {
			const showId = item.simkl.show.id;
			if (!showId) {
				return null;
			}
			return {
				shows: [
					{
						ids: { simkl: showId },
						seasons: [
							{
								number: item.simkl.season,
								episodes: [{ number: item.simkl.number, watched_at: watchedAt }],
							},
						],
					},
				],
			};
		}
		if (item.simkl.type === 'movie') {
			return { movies: [{ ids: { simkl: item.simkl.id }, watched_at: watchedAt }] };
		}
		return null;
	}

	toWatchedQuery(item: ScrobbleItem): SimklWatchedQuery | null {
		if (!item.simkl) {
			return null;
		}
		if (item.simkl.type === 'episode') {
			return {
				simkl: item.simkl.show.id,
				type: 'show',
				season: item.simkl.season,
				episode: item.simkl.number,
			};
		}
		if (item.simkl.type === 'movie') {
			return { simkl: item.simkl.id, type: 'movie' };
		}
		return null;
	}

	async loadHistory(
		item: ScrobbleItem,
		simklHistoryItemsCache: CacheItem<'simklHistoryItems'>,
		forceRefresh = false,
		cancelKey = 'default'
	): Promise<void> {
		const watchedAt = item.simkl?.watchedAt || item.getWatchedDate();
		if (!item.simkl || !watchedAt) {
			return;
		}
		const query = this.toWatchedQuery(item);
		if (!query) {
			return;
		}

		const databaseId = item.simkl.getDatabaseId();
		let results = forceRefresh ? null : simklHistoryItemsCache.get(databaseId);
		if (!results) {
			await this.activate();
			const responseText = await this.requests.send({
				url: this.withParams(this.WATCHED_URL),
				method: 'POST',
				body: [query],
				cancelKey,
			});
			results = JSON.parse(responseText) as SimklWatchedResult[];
			simklHistoryItemsCache.set(databaseId, results);
		}

		const match = results.find((result) => result.result === true && result.last_watched_at);
		if (match?.last_watched_at) {
			item.simkl.watchedAt = Utils.unix(match.last_watched_at);
		} else {
			item.simkl.watchedAt = null;
		}
		// Simkl keeps a single `last_watched_at` per item rather than a watch log, so
		// there is nothing to populate here.
		item.simkl.otherWatches = [];
	}

	async removeHistory(item: ScrobbleItem): Promise<void> {
		const payload = this.buildMediaPayload(item);
		if (!payload || !item.simkl) {
			return;
		}
		await this.activate();
		await this.requests.send({
			url: this.withParams(`${this.SYNC_URL}/remove`),
			method: 'POST',
			body: payload,
		});
		item.simkl.watchedAt = undefined;
	}

	async sync(store: SyncStore, items: ScrobbleItem[], cancelKey = 'sync') {
		const newItems: ScrobbleItem[] = [];
		try {
			const data: Required<SimklMediaPayload> = { movies: [], shows: [] };
			for (const item of items) {
				const payload = this.buildMediaPayload(
					item,
					Utils.convertToISOString(item.getWatchedDate())
				);
				if (payload?.movies) {
					data.movies.push(...payload.movies);
				}
				if (payload?.shows) {
					data.shows.push(...payload.shows);
				}
			}

			await this.activate();
			const responseText = await this.requests.send({
				url: this.withParams(this.SYNC_URL),
				method: 'POST',
				body: data,
				cancelKey,
			});
			const responseJson = JSON.parse(responseText) as SimklSyncResponse;

			// `not_found` echoes back the objects we sent, so a show id landing there means
			// every episode we nested under it failed too.
			const notFoundIds = new Set(
				[...responseJson.not_found.movies, ...responseJson.not_found.shows]
					.map((entry) => entry.ids?.simkl)
					.filter((id): id is number => typeof id === 'number')
			);

			const simklHistoryItemsCache = await Cache.get('simklHistoryItems');
			for (const item of items) {
				if (!item.simkl) {
					continue;
				}
				const sentId = item.simkl.type === 'episode' ? item.simkl.show.id : item.simkl.id;
				if (notFoundIds.has(sentId)) {
					continue;
				}
				const newItem = item.clone();
				await SimklSync.loadHistory(newItem, simklHistoryItemsCache, true, cancelKey);
				newItem.isSelected = false;
				newItems.push(newItem);
			}
			await Cache.set({ simklHistoryItems: simklHistoryItemsCache });
			await store.update(newItems, true);
			await Shared.events.dispatch('HISTORY_SYNC_SUCCESS', null, {
				added: {
					movies: responseJson.added.movies,
					episodes: responseJson.added.episodes,
				},
			});
		} catch (err) {
			if (Shared.errors.validate(err)) {
				Shared.errors.error('Failed to sync history.', err);
				await store.update(newItems, true);
				await Shared.events.dispatch('HISTORY_SYNC_ERROR', null, { error: err });
			}
		}
	}
}

export const SimklSync = new _SimklSync();
