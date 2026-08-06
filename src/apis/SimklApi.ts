import browser from 'webextension-polyfill';
import { Requests, withHeaders } from '@common/Requests';
import { Shared } from '@common/Shared';

/**
 * Base for every Simkl API call: endpoint URLs, auth headers, and the query
 * parameters Simkl requires on *every* request.
 *
 * Differences from upstream's TraktApi that are easy to get wrong:
 *
 * - `simkl-api-key` carries the client id, same idea as `trakt-api-key`, but there
 *   is **no** API-version header. Simkl versions through the URL path instead.
 * - Simkl requires `client_id`, `app-name` and `app-version` as query parameters on
 *   every request, plus a descriptive `User-Agent`. Their docs are explicit that
 *   ignoring the usage rules gets the client id suspended, so `withParams()` exists
 *   to make it hard to forget.
 * - There is no token revoke endpoint documented, so `REVOKE_TOKEN_URL` is gone.
 *   Logging out just drops the stored token locally.
 */
export class SimklApi {
	HOST_URL: string;
	API_URL: string;
	AUTHORIZE_URL: string;
	REDIRECT_URL: string;
	REQUEST_TOKEN_URL: string;
	PIN_URL: string;
	SEARCH_URL: string;
	SHOWS_URL: string;
	SCROBBLE_URL: string;
	SYNC_URL: string;
	WATCHED_URL: string;
	SETTINGS_URL: string;
	ACTIVITIES_URL: string;

	/** Sent as `app-name`/`app-version`; Simkl uses these to identify traffic. */
	APP_NAME = 'universal-simkl-scrobbler';
	APP_VERSION: string;

	requests = Requests;

	isActivated = false;

	/**
	 * The client id `requests` was wrapped with. Compared on every `activate()` so that
	 * changing the id in the options page takes effect without reloading the extension.
	 */
	activatedClientId: string | null = null;

	constructor() {
		this.HOST_URL = 'https://simkl.com';
		this.API_URL = 'https://api.simkl.com';
		this.AUTHORIZE_URL = `${this.HOST_URL}/oauth/authorize`;
		this.REDIRECT_URL = `${this.HOST_URL}/apps`;
		this.REQUEST_TOKEN_URL = `${this.API_URL}/oauth/token`;
		this.PIN_URL = `${this.API_URL}/oauth/pin`;
		this.SEARCH_URL = `${this.API_URL}/search`;
		this.SHOWS_URL = `${this.API_URL}/tv`;
		this.SCROBBLE_URL = `${this.API_URL}/scrobble`;
		this.SYNC_URL = `${this.API_URL}/sync/history`;
		this.WATCHED_URL = `${this.API_URL}/sync/watched`;
		this.SETTINGS_URL = `${this.API_URL}/users/settings`;
		this.ACTIVITIES_URL = `${this.API_URL}/sync/activities`;
		// Note `Shared.manifestVersion` is the *manifest format* (2 or 3), not the app
		// version — the value Simkl wants is the extension version, which webpack copies
		// from package.json into the generated manifest.
		this.APP_VERSION = browser.runtime.getManifest().version;
	}

	/**
	 * Appends the query parameters Simkl requires on every request. Always route
	 * URLs through this rather than concatenating by hand.
	 */
	withParams(url: string, extra?: Record<string, string>): string {
		const sep = url.includes('?') ? '&' : '?';
		const params = new URLSearchParams({
			client_id: Shared.clientId,
			'app-name': this.APP_NAME,
			'app-version': this.APP_VERSION,
			...extra,
		});
		return `${url}${sep}${params.toString()}`;
	}

	async activate(): Promise<void> {
		if (this.isActivated && this.activatedClientId === Shared.clientId) {
			return;
		}

		const headers: Record<string, string> = {
			'simkl-api-key': Shared.clientId,
			'Content-Type': 'application/json',
		};
		const values = await Shared.storage.get('auth');
		if (values.auth?.access_token) {
			headers['Authorization'] = `Bearer ${values.auth.access_token}`;
		}

		// Wrap the base module, not `this.requests` — re-activating after a client id
		// change would otherwise stack another proxy on the previous one every time.
		this.requests = withHeaders(headers, Requests);

		this.isActivated = true;
		this.activatedClientId = Shared.clientId;
	}
}
