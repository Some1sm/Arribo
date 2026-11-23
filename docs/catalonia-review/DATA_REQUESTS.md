# Data to request, by provider

Input for the public-information requests and the GAIP report. For each provider it says what Arribo! gets today, what is missing, and the exact data to ask for, with what each item changes for users. "Verified" means seen in this project's own requests to the feeds (November 2026); everything else is marked as unverified and should be checked before it goes into a formal request.

## What to ask every provider for

These conditions apply to every item below. Name them in each request, so a provider cannot answer with a PDF or a web page.

1. **Format:** machine-readable, in the open standard for its kind: GTFS for timetables, GTFS-Realtime (VehiclePositions, TripUpdates, ServiceAlerts) for real time, or SIRI where the provider already uses it. Documented fields, with UTF-8 text.
2. **Licence:** an open licence that allows reuse, including commercial reuse, with attribution only (CC BY 4.0, as FGC already uses). Written, not implied.
3. **Access:** a stable public URL. No login, or a free key issued on request, with a stated request quota that allows polling every 20 to 30 seconds (about 3,000 to 4,500 requests a day per feed).
4. **Freshness:** the published delay between the real event and the feed, and the update interval. Real-time files should be at most 30 seconds old.
5. **History:** an archive of the real-time data (or at least of the actual arrival and departure times per stop), so punctuality can be measured for periods Arribo! was not recording. If they keep it, ask for it as files per day.
6. **Change notice:** advance notice, or a changelog, when timetables, stop ids or feed URLs change.

### Who decides which request

