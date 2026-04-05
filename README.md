This is a fork of Greasemonkey for uxp-based browsers, based on the [upstream version of Violentmonkey](https://github.com/violentmonkey/violentmonkey) and on [JanekPtacijarabaci's version of 3.31.4](https://github.com/janekptacijarabaci/greasemonkey).


This fork was created to continue on the efforts of previous contributors and on Janek's development of the extension.

The issues that were fixed in this fork so far:
- Lack of Documentation
- Some untranslated strings
- Added GM_download / GM.download Polyfill into the extension core
- adding 8+ new APIs, further increasing the extension compatibility with modern scripts on Greasyfork and related websites
- [GM_info sandbox security vulnerability](https://github.com/janekptacijarabaci/greasemonkey/issues/20)

While the extension just got out of the beta phase, I'm still working on making it more stable. Make sure to report any bugs, whenever you encounter them.

## FAQ:

1.  Why is it called "Greasemonkey for UXP"?

A: Because, unlike the old fork that was called "Greasemonkey for Pale Moon" that gave an indicator that it was being developed solely for Pale Moon, mine supports various of other browsers that are based on UXP, like Basilisk, and other forks of these 2 browsers.

2. How is it based on both Violentmonkey and the old fork of Greasemonkey?

A: I'll be doing my best on making sure it maintains the Greasemonkey UI, while it gets to be as compatible as Violentmonkey on Chrome/Firefox. There might be some UI changes, but I'll see how I'll incorporate them in the extension as how they'd be incorporated on Greasemonkey.

3. I found an issue with your extension, how do I report it to you?

A: Report it to me either via the "Issues" tab on Github, On Pale Moon forum of username: sinfulosd, or in the private DMs. It's preferred to report security vulnerabilities in the private DMs.

4. Are you also gonna abandon us like Janekptacijarabaci did?

A: I'm not exactly sure if he abandoned the extension or something tragic has happened to him in real life. If I also stopped having any activities on any of the social media platforms I visit, you'd also have to assume the worst that might've happened to me as well. As long as I'm alive and breathing, there is still a chance for me to contribute into the extension.

5. Why did you retire the date-based naming scheme?

A: Back when I was developing it, I was using the date-based naming scheme, because I was developing it for my own use. Then, I decided it would be smarter to send the extension to some Pale Moon users, so that the debugging process would be faster, thus making the extension enter the beta phase. I was planning to name it "3.4.0" the entire time, but I had to make it usable first.
