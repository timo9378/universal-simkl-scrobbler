import { SimklApi } from '@apis/SimklApi';
import { Messaging } from '@common/Messaging';
import { Shared } from '@common/Shared';
import { Tabs } from '@common/Tabs';
import browser from 'webextension-polyfill';

/**
 * Simkl's PIN (device) flow, replacing upstream's Trakt OAuth code flow.
 *
 * Why the flow changed rather than just the URLs:
 *
 * - Trakt used an authorization-code redirect, which meant registering a redirect
 *   URI that differs per browser and per install (`browser.identity.getRedirectURL()`
 *   returns `https://<extension-id>.chromiumapp.org/`). Upstream carried a whole
 *   fallback path for that — a tab, a content script injected on trakt.tv, and a
 *   `finish-login` message to hand the callback URL back to the background page.
 * - Simkl's PIN flow needs no redirect URI at all: request a code, show it to the
 *   user on simkl.com/pin, poll until they approve. The same code path works
 *   identically on Chrome, Firefox and Edge, so all of the above is gone.
 * - **Simkl access tokens do not expire and there is no refresh token.** Upstream's
 *   `hasTokenExpired`/`refreshToken`/`refreshPromise` de-duplication has no
 *   counterpart here; a stored token stays valid until the user revokes it on
 *   simkl.com. There is also no documented revoke endpoint, so logging out just
 *   drops the local copy.
 */

export type SimklAuthDetails = {
	access_token: string;
	token_type: string;
	scope: string;
};

/** Response from `GET /oauth/pin`. */
type SimklPinResponse = {
	result: string;
	device_code: string;
	user_code: string;
	verification_url: string;
	expires_in: number;
	interval: number;
};

/** The part of a pending PIN the login page needs in order to show it. */
export type SimklPendingPin = {
	user_code: string;
	verification_url: string;
};

/** Response from `GET /oauth/pin/{user_code}` — `KO` until the user approves. */
type SimklPinPollResponse = {
	result: 'OK' | 'KO';
	message?: string;
	access_token?: string;
};

class _SimklAuth extends SimklApi {
	/** Set while a PIN flow is in progress, so the login page can show the code. */
	pendingPin: SimklPendingPin | null = null;

	private pinTabId?: number;

	/**
	 * Runs the full PIN flow: request a code, open simkl.com/pin for the user, then
	 * poll until they approve it. Resolves with the stored auth details.
	 */
	async authorize(): Promise<SimklAuthDetails> {
		await this.activate();

		const pin = await this.requestPin();
		this.pendingPin = { user_code: pin.user_code, verification_url: pin.verification_url };

		// The code is in the path so simkl.com can pre-fill it; the user still sees it
		// on screen in case the pre-fill doesn't survive a login redirect.
		const tab = await Tabs.open(`${pin.verification_url}/${pin.user_code}`);
		this.pinTabId = tab?.id;

		try {
			const accessToken = await this.pollForToken(pin);
			const auth: SimklAuthDetails = {
				access_token: accessToken,
				token_type: 'bearer',
				scope: 'public',
			};
			await Shared.storage.set({ auth }, true);
			// Re-run activate() so subsequent requests carry the Authorization header;
			// the instance was activated before a token existed.
			this.isActivated = false;
			await this.activate();
			return auth;
		} finally {
			this.pendingPin = null;
			if (typeof this.pinTabId !== 'undefined') {
				await browser.tabs.remove(this.pinTabId).catch(() => undefined);
				this.pinTabId = undefined;
			}
		}
	}

	async requestPin(): Promise<SimklPinResponse> {
		const responseText = await this.requests.send({
			url: this.withParams(this.PIN_URL),
			method: 'GET',
		});
		const pin = JSON.parse(responseText) as SimklPinResponse;
		if (pin.result !== 'OK' || !pin.user_code) {
			throw new Error(`Simkl did not return a PIN: ${responseText}`);
		}
		return pin;
	}

	/**
	 * Polls at the interval Simkl asks for, giving up when the code expires. Simkl
	 * answers 200 with `result: 'KO'` while the code is still pending, so the status
	 * code alone can't be used to tell "not yet" from "failed".
	 */
	async pollForToken(pin: SimklPinResponse): Promise<string> {
		const intervalMs = Math.max(pin.interval, 1) * 1000;
		const deadline = Date.now() + pin.expires_in * 1000;

		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, intervalMs));

			const responseText = await this.requests.send({
				url: this.withParams(`${this.PIN_URL}/${pin.user_code}`),
				method: 'GET',
			});
			const response = JSON.parse(responseText) as SimklPinPollResponse;
			if (response.result === 'OK' && response.access_token) {
				return response.access_token;
			}
		}

		throw new Error('The Simkl PIN expired before it was approved.');
	}

	/**
	 * Simkl documents no revoke endpoint, so this only forgets the local token. The
	 * user can revoke the app itself at simkl.com/settings/connections.
	 */
	async revokeToken(): Promise<void> {
		await Shared.storage.remove('auth', true);
		this.isActivated = false;
	}

	/**
	 * Simkl tokens don't expire, so this is a stored-value read rather than upstream's
	 * expiry check plus refresh.
	 */
	async validateToken(): Promise<SimklAuthDetails | null> {
		if (Shared.pageType !== 'background') {
			return Messaging.toExtension({ action: 'validate-simkl-token' });
		}
		const values = await Shared.storage.get('auth');
		return values.auth ?? null;
	}
}

export const SimklAuth = new _SimklAuth();