- **GAIP** (Comissió de Garantia del Dret d'Accés a la Informació Pública) covers the Generalitat, its companies and Catalan local bodies: FGC, ATM, AMB, TMB, the Generalitat's interurban bus service, Ajuntament de Mataró, the holiday datasets.
- **Renfe and Adif are state companies.** A refusal from them goes to the state **Consejo de Transparencia y Buen Gobierno**, not to GAIP (Llei 19/2013). Check whether the new Rodalies de Catalunya company created for the service transfer falls under the Generalitat; if it does, GAIP may cover it.
- **Supporting argument for all of them:** the EU rules on multimodal travel information (Delegated Regulation (EU) 2017/1926, amended by (EU) 2024/490) require transport operators to make static and real-time data available through the National Access Point (Spain: nap.transportes.gob.es). Check the deadlines that apply to each data type before citing them.

## Priority

| # | Provider | Ask | Why it matters most |
|---|---|---|---|
| 1 | Adif / Renfe | Platform ("via") for every train, before it arrives | Users asked for it; the data exists on Adif's own boards but is not open |
| 2 | Renfe | Predicted time for every remaining stop, not one delay per train | Station boards and Dades need per-station times |
| 3 | FGC | A key or quota for real time, and fresher files | Today's anonymous limit caps how often FGC can be polled |
| 4 | Generalitat interurban buses | Any real-time feed | Today these buses can only be shown as timetable |
| 5 | AMB, TMB, TRAM | Open real-time feeds, including vehicle positions | Required to cover the Barcelona area |
| 6 | City buses (Sabadell, Terrassa, Girona, Lleida, Tarragona, Reus) | GTFS + real time | Mostly proprietary apps today |
| 7 | Mataró (Ajuntament + Avanza) | Written licence for the SIRI feed, and the timetable as GTFS | The service already depends on it |
| 8 | Holidays | Complete local-holiday data, published early | Every timetable depends on the day type |

## Rodalies de Catalunya: Renfe and Adif

**Today (verified):** Renfe's national GTFS and GTFS-RT (positions and trip updates), which Arribo! cuts to Catalonia. Open licence, no key.

**Missing, and what to request:**

1. **Platform for every train at every station, published ahead of arrival** (Adif, infrastructure manager).
   - Today Renfe gives a platform only in the label of a train already approaching its next station, for example `R2S-25547-PLATF.(11)`. Nothing is published for trains further away, and the GTFS has no platform stops at all.
   - Adif's station pages (for example adif.es, Mataró station) show the platform of every departure about three hours ahead, through an internal, token-protected endpoint. That data exists; it is not open data and its terms do not allow reuse.
   - **Request:** the planned and the actual platform per train and station, as open data: either `platform_code` per platform stop in the GTFS plus the live platform in GTFS-RT TripUpdates (`stop_id` of the platform the train will use), or Adif's station-board data as an open feed with a reuse licence. Include platform changes as they happen.
   - Until then Arribo! shows the platform a line *usually* uses, learned from Renfe's own announcements and labelled "habitual".
2. **Predictions for every remaining stop** (Renfe). Request TripUpdates with a `stop_time_update` (arrival and departure time or delay) for every stop still to come, not one delay per train. Unverified detail: check against the current feed which trips carry stop-level updates.
3. **Trip identity in the real-time feed** (Renfe). Request `start_date` (and `start_time` where needed) in every TripUpdate and VehiclePosition, so a live train matches the right timetable day around midnight.
4. **Directions and destinations in the GTFS** (Renfe). Verified missing: there is no `direction_id`, and trips have no `trip_headsign`. Arribo! infers both from station order; about 2,900 of 33,800 trips cannot be oriented that way. Request both fields.
5. **Cancellations and changed stops** (Renfe). Request cancelled trips (`schedule_relationship: CANCELED`), skipped stops (`SKIPPED`), added and replacement services (including replacement buses), each with a reason where one is known.
6. **Service alerts in Catalan** (Renfe). Request ServiceAlerts with Catalan text (plus Spanish and English), linked to the affected line, station or trip, with start and end times.
7. **Vehicle positions in tunnels** (unverified, reported by earlier research). Ask whether positions in the Barcelona tunnels come from the signalling system and can be published; if not, ask for the train's last station passed and the time.
8. **Rolling stock and length** (Renfe, lower priority). Train type and number of cars per trip (single or double unit), useful for where to wait on the platform.
9. **History** (Renfe and Adif). The actual arrival and departure times per train and station for past days, for punctuality statistics.

## FGC

**Today (verified):** static GTFS and GTFS-RT (positions and trip updates) through the Opendatasoft open-data portal, CC BY 4.0, attribution "Ferrocarrils de la Generalitat de Catalunya". Platforms are published (`platform_code`), and live trip updates name the platform stop.

**Missing, and what to request:**

1. **Quota.** The anonymous limit is 5,000 requests a day (`x-ratelimit-limit: 5000`, resets at 00:00 UTC). Positions every 30 s plus trip updates every 90 s already use about 3,840. Request a free key with at least 20,000 requests a day, or the real-time files on a URL outside the per-request quota (a static file or a CDN).
2. **Freshness.** Verified: the real-time files are about 1.5 to 2 minutes old when fetched and are replaced about every 2 minutes, so a train's position can be 2 to 4 minutes behind. Request files updated every 15 to 30 seconds.
3. **Directions.** Verified: no `direction_id` in the GTFS. Arribo! infers it (all FGC trips can be oriented), but request it so the operator's own direction is used.
4. **Alerts.** Request ServiceAlerts in GTFS-RT, in Catalan, linked to lines and stations.
5. **History.** Actual times per train and station for past days.

## Generalitat interurban buses (Departament de Territori, Direcció General de Transports i Mobilitat)

**Today (unverified):** a GTFS for 900+ lines is published; real time is reportedly available only inside the Mou-te app, from the concession operators' fleet systems.

**Request:**
1. Real-time GTFS-RT (VehiclePositions and TripUpdates) for every line, or the operators' existing feeds re-published openly. If the Generalitat receives these data from the concessions, ask for them as held.
2. The licence of the GTFS, and whether the concession contracts oblige operators to supply real-time data to the Generalitat (and in which format).
3. Stop ids that stay stable between GTFS releases.

## AMB (Àrea Metropolitana de Barcelona) buses

**Today (unverified):** GTFS and stop-level predictions; vehicle positions reported as restricted.

**Request:** open GTFS-RT VehiclePositions and TripUpdates for all AMB bus lines, under an open licence; if positions are withheld, the stated reason.

## TMB (bus and metro)

**Today (unverified):** GTFS and the iBus REST API through developer.tmb.cat, with an `app_id`/`app_key`; GTFS-RT reported but not confirmed.

**Request:** GTFS-RT VehiclePositions and TripUpdates for buses, and metro arrival predictions per station, under an open licence; the quota for a registered key; whether metro has position or arrival data at all.

## TRAM (Trambaix, Trambesòs)

**Today (unverified):** GTFS; real time needs registration.

**Request:** open GTFS-RT TripUpdates (and positions if available), without registration or with a free key, under an open licence.

## ATM (Autoritat del Transport Metropolità)

**Today (unverified):** an integrated GTFS, with trip updates and alerts reported.

**Request:** the integrated GTFS and real-time feeds under an open licence, with the list of operators each one covers and how current each operator's part is.

## City bus services (Sabadell, Terrassa, Girona, Lleida, Tarragona, Reus)

**Today (unverified):** mostly proprietary apps; static data varies.

**Request, to each Ajuntament (and its operator):**
1. GTFS for every line, with an open licence.
2. GTFS-RT VehiclePositions and TripUpdates (or SIRI), open.
3. Whether the service contract obliges the operator to provide these data to the Ajuntament.

## Mataró urban buses (Ajuntament de Mataró and Avanza)

**Today (verified):** Avanza's SIRI service with the client credentials every consumer of the portal uses; timetables scraped from maresme.net and the Avanza portal.

**Request:**
1. Written authorisation (or an open licence) to reuse the SIRI real-time data, ideally with credentials issued to Arribo!.
2. The timetable as GTFS, with the seasons and day types, updated with each change.
3. Advance notice of timetable, stop and route changes.

## Holidays (Generalitat, Departament d'Empresa i Treball)

**Today (verified):** the regional (`yf2b-mjr6`) and local (`b4eh-r8up`) holiday datasets on dadesobertes.gencat.cat, read by `scripts/update_holidays.js`.

**Request:** each year's local holidays for every municipality as soon as they are approved, in the same dataset, with stable municipality codes (INE).
