import browser from 'webextension-polyfill';
import type { BrowserStorage } from '@common/BrowserStorage';
import type { Errors } from '@common/Errors';
import type { EventDispatcher } from '@common/Events';

export interface SharedValues {
	environment: string;
	/**
	 * Simkl client id from https://simkl.com/settings/developer/.
	 *
	 * There is deliberately no client secret: the PIN flow doesn't use one, and a
	 * secret shipped inside an extension isn't secret anyway.
	 */
	clientId: string;
	rollbarToken: string;
	tmdbApiKey: string;

	manifestVersion: number;
	browser: BrowserName;
	pageType: PageType;
	tabId: number | null;
	redirectPath?: string;
	dateFormat: string;

	storage: typeof BrowserStorage;
	errors: typeof Errors;
	events: typeof EventDispatcher;

	functionsToInject: Record<string, () => unknown>;

	waitForInit: () => Promise<unknown>;
	finishInit: () => void;
}

export type BrowserPrefix = 'moz' | 'chrome' | 'unknown';

export type BrowserName = 'firefox' | 'chrome' | 'unknown';

export type PageType = 'content' | 'popup' | 'background';

const browsers: Record<BrowserPrefix, BrowserName> = {
	moz: 'firefox',
	chrome: 'chrome',
	unknown: 'unknown',
};
const browserPrefix = browser
	? (browser.runtime.getURL('/').split('-')[0] as BrowserPrefix)
	: 'unknown';

let initPromiseResolve: (value: unknown) => void = () => {
	// Do nothing
};

const initPromise = new Promise((resolve) => (initPromiseResolve = resolve));

export const Shared: SharedValues = {
	// `DATABASE_URL` used to point at upstream's helper service (uts.rafaelgomes.xyz)
	// for TMDB images and community corrections. Both are gone in this fork: the image
	// routes 404, and its correction ids are Trakt ids that would resolve to unrelated
	// Simkl titles. See TmdbApi and CorrectionApi.
	environment: process.env.REACT_ENV || '',
	clientId: process.env.SIMKL_CLIENT_ID || '',
	rollbarToken: process.env.ROLLBAR_TOKEN || '',
	tmdbApiKey: process.env.TMDB_API_KEY || '',

	manifestVersion: browser.runtime.getManifest().manifest_version,
	browser: browsers[browserPrefix] || 'unknown',
	pageType: 'content',
	tabId: null,
	dateFormat: 'EEE d MMM yyyy, H:mm:ss',

	storage: {} as typeof BrowserStorage,
	errors: {} as typeof Errors,
	events: {} as typeof EventDispatcher,

	functionsToInject: {},

	waitForInit: () => initPromise,
	finishInit: () => initPromiseResolve(null),
};
