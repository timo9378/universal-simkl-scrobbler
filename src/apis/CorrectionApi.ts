import { ScrobbleItem } from '@models/Item';

export interface Suggestion {
	type: 'episode' | 'movie';
	/** Simkl id — of the **show** for episodes, of the movie otherwise. */
	id: number;
	title: string;

	/**
	 * Season and episode numbers, set for episode suggestions.
	 *
	 * Trakt gave every episode its own id, so upstream could store just that. Simkl has
	 * no endpoint that resolves a bare episode id, so an episode correction has to name
	 * the show plus the numbers.
	 */
	season?: number;
	number?: number;

	/**
	 * How many submissions the suggestion had.
	 *
	 * A high count indicates that the suggestion is probably correct.
	 */
	count: number;
}

export interface SuggestionsDatabaseResponse {
	result: Partial<Record<string, Suggestion[]>>;
}

/**
 * ⚠️ The shared suggestions database is **disabled in this fork**.
 *
 * `uts.rafaelgomes.xyz` is upstream's community database and every id in it is a
 * *Trakt* id. Trakt and Simkl id spaces are unrelated, so a suggestion fetched from
 * there would resolve to an arbitrary unrelated title — and it would do so silently,
 * scrobbling the wrong thing to the user's account. Reading from it is worse than
 * having no suggestions at all, and writing Simkl ids into it would corrupt the
 * database for upstream's users.
 *
 * Corrections the user makes themselves still work: those live in
 * `Shared.storage.corrections`, keyed by the item's own database id, and never touch
 * this endpoint.
 */
class _CorrectionApi {
	/**
	 * Returns the database ID for a suggestion.
	 *
	 * Episodes have to include the numbers: `id` is now the *show* id, so without them
	 * every episode of a show would collapse onto the same key.
	 */
	getSuggestionDatabaseId(suggestion: Pick<Suggestion, 'type' | 'id' | 'season' | 'number'>) {
		if (suggestion.type === 'episode') {
			return `episode_${suggestion.id.toString()}_s${(suggestion.season ?? 0).toString()}e${(
				suggestion.number ?? 0
			).toString()}`;
		}
		return `${suggestion.type}_${suggestion.id.toString()}`;
	}

	/**
	 * Returns a Simkl URL for a suggestion.
	 */
	getSuggestionUrl(suggestion: Suggestion) {
		if (suggestion.type === 'episode') {
			const base = `https://simkl.com/tv/${suggestion.id.toString()}`;
			return suggestion.season && suggestion.number
				? `${base}/season-${suggestion.season.toString()}/episode-${suggestion.number.toString()}`
				: base;
		}
		return `https://simkl.com/movies/${suggestion.id.toString()}`;
	}

	/**
	 * Loads suggestions for items from the database.
	 *
	 * If all suggestions have already been loaded, returns the same parameter array, otherwise returns a new array for immutability.
	 */
	async loadSuggestions(items: ScrobbleItem[]): Promise<ScrobbleItem[]> {
		const hasLoadedSuggestions = !items.some((item) => typeof item.suggestions === 'undefined');
		if (hasLoadedSuggestions) {
			return items;
		}
		const newItems = items.map((item) => item.clone());
		// Marking every item as `null` rather than `undefined` keeps the rest of the UI on
		// its "already looked, found nothing" path instead of retrying forever.
		for (const item of newItems) {
			item.suggestions = null;
		}
		return newItems;
	}

	/**
	 * No-op: see the note on this class. Writing Simkl ids into a Trakt-keyed database
	 * would corrupt it for upstream's users.
	 */
	async saveSuggestion(_item: ScrobbleItem, _suggestion: Suggestion): Promise<void> {
		return Promise.resolve();
	}
}

export const CorrectionApi = new _CorrectionApi();
