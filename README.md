This is a fork of Greasemonkey for uxp-based browsers, based on the [upstream version of Violentmonkey](https://github.com/violentmonkey/violentmonkey) and on [JanekPtacijarabaci's version of 3.31.4](https://github.com/janekptacijarabaci/greasemonkey).


This fork was created to continue on the efforts of previous contributors and on Janek's development of the extension.

> **Upgrading from 3.5.0 or earlier/old fork?**  3.6.0 uses a new extension ID
> (`{544fad5a-9b62-418f-a9ff-616e388cf6c4}`), replacing the legacy
> `greasemonkeyforpm@janekptacijarabaci` ID inherited from Janek's fork.
> Your browser will **not** auto-update across this change; you need to
> uninstall the old version and install 3.6.0 manually.

A lot of changes were made to fill the gap of 8 years of no updates. The key changes include:

- **Script isolation and stability** — One broken script no longer takes down all your other scripts. Each script runs independently.
- **Early injection for redirect scripts** — `@run-at document-start` now fires before the page begins rendering, fixing scripts like "Reddit Old Redirect."
- **`@grant none` page-context injection** — Scripts without GM APIs now run directly in the page context (matching Violentmonkey/Tampermonkey behavior), wrapped in an IIFE to prevent conflicts.
- **`@connect` enforcement** — `GM_xmlhttpRequest` is now restricted to declared domains, closing a security gap present in the old fork.
- **12+ new GM APIs** — `GM_addElement`, `GM_addValueChangeListener`, `GM_removeValueChangeListener`, `GM_unregisterMenuCommand`, `GM_getValues`, `GM_setValues`, `GM_deleteValues`, `GM_openInTab` with `.close()`/`.onclose`, and more.
- **New metadata directives** — `@exclude-match`, `@run-at document-body`, `@inject-into`, `@topLevelAwait`, `@connect`, `@supportURL`, `@antifeature`.
- **Fixed `MenuCommandSandbox.toSource()` crash** — Every script using `GM_registerMenuCommand` was broken due to Pale Moon's SpiderMonkey decompiler. Replaced with inline source injection.
- **Fixed update checker** — GreasyFork URLs ending in `/none` and manual update checks when auto-update is disabled now work correctly.
- **GM_info expanded** — Added `script.grant`, `script.connects`, `script.homepageURL`, `script.supportURL`, `script.antifeatures`, `platform.os`, `platform.arch`.
- **Security fix** — Patched the [GM_info sandbox vulnerability](https://github.com/janekptacijarabaci/greasemonkey/issues/20) and other unreported issues.

The extension is under active development. Report bugs via the [Issues](https://github.com/SecondCityOsD/greasemonkey-for-UXP-browsers/issues) tab.

## FAQ:

1.  Why is it called "Greasemonkey for UXP"?

A: Because, unlike the old fork that was called "Greasemonkey for Pale Moon" that gave an indicator that it was being developed solely for Pale Moon, mine supports various of other browsers that are based on UXP, like Basilisk, and other forks of these 2 browsers.

2. How is it based on both Violentmonkey and the old fork of Greasemonkey?

A: I'll be doing my best on making sure it maintains the Greasemonkey UI, while it gets to be as compatible as Violentmonkey on Chrome/Firefox. There might be some UI changes, but I'll see how I'll incorporate them in the extension as how they'd be incorporated on Greasemonkey on XUL-based browsers.

3. I found an issue with your extension, how do I report it to you?

A: Report it to me either via the "Issues" tab on Github, On Pale Moon forum of username: sinfulosd, or in the private DMs. It's preferred to report security vulnerabilities in the private DMs.

4. Are you also gonna abandon us like Janekptacijarabaci did?

A: I'm not exactly sure if he abandoned the extension or something tragic has happened to him in real life. If I also stopped having any activities on any of the social media platforms I visit, you'd also have to assume the worst that might've happened to me as well. As long as I'm alive and breathing, there is still a chance for me to contribute into the extension.

5. Why did you retire the date-based naming scheme?

A: Back when I was developing it, I was using the date-based naming scheme, because I was developing it for my own use, when I was the sole tester. Then, I decided it would be smarter to send the extension to some Pale Moon users, so that the debugging process would be faster, thus making the extension enter the beta phase. I was planning to follow the semantic versioning the entire time, but I had to make it usable first.

6. Why is the first stable version of your extension is "3.4.0"?

A:...I don't think I have a proper explanation to that. I've always thought it would be really discouraging to version it as "0.1" or anything similar to it. I originally wanted to name it "4.0", but according to the [semantic versioning principle](https://semver.org/), my changes did not introduce any incompatible API changes. The old fork of Greasemonkey decided to follow its own weird semantic versioning of "3.31.4", which I didn't like at all, I don't want my extension to follow its versioning. I decided to just name it "3.4.0", something random, but not too random, that came into my mind. I just care about developing the extension to be completely stable and compatible, instead of sitting in front of my computer, thinking "What version number should my extension adapt, to sound professional".
