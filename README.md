# JURA WiFi Connect V2

Monitor a JURA coffee machine on your LAN and send brew, stop, and statistics
requests from ioBroker. UDP monitoring works without credentials. TCP commands
use the pairing token and the machine's setup PIN if one is configured.

The adapter bundles 88 model catalogs. It selects the catalog from the
machine model reported over UDP, preserving model variants. A Z10 that reports
`EF545M V02.01` uses the `EF545` catalog. Unrecognized models can still report
identity and raw live status. Commands require a matching catalog.

## Install

The package requires Node.js 22 or later, js-controller 7 or later, and Admin
7.6.20 or later.

1. In ioBroker Admin, enable expert mode and open **Adapters**.
2. Click the Octocat icon to open the installation dialog, then select **Custom**.
3. Enter `iobroker.jura-wifi-2@latest` in the **URL** field to install from npm.
4. Leave **Create instance if it does not exist yet** checked and click **Install**.

Open the instance settings in Admin. Enter the machine's IP address or IPv4
hostname and a polling interval. Save the settings and enable the instance.
The ioBroker host needs UDP port 51515 on the machine for monitoring and TCP
port 51515 for commands.

## Pair for commands

Connect the machine to Wi-Fi with J.O.E. first. Enable the ioBroker instance,
open its settings in Admin, and enter the machine's IPv4 address or hostname.
Enter the setup PIN if PIN protection is on. Otherwise leave the PIN blank.
Click **Pair** and confirm the prompt on the machine display
within about 20 seconds. The dialog fills the token field. Click **Save** to
apply the credentials. ioBroker encrypts the PIN and token when saving them.

If you already have paired credentials from a Juras settings export, you can
enter the token and any configured setup PIN directly and save.

## Objects

For instance `jura-wifi-2.0`:

| State | Value |
| --- | --- |
| `info.connection` | True when the machine is reachable and the adapter has authenticated |
| `info.reachable` | Whether the latest UDP poll received a valid response, even without pairing |
| `info.name`, `info.model`, `info.module`, `info.articleNumber` | Identity and firmware reported by the machine |
| `status.ready`, `status.productRunning` | Ready flag and product activity |
| `status.activeAlerts` | JSON array of active idle flags with bit numbers and catalog labels, or null while a product runs |
| `status.milkCleaning` | True while the Z10 reports the milk-cleaning phase (`P_Mode`) |
| `status.milkCleaningNecessary` | True while the active alerts include the milk-cleaning request |
| `status.payload` | Latest raw UDP status payload as hex |
| `status.phaseCode`, `status.phase` | Current product phase. Cleared when idle |
| `status.dispensed`, `status.target`, `status.progress` | Milliliters dispensed, target milliliters, and percentage during dispensing |
| `products.catalog` | JSON array of product codes, defaults, and allowed ranges |
| `products.catalog.<product name>` | Writable boolean switch named `Brew <product>` that uses the catalog defaults |
| `products.custom.<drink name>` | Writable boolean switch that brews a saved custom drink |
| `products.counts.<product name>` | Per-product brew counts, refreshed at startup, every 10 minutes, and on demand |
| `products.counts.Total` | Total brew count |
| `maintenance.*` | Maintenance data refreshed on the same schedule, with IDs such as `maintenance.cycles.cappuClean` |
| `info.commandResult` | Result of the latest processed command |

Write commands with `ack: false`. Write `true` to a product switch to brew it.
After the machine accepts the brew request, the adapter reports acceptance in
`info.commandResult` and resets the switch to `false` with `ack: true`. A rejected
request or missing reply leaves the switch unacknowledged.
Switch and counter IDs use the catalog product name, including spaces.
Characters that ioBroker forbids in IDs become underscores. Products that
share a name get their hex product codes in parentheses. A successful
statistics refresh creates named counters and removes the old adapter-managed
hex counters. Counters with custom history settings stay at their old IDs.
Update scripts that addressed hex IDs.
On the Z10, `products.counts.2 Espressi` and `products.counts.2 Coffee` also
show the double-drink counts. These two entries are counters only.
The command states under `commands` reset after each processed request.
Brew results report acceptance. Stop results report that the request was sent.
Watch the UDP states for brew progress. On a connection loss the adapter retains the
last status snapshot and sets both indicators to false. It keeps polling and
checks the saved credentials when the machine responds again and is idle.

