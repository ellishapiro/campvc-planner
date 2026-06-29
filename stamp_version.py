#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Cache-busting: stamp a version onto every local JS/CSS link in the HTML pages
so browsers fetch the new files instead of cached ones after a deploy.

    python stamp_version.py [version]

Default version is a UTC timestamp. Run this before each git push (it's also
safe to run repeatedly - it replaces any existing ?v=...). The HTML itself may
still be cached by GitHub Pages for a few minutes, but once a page reloads it
pulls the freshly-versioned scripts/styles immediately.
"""
import datetime
import re
import sys

HTML_FILES = ["index.html", "results.html", "booking.html"]
# match src="..." / href="..." for local .js/.css (ignore absolute http(s) urls)
PATTERN = re.compile(r'(src|href)="(?!https?:)([^"?]+\.(?:js|css))(?:\?v=[^"]*)?"')


def main():
    version = sys.argv[1] if len(sys.argv) > 1 else datetime.datetime.utcnow().strftime("%Y%m%d%H%M%S")
    for path in HTML_FILES:
        try:
            with open(path, encoding="utf-8") as f:
                html = f.read()
        except FileNotFoundError:
            continue
        new = PATTERN.sub(lambda m: '%s="%s?v=%s"' % (m.group(1), m.group(2), version), html)
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(new)
        print("stamped %s -> ?v=%s" % (path, version))
    print("done")


if __name__ == "__main__":
    main()
