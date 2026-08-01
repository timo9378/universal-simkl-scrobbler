export type SimklItem = SimklScrobbleItem | SimklShowItem;

export type SimklScrobbleItem = SimklEpisodeItem | SimklMovieItem;

export type SimklItemValues = SimklScrobbleItemValues | SimklShowItemValues;

export type SimklScrobbleItemValues = SimklEpisodeItemValues | SimklMovieItemValues;

export interface SimklBaseItemValues {
	id: number;
	tmdbId: number;
	syncId?: number;
	title: string;
	year: number;
	releaseDate?: number;
	watchedAt?: number | null;
	/** List of other watchedAt values available */
	otherWatches?: number[];
	progress?: number;
	imageUrl?: string | null;
}

export interface SimklEpisodeItemValues extends SimklBaseItemValues {
	type: 'episode';
	season: number;
	number: number;
	show: SimklShowItemValues;
}

export type SimklEpisodeItemParams = Omit<SimklEpisodeItemValues, 'type' | 'show'> & {
	show: Omit<SimklShowItemValues, 'type'>;
};

export interface SimklShowItemValues extends SimklBaseItemValues {
	type: 'show';
}

export type SimklShowItemParams = Omit<SimklShowItemValues, 'type'>;

export interface SimklMovieItemValues extends SimklBaseItemValues {
	type: 'movie';
}

export type SimklMovieItemParams = Omit<SimklMovieItemValues, 'type'>;

abstract class SimklBaseItem implements SimklBaseItemValues {
	id: number;
	tmdbId: number;
	syncId?: number;
	title: string;
	year: number;
	releaseDate?: number;
	watchedAt?: number | null;
	otherWatches?: number[];
	progress: number;
	imageUrl?: string | null;

	constructor(values: SimklBaseItemValues) {
		this.id = values.id;
		this.tmdbId = values.tmdbId;
		this.syncId = values.syncId;
		this.title = values.title;
		this.year = values.year;
		this.releaseDate = values.releaseDate;
		this.watchedAt = values.watchedAt;
		this.otherWatches =
			values.otherWatches != null ? [...values.otherWatches] : values.otherWatches;
		this.progress = values.progress ? Math.round(values.progress * 100) / 100 : 0.0;
		this.imageUrl = values.imageUrl;
	}

	save(): SimklBaseItemValues {
		return {
			id: this.id,
			tmdbId: this.tmdbId,
			syncId: this.syncId,
			title: this.title,
			year: this.year,
			releaseDate: this.releaseDate,
			watchedAt: this.watchedAt,
			otherWatches: this.otherWatches != null ? [...this.otherWatches] : this.otherWatches,
			progress: this.progress,
			imageUrl: this.imageUrl,
		};
	}

	/**
	 * Returns the ID used to uniquely identify the item in the database.
	 */
	abstract getDatabaseId(): string;

	abstract getHistoryUrl(): string;

	/**
	 * Clones the item for immutability.
	 */
	abstract clone(): SimklItem;
}

export class SimklEpisodeItem extends SimklBaseItem implements SimklEpisodeItemValues {
	type = 'episode' as const;
	season: number;
	number: number;
	show: SimklShowItem;

	constructor(values: SimklEpisodeItemParams) {
		super(values);
		this.season = values.season;
		this.number = values.number;
		this.show = new SimklShowItem(values.show);
	}

	save(): SimklEpisodeItemValues {
		return {
			...super.save(),
			type: this.type,
			season: this.season,
			number: this.number,
			show: this.show.save(),
		};
	}

	getDatabaseId(): string {
		return `episode_${this.id.toString()}`;
	}

	getHistoryUrl(): string {
		// Simkl has no per-episode history URL, so this points at the episode page.
		return `https://simkl.com/tv/${this.show.id}/season-${this.season}/episode-${this.number}`;
	}

	clone(): SimklEpisodeItem {
		return new SimklEpisodeItem(this);
	}
}

export class SimklShowItem extends SimklBaseItem implements SimklShowItemValues {
	type = 'show' as const;

	constructor(values: SimklShowItemParams) {
		super(values);
	}

	save(): SimklShowItemValues {
		return {
			...super.save(),
			type: this.type,
		};
	}

	getDatabaseId(): string {
		return `show_${this.id.toString()}`;
	}

	getHistoryUrl(): string {
		return `https://simkl.com/tv/${this.id}`;
	}

	clone(): SimklShowItem {
		return new SimklShowItem(this);
	}
}

export class SimklMovieItem extends SimklBaseItem implements SimklMovieItemValues {
	type = 'movie' as const;

	constructor(values: SimklMovieItemParams) {
		super(values);
	}

	save(): SimklMovieItemValues {
		return {
			...super.save(),
			type: this.type,
		};
	}

	getDatabaseId(): string {
		return `movie_${this.id.toString()}`;
	}

	getHistoryUrl(): string {
		return `https://simkl.com/movies/${this.id}`;
	}

	clone(): SimklMovieItem {
		return new SimklMovieItem(this);
	}
}

export const createSimklItem = (values: SimklItemValues): SimklItem => {
	switch (values.type) {
		case 'show':
			return new SimklShowItem(values);

		default:
			return createSimklScrobbleItem(values);
	}
};

export const createSimklScrobbleItem = (values: SimklScrobbleItemValues): SimklScrobbleItem => {
	switch (values.type) {
		case 'episode':
			return new SimklEpisodeItem(values);

		case 'movie':
			return new SimklMovieItem(values);
	}
};

export const isSimklItem = (item: unknown): item is SimklItem => {
	return item instanceof SimklBaseItem;
};