The adapter refreshes statistics at startup and every 10 minutes after that.
A refresh waits if the machine is offline, unauthenticated, or busy.

```js
// Brew an espresso with all catalog defaults.
setState('jura-wifi-2.0.products.catalog.Espresso', true, false);

// Brew an espresso with a custom water amount.
setState('jura-wifi-2.0.commands.brew', JSON.stringify({ productCode: 2, water: 45 }), false);

// Stop the current product step.
setState('jura-wifi-2.0.commands.stop', true, false);

// Refresh product counters and maintenance data while idle.
setState('jura-wifi-2.0.commands.refreshStatistics', true, false);
```

Brew overrides are `strength`, `water` (ml), `milkAmount` (seconds of liquid
milk), `milkFoam` (seconds of foam), `bypass` (ml), and `temperature` (`LOW`,
`NORMAL`, or `HIGH`), where the product supports them. The catalog's `milk`
field describes the foam range, or the milk range on models that use the same
field for liquid milk. `milk` and `milkFoam` are aliases in brew commands.
Place a cup under the appropriate outlet before sending a brew command.

These settings are also available where the catalog lists them for the base
drink. The ranges below are for the Z10. Omit a setting to use the machine's
default.

| JSON field | Setting |
| --- | --- |
| `grindLevel` | 1 (coarsest) to 5 (finest) |
| `strokes` | 1–5 brewing cycles for Pot (Jug of coffee, product code `12`) |
| `milkPause` | 0–60 seconds for Latte Macchiato |
| `milkFoamTemperature` | Foam temperature level 1–10 |
| `milkTemperature` | Liquid milk temperature level 1–10 (experimental encoding) |

For example, `{"productCode": 12, "strokes": 2}` requests a two-cycle jug.

On products with two grinders, `grinderRatio` selects the left/right split.
Codes `0` through `4` correspond to 100/0, 75/25, 50/50, 25/75, and 0/100.
The catalog determines which splits and grind levels each product accepts.

Use `preselections` to request options such as a cold Espresso or an extra
shot in a Cappuccino. For example, on the Z10 use
`{"productCode": 2, "preselections": ["coldbrew"]}`. The
`availablePreselections` list in `products.catalog` gives the choices for each
product. A `+` in that list marks a combination. Pass its names as separate
array entries in a JSON recipe. On legacy machines, ground coffee (`powder`),
cold or light brew, and extra shot (`xtrashot`) replace strength, temperature,
and brewing cycles respectively. Leave those fields at their defaults when
using the corresponding preselection.

Drinks that support Cold Brew also get a catalog switch such as
`products.catalog.Cold Brew Espresso`. The switch uses the base drink's
defaults and selects Cold Brew. Both versions use the same machine product
code and share its counter.

