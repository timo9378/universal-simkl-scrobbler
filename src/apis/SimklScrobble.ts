import { SimklApi } from '@apis/SimklApi';
import { RequestError } from '@common/RequestError';
import { Shared } from '@common/Shared';
import { createScrobbleItem, ScrobbleItem } from '@models/Item';
import { SimklScrobbleItem } from '@models/SimklItem';

/**
 * Body for `/scrobble/{start,pause,stop}`.
 *
 * The start/pause/stop semantics carried over from Trakt unchanged — `stop` at ≥80%
 * marks the item watched, below that it saves a resumable pause — but the payload
 * shape did not: Trakt identified an episode by its own id, while Simkl requires the
 * **show** object plus season/episode numbers. `progress` is a percentage 0–100 in
 * both APIs.
 *
 * Simkl also returns 409 from `/scrobble/stop` when the same item was already
 * completed within the last hour; that is a duplicate, not a failure, so `send()`
 * treats it as success.
 */
export interface SimklScrobbleData {
	movie?: {
		title?: string;
		year?: number;
		ids: {
			simkl: number;
		};
	};
	show?: {
		title?: string;
		year?: number;
		ids: {
			simkl: number;
		};
	};
	episode?: {
		season: number;
		number: number;
	};
	progress: number;
}

class _SimklScrobble extends SimklApi {
	START: number;
	PAUSE: number;
	STOP: number;

	paths: Record<number, string>;

	constructor() {
		super();

		this.START = 1;
		this.PAUSE = 2;
		this.STOP = 3;

		this.paths = {
			[this.START]: '/start',
			[this.PAUSE]: '/pause',
			[this.STOP]: '/stop',
		};
	}

	async start(item: ScrobbleItem): Promise<void> {
		if (!item.simkl) {
			return;
		}
		await this.send(item.simkl, this.START);
		let { scrobblingDetails } = await Shared.storage.get('scrobblingDetails');
		if (scrobblingDetails?.tabId === Shared.tabId) {
			scrobblingDetails.isPaused = false;
		} else {
			scrobblingDetails = {
				item: item.save(),
				tabId: Shared.tabId,
				isPaused: false,
			};
		}
		await Shared.storage.set({ scrobblingDetails }, false);
		await Shared.events.dispatch('SCROBBLE_START', null, scrobblingDetails);
	}

	async pause(item: ScrobbleItem): Promise<void> {
		if (!item.simkl) {
			return;
		}
		await this.send(item.simkl, this.PAUSE);
		const { scrobblingDetails } = await Shared.storage.get('scrobblingDetails');
		if (scrobblingDetails) {
			scrobblingDetails.isPaused = true;
			await Shared.storage.set({ scrobblingDetails }, false);
			await Shared.events.dispatch('SCROBBLE_PAUSE', null, scrobblingDetails);
		}
	}

	async stop(item?: ScrobbleItem): Promise<void> {
		const { scrobblingDetails } = await Shared.storage.get('scrobblingDetails');
		if (!scrobblingDetails) {
			return;
		}
		if (!item) {
			item = createScrobbleItem(scrobblingDetails.item);
		}
		if (!item) {
			return;
		}
		if (item.simkl) {
			await this.send(item.simkl, this.STOP);
		}
		await Shared.storage.remove('scrobblingDetails', false);
		await Shared.events.dispatch('SCROBBLE_STOP', null, scrobblingDetails);
	}

	/** Builds the `movie` or `show` + `episode` pair Simkl expects. */
	buildData(item: SimklScrobbleItem): SimklScrobbleData {
		if (item.type === 'episode') {
			return {
				show: {
					title: item.show.title,
					year: item.show.year,
					ids: { simkl: item.show.id },
				},
				episode: {
					season: item.season,
					number: item.number,
				},
				progress: item.progress,
			};
		}
		return {
			movie: {
				title: item.title,
				year: item.year,
				ids: { simkl: item.id },
			},
			progress: item.progress,
		};
	}

	async send(item: SimklScrobbleItem, scrobbleType: number): Promise<void> {
		const path = this.paths[scrobbleType];
		try {
			await this.activate();
			await this.requests.send({
				url: this.withParams(`${this.SCROBBLE_URL}${path}`),
				method: 'POST',
				body: this.buildData(item),
			});
			await Shared.events.dispatch('SCROBBLE_SUCCESS', null, {
				item: item.save(),
				scrobbleType,
			});
		} catch (err) {
			// 409 means Simkl already recorded this watch within the last hour. The user's
			// history is in the state we wanted, so reporting an error would be misleading.
			if (err instanceof RequestError && err.status === 409) {
				await Shared.events.dispatch('SCROBBLE_SUCCESS', null, {
					item: item.save(),
					scrobbleType,
				});
				return;
			}
			if (Shared.errors.validate(err)) {
				await Shared.events.dispatch('SCROBBLE_ERROR', null, {
					item: item.save(),
					scrobbleType,
					error: err,
				});
			}
		}
	}
}

export const SimklScrobble = new _SimklScrobble();
