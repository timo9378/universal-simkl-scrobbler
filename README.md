<h1 align="center">
  <br>
  Universal Simkl Scrobbler
  <br>
</h1>
<h4 align="center">A universal scrobbler for Simkl — a fork of <a href="https://github.com/trakt-tools/universal-trakt-scrobbler">Universal Trakt Scrobbler</a> that syncs to Simkl instead of Trakt.</h4>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Status: work in progress" src="https://img.shields.io/badge/status-work%20in%20progress-orange.svg">
</p>

> **Status: work in progress — not usable yet.**
> The Trakt→Simkl backend swap is not implemented. Right now this is an unmodified fork of
> upstream, made public so the reasoning below is on the record. Don't install this expecting
> it to work.

---

## Why this fork exists

On **2026-07-30**, Trakt merged
[trakt-web#3057](https://github.com/trakt/trakt-web/pull/3057) —
`feat(settings): make api application creation vip-only`. The strings it added say it plainly:

> `"Creating new apps requires Trakt VIP"`
> `"VIP members can register unlimited OAuth applications."`

That part is a business decision, and a defensible one. A company needs revenue, and gating
*new* app creation behind a paid tier is a normal thing to do.

What happened alongside it is not that.

**Existing API applications on free accounts were deleted, with no announcement and no
migration window.** That is not described anywhere in PR #3057 — the PR explicitly says the
application list stays *"(still readable)"* and that only the create button is gated. But
integrations that had been running for years stopped, and the accounts behind them could no
longer recreate what had been removed.

The failure mode, written out for anyone searching these strings:

```
POST /oauth/token        → 400  invalid_grant   "session not found"
POST /oauth/device/code  → 401  invalid_client  "client not found"
GET  /users/me           → 403
```

`session not found` means the stored tokens are dead. `client not found` means the application
itself no longer exists on Trakt's side — so re-authorizing doesn't help, because there is
nothing left to authorize against.

Reports of the same thing, all within days of the merge:

- [forums.trakt.tv — "Problem with API, unauthorized all the sudden"](https://forums.trakt.tv/t/problem-with-api-unauthorized-all-the-sudden/119235) (26 replies)
- [trakt-web#3061 — "Can't see API apps"](https://github.com/trakt/trakt-web/issues/3061)

A 15-year member with a single app for a decade. Someone who had joined weeks earlier when
TV Time shut down. As of this writing there is still no official statement on the deletions.

I'm not forking because of the paywall. I'm forking because **the pipeline was removed without
warning**, and I'd rather not rebuild on something that can do that again.

## What this changes

Exactly one thing: the destination.

```
upstream    streaming service → extractor → Trakt
this fork   streaming service → extractor → Simkl
```

The ~29 streaming-service extractors — the part that actually understands Netflix's internal
API, Disney+'s player, HBO Max's page structure — are **entirely upstream's work and are not
being touched**. They live under `src/services/` and have no dependency on the sync target
(`DisneyplusApi.ts` and `HboMaxApi.ts` reference Trakt zero times). Only the backend adapter
changes:

| Upstream file | Fate |
| :--- | :--- |
| `src/apis/TraktApi.ts` | → `SimklApi.ts` |
| `src/apis/TraktAuth.ts` | → `SimklAuth.ts` — Simkl has a PIN/device flow and non-expiring tokens, so the refresh-token rotation goes away |
| `src/apis/TraktScrobble.ts` | → `SimklScrobble.ts` — `/scrobble/start`, `/pause`, `/stop` |
| `src/apis/TraktSearch.ts` | → `SimklSearch.ts` — Simkl returns imdb/tmdb/tvdb ids directly, so much of the matching heuristics can shrink |
| `src/apis/TraktSync.ts` | → `SimklSync.ts` |
| `src/models/TraktItem.ts` | → `SimklItem.ts` |
| `src/services/**` | **unchanged** |

### A note on Simkl's free tier

Worth stating up front, since the entire point of this fork is not being surprised again.

Simkl has paid tiers, and playback *sessions* (unfinished progress) are retained for 7 days on
free, 30 on PRO, 90 on VIP. **Finished items are not affected** — `/scrobble/stop` at ≥80%
progress writes to the permanent watch history. That is the behaviour this fork depends on.

That's an observation about how the API behaves today, not a promise about tomorrow. Simkl is
also a third party and could make the same call Trakt did. The difference is that this time
it's written down before building on it.

## Supported streaming services

Inherited from upstream, unchanged. "Scrobble" is live tracking while you watch; "Sync" is
bulk-importing existing history.

<!-- services-start -->

| Streaming Service | Scrobble | Sync | Limitations                      |
| :---------------: | :------: | :--: | :------------------------------- |
|   Amazon Prime    |    ✔️    |  ✔️  | Scrobbling only works in English |
|       AMC+        |    ✔️    |  ❌  | -                                |
|       Crave       |    ✔️    |  ✔️  | -                                |
|    Crunchyroll    |    ❌    |  ✔️  | -                                |
|    discovery+     |    ✔️    |  ✔️  | -                                |
|      Disney+      |    ✔️    |  ❌  | -                                |
|        Go3        |    ✔️    |  ❌  | -                                |
|     GoPlay BE     |    ✔️    |  ❌  | -                                |
|      HBO Go       |    ✔️    |  ❌  | -                                |
|      HBO Max      |    ✔️    |  ✔️  | -                                |
|      Hotstar      |    ✔️    |  ❌  | -                                |
|      Kijk.nl      |    ✔️    |  ❌  | -                                |
|       MUBI        |    ✔️    |  ✔️  | -                                |
|      Netflix      |    ✔️    |  ✔️  | -                                |
|        NRK        |    ✔️    |  ✔️  | -                                |
|     Player.pl     |    ✔️    |  ❌  | -                                |
|  Polsatboxgo.pl   |    ✔️    |  ❌  | -                                |
|    SkyShowtime    |    ✔️    |  ❌  | -                                |
|       Star+       |    ✔️    |  ❌  | -                                |
|    Streamz BE     |    ✔️    |  ❌  | -                                |
|      Stremio      |    ✔️    |  ❌  | -                                |
|      Tet TV+      |    ✔️    |  ❌  | -                                |
|     TV 2 PLAY     |    ✔️    |  ✔️  | -                                |
|      Viaplay      |    ✔️    |  ✔️  | -                                |
|       Vidio       |    ✔️    |  ❌  | -                                |
|     VRTNu BE      |    ✔️    |  ❌  | -                                |
|     VTMGo BE      |    ✔️    |  ❌  | -                                |
|    Wakanim.tv     |    ✔️    |  ❌  | -                                |

<!-- services-end -->

Simkl's own Chrome extension covers Netflix and Crunchyroll. Everything else in this table —
Disney+, HBO Max, Prime, and the rest — is why this fork is worth the effort.

## How the extension works

It extracts information about the TV shows / movies you are watching or have watched, by
scraping the page or using the streaming service's own API, and sends it to Simkl using the
[Simkl API](https://simkl.docs.apiary.io/).

## Known issues

- You might have to disable "automatic mode" in the Temporary Containers extension while
  logging in, if you use it.
- Make sure you are logged into the streaming service before trying to sync history.

## Development

Build tooling is unchanged from upstream — see
[upstream's README](https://github.com/trakt-tools/universal-trakt-scrobbler#development).
The one difference is the credentials step: register an app at
[Simkl's developer settings](https://simkl.com/settings/developer/) instead of Trakt, and put
the client id / secret in `.env`.

New streaming services are still added with `npx trakt-tools dev create-service`, and their
extractors are independent of the sync target.

## Credits

**All of the hard part is upstream's.**
[Universal Trakt Scrobbler](https://github.com/trakt-tools/universal-trakt-scrobbler) by
[trakt-tools](https://github.com/trakt-tools) — 29 streaming services' worth of
reverse-engineered extraction logic, a clean `ServiceApi` abstraction that makes this fork a
backend swap rather than a rewrite, and years of keeping up with site redesigns. This fork
exists because that work deserves to keep running somewhere that won't delete it.

Upstream is in turn based on [traktflix](https://github.com/tegon/traktflix) by
[tegon](https://github.com/tegon).

Translations for upstream are managed on
[Crowdin](https://crowdin.com/project/universal-trakt-scrobbler) — contribute there, not here,
so the whole ecosystem benefits.

This product uses the TMDb API, but is not endorsed or certified by TMDb.
This product uses the Simkl API.

[LICENSE](LICENSE) — MIT, same as upstream. Original copyright (c) 2020 trakt-tools is retained.