Preselection encoding and the extended grind-level byte come from the J.O.E.
app analysis and still need hardware verification.
[Jura WiFi protocol reference](https://github.com/makefu/jura-connect/blob/3b711222b1a9d2fae248c5495db840be5d9b8c5a/docs/PROTOCOL.md#513-preselections-preselection--combination--apk-derived-unverified)

## Custom drinks

In the instance settings, add a recipe under **Custom drinks** and give it a
name, such as `My Drink`. Once the adapter has detected the machine, choose a
**Base drink** and select any overrides. Each setting starts with the catalog
default. Overrides apply only to the base drink they were selected for. The
editor uses the last detected model when the machine is off, even after an
adapter restart.

If the catalog is unavailable, enable **Edit recipe as JSON** and enter the
same JSON you would send to `commands.brew`. Existing JSON recipes open in
that editor automatically.

```json
{"productCode": 5, "water": 90, "milkAmount": 9, "milkFoam": 2}
```

After saving, write `true` with `ack: false` to
`jura-wifi-2.0.products.custom.My Drink`. The switch resets to `false` with
`ack: true` when the machine accepts the request. Custom recipes are stored in
the adapter settings. They leave the machine's saved recipes unchanged.

## Development

Run `npm run build` to compile the TypeScript sources. Run `npm test` to run the
protocol and adapter integration tests. The adapter tests use an in-memory
ioBroker state store, a controlled clock, and a simulated machine on loopback
sockets. `npm pack` builds and packages the adapter as CommonJS.
Run `npm run test:ci` to run the same version checks and tests as GitHub Actions.

[makefu/jura-connect](https://github.com/makefu/jura-connect) is another
upstream reference to check for protocol fixes, model-specific behavior, and
extensions that may apply to this adapter.

### Refresh machine catalogs

1. Download the J.O.E. APK or XAPK for package `ch.toptronic.joe`. You can search
   by package ID in the [APKPure downloader](https://apkpure.net/apk-downloader).
   Check the package against the [official Google Play listing](https://play.google.com/store/apps/details?id=ch.toptronic.joe).
2. Attach the download to your coding agent in this repo and ask it to run the
   importer, review the changes under `lib/catalogs/`, and run `npm run test:ci`.
   Keep the generated JSON in the repo and the downloaded archive outside it.

   ```sh
   python3 scripts/update-catalogs.py --apk "/path/to/J.O.E.xapk"
   ```

The importer reads `assets/documents/xml/` from the APK inside the download,
selects the highest profile version per model, and converts product settings,
preselections, and machine capabilities to JSON. It uses the pinned
jura-connect XMLs for models missing from the download. Omit `--apk` to use
the fallback for every model.

## Releasing

Add a `### **WORK IN PROGRESS**` heading at the top of the changelog with at
least one release note, then commit it. From a clean, up-to-date `main`,
preview the bump with `npm run release patch -- --dry`. Run
`npm run release patch` to release, or
choose `minor` or `major`. The release script updates the package versions and
ioBroker news, then pushes the release commit and `v` tag. The **Test and
Release** workflow tests the tagged commit, publishes it to npm, and creates a
GitHub Release. Prerelease tags publish to npm's `next` dist-tag.

For the first npm publication, run `npm ci`, `npm run build`, and
`npm publish --access public` from a clean checkout with a maintainer npm
account. Then configure [npm Trusted
Publishing](https://docs.npmjs.com/trusted-publishers/) for
`agross/ioBroker.jura-wifi-2` and `test-and-release.yml`. Use the release script
for subsequent versions.

## Changelog

### **WORK IN PROGRESS**

- Rename the adapter title to JURA WiFi Connect V2.

### 0.3.5 (2026-11-23)

- Label grind levels from Very coarse to Very fine in the custom drink editor.

### 0.3.4 (2026-11-22)

- Document how to install the adapter from npm through ioBroker Admin.

### 0.3.3 (2026-11-22)

- First release on [npm](https://www.npmjs.com/package/iobroker.jura-wifi-2/v/0.3.3).
- Keep the custom drink editor usable after an adapter restart with the machine off.

### 0.3.2 (2026-11-22)

- Add named custom drinks with saved recipe parameters and brew switches.
- Add a catalog-backed custom drink editor to Admin, with a JSON option.
- Add Z10 grind level, jug cycles, milk pause, and milk temperature overrides.
- Reset brew switches after the machine accepts the request.
- Add Z10 double-drink counters and separate liquid milk and foam parameters.
- Refresh product settings from J.O.E. profiles and add the S10 catalog.
- Add preselections, twin-grinder ratios, and extended grind levels to custom drinks.
- Add Cold Brew catalog switches for drinks that support the preselection.
- Use camelCase maintenance state IDs, such as `maintenance.cycles.cappuClean`.

## License

Copyright (c) 2026 Alexander Groß <agross@therightstuff.de>

The protocol and original model catalogs come from
[kykc/juras](https://github.com/kykc/juras/tree/f5d51080b504196347d3049c5910dbfd007c149f)
under the [MIT license](LICENSE). The catalog refresh uses the J.O.E. machine
profiles mirrored by [makefu/jura-connect](https://github.com/makefu/jura-connect/tree/3b711222b1a9d2fae248c5495db840be5d9b8c5a/jura_connect/data/xml).
The adapter uses the
[JURA logo from Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Jura_Logo.svg).
This is an unofficial integration.
