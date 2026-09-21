"""What counts as text fit to show someone using the app.

Error messages from the API are displayed to people as they are, so they are
product copy: a sentence, written for a person, that says what happened and what
to do — and says nothing about how the software is built or deployed. These rules
are the shared definition; the unit and integration error-message tests both use it.
"""

import re

# Words that mean the message is talking about internals, not about the person's
# situation: configuration and keys, providers, frameworks, deploys, raw errors.
FORBIDDEN = (
    "api key",
    "api_key",
    "not configured",
    "missing",
    "traceback",
    "exception",
    "redeploy",
    "rebuild",
    "docker",
    "sqlalchemy",
    "psycopg",
    "openai",
    "deepgram",
    "provider",
    "uuid",
    "errno",
    "stack",
    "null",
    "undefined",
)


def assert_product_copy(text: str) -> None:
    assert text and text.strip(), "an empty error message tells the person nothing"
    assert text[0].isupper(), f"should read as a sentence (start with a capital): {text!r}"
    assert text.rstrip()[-1] in ".!?", f"should end like a sentence: {text!r}"
    lowered = text.lower()
    for word in FORBIDDEN:
        assert word not in lowered, f"{text!r} talks about internals ({word!r})"
    assert not re.search(r"\b[1-5]\d\d\b", text), f"an HTTP status code has no place in {text!r}"
    assert "./" not in text and "://" not in text, f"a path or URL has no place in {text!r}"
