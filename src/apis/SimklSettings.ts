import { SimklApi } from '@apis/SimklApi';
import { Cache } from '@common/Cache';

/**
 * `POST /users/settings` — note it is a POST, unlike Trakt's GET.
 *
 * Simkl returns far less than Trakt did. In particular there is **no `date_format`
 * and no `time_24hr`**: the account block is `{id, timezone, type,
 * anime_title_language}`. Upstream built its display format from those two fields,
 * so `getTimeAndDateFormat()` now derives the format from the browser locale
 * instead — see the comment there.
 */
export interface SimklSettingsResponse {
	user: {
		name: string;
		joined_at: string;
	};
	account: {
		id: number;
		timezone: string;
		type: string;
		anime_title_language: string;
	};
}

const DATE_PART_FORMATS: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {
	year: 'yyyy',
	month: 'MMM',
	day: 'd',
};

class _SimklSettings extends SimklApi {
	constructor() {
		super();
	}

	async getSettings(): Promise<SimklSettingsResponse | null> {
		try {
			const cache = await Cache.get('simklSettings');
			let settings = cache.get('default');
			if (!settings) {
				await this.activate();
				const responseText = await this.requests.send({
					url: this.withParams(this.SETTINGS_URL),
					method: 'POST',
				});
				settings = JSON.parse(responseText) as SimklSettingsResponse;
				cache.set('default', settings);
				await Cache.set({ simklSettings: cache });
			}
			return settings;
		} catch (_err) {
			return null;
		}
	}

	/**
	 * Builds a date-fns format string. Simkl exposes no date-format preference to read,
	 * so this follows the browser's locale instead: `Intl` gives both the field order
	 * and whether the locale uses a 12-hour clock, which covers the same ground as
	 * Trakt's `date_format`/`time_24hr` — and without a network call.
	 */
	getTimeAndDateFormat(): string {
		const fallback = 'EEE d MMM yyyy, H:mm:ss';
		try {
			const order = new Intl.DateTimeFormat(undefined, {
				year: 'numeric',
				month: 'short',
				day: 'numeric',
			})
				.formatToParts(new Date(0))
				.map((part) => DATE_PART_FORMATS[part.type])
				.filter((format): format is string => !!format);
			if (order.length !== 3) {
				return fallback;
			}

			const { hour12 } = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions();
			return `EEE ${order.join(' ')}${hour12 ? ', h:mm:ss aaa' : ', H:mm:ss'}`;
		} catch (_err) {
			return fallback;
		}
	}
}

export const SimklSettings = new _SimklSettings();
