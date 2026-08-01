import { ServiceApi } from '@apis/ServiceApi';
import { SimklScrobble } from '@apis/SimklScrobble';
import { SimklSearch } from '@apis/SimklSearch';
import { Cache } from '@common/Cache';
import { ItemCorrectedData, StorageOptionsChangeData } from '@common/Events';
import { getScrobbleParser, ScrobbleParser } from '@common/ScrobbleParser';
import { Shared } from '@common/Shared';
import { createSimklScrobbleItem } from '@models/SimklItem';

const scrobbleControllers = new Map<string, ScrobbleController>();

export const getScrobbleController = (id: string): ScrobbleController => {
	if (!scrobbleControllers.has(id)) {
		const scrobbleParser = getScrobbleParser(id);
		scrobbleControllers.set(id, new ScrobbleController(scrobbleParser));
	}
	const controller = scrobbleControllers.get(id);
	if (!controller) {
		throw new Error(`Scrobble controller not registered for ${id}`);
	}
	return controller;
};

export class ScrobbleController {
	readonly api: ServiceApi;
	readonly parser: ScrobbleParser;
	private reachedScrobbleThreshold = false;
	private scrobbleThreshold = 80.0;
	private progress = 0.0;
	private hasAddedListeners = false;

	constructor(parser: ScrobbleParser) {
		this.parser = parser;
		this.api = this.parser.api;
	}

	init(): void {
		this.checkListeners();
		Shared.events.subscribe('STORAGE_OPTIONS_CHANGE', null, this.onStorageOptionsChange);
	}

	onStorageOptionsChange = (data: StorageOptionsChangeData): void => {
		const serviceOption = data.options?.services?.[this.api.id];
		if (serviceOption && 'scrobble' in serviceOption) {
			this.checkListeners();
		}
	};

	checkListeners(): void {
		const { scrobble } = Shared.storage.options?.services?.[this.api.id] ?? {};
		if (scrobble && !this.hasAddedListeners) {
			Shared.events.subscribe('SCROBBLING_ITEM_CORRECTED', null, this.onItemCorrected);
			this.hasAddedListeners = true;
		} else if (!scrobble && this.hasAddedListeners) {
			Shared.events.unsubscribe('SCROBBLING_ITEM_CORRECTED', null, this.onItemCorrected);
			this.hasAddedListeners = false;
		}
	}

	async startScrobble(): Promise<void> {
		const item = this.parser.getItem();
		if (!item) {
			return;
		}
		this.reachedScrobbleThreshold = false;
		this.progress = 0.0;
		if (typeof item.simkl === 'undefined') {
			const caches = await Cache.get(['itemsToSimklItems', 'simklItems', 'urlsToSimklItems']);
			const { corrections } = await Shared.storage.get(['corrections']);
			const databaseId = item.getDatabaseId();
			const correction = corrections?.[databaseId];
			try {
				item.simkl = await SimklSearch.find(item, caches, correction);
			} catch (err) {
				item.simkl = null;
				throw err;
			}
			await Cache.set(caches);
		}
		if (!item.simkl) {
			return;
		}
		item.simkl.progress = item.progress;
		await SimklScrobble.start(item);
	}

	async pauseScrobble(): Promise<void> {
		const item = this.parser.getItem();
		if (!item?.simkl) {
			return;
		}
		await SimklScrobble.pause(item);
	}

	async stopScrobble(): Promise<void> {
		const item = this.parser.getItem();
		if (!item?.simkl) {
			return;
		}
		await SimklScrobble.stop(item);
		this.parser.clearItem();
		this.reachedScrobbleThreshold = false;
		this.progress = 0.0;
	}

	async updateProgress(progress: number): Promise<void> {
		const item = this.parser.getItem();
		if (!item) {
			return;
		}
		item.progress = progress;
		if (!item?.simkl) {
			return;
		}
		item.simkl.progress = progress;
		if (!this.reachedScrobbleThreshold && item.simkl.progress > this.scrobbleThreshold) {
			// Update the stored progress after reaching the scrobble threshold to make sure that the item is scrobbled on tab close.
			this.reachedScrobbleThreshold = true;
			const { scrobblingDetails } = await Shared.storage.get('scrobblingDetails');
			if (scrobblingDetails) {
				scrobblingDetails.item = item.save();
				await Shared.storage.set({ scrobblingDetails }, false);
				await Shared.events.dispatch('SCROBBLE_PROGRESS', null, scrobblingDetails);
			}
		} else if (
			item.progress < this.progress ||
			(this.progress === 0.0 && item.progress > 1.0) ||
			item.progress - this.progress > 10.0
		) {
			// Update the scrobbling item once the progress reaches 1% and then every time it increases by 10%
			this.progress = item.progress;
			const { scrobblingDetails } = await Shared.storage.get('scrobblingDetails');
			if (scrobblingDetails) {
				scrobblingDetails.item = item.save();
				await Shared.storage.set({ scrobblingDetails }, false);
				await Shared.events.dispatch('SCROBBLE_PROGRESS', null, scrobblingDetails);
			}
		}
	}

	private onItemCorrected = async (data: ItemCorrectedData): Promise<void> => {
		if (!data.newItem.simkl) {
			return;
		}
		const item = this.parser.getItem();
		if (!item) {
			return;
		}
		await this.updateProgress(0.0);
		await this.stopScrobble();
		item.simkl = createSimklScrobbleItem(data.newItem.simkl);
		await this.startScrobble();
	};
}
