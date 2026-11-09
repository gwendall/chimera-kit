#!/usr/bin/env python3
"""Regenerates en.tsv: Harvard sentences and semantically unpredictable sentences (SUS).

usage: generate.py <path to a TSP sentences.tsv> <path to cmudict.txt.gz>

The Harvard lists give natural speech. SUS follow Benoit, Grice and Hazan (1996): grammatical but
meaningless, so a recognizer can't lean on context to fill in a word it did not really hear.

Splits, in the order a tuning loop may look at them:
  dev     may be read word by word. Harvard lists 1 to 6.
  held    aggregate numbers only. Harvard lists 61 to 66, which upstream's tuning never used.
  locked  for a rare, deliberate check. Harvard lists 67 to 72.
"""

import csv
import gzip
import random
import sys

NOUNS = """table window river market shadow engine garden letter pocket mirror ladder candle bridge
forest hammer basket pillow thunder button kitchen desert village ribbon jacket monkey bottle
shoulder feather kettle pencil orange tunnel cheese sugar fence stone chair judge wheel shoe dream
goat page ship thumb voice cloth badge leaf fish rope nail coin horse glass truth month wedge""".split()

ADJECTIVES = """yellow narrow gentle broken silver hollow frozen quiet bitter crooked golden heavy
sudden shallow wooden rusty thick smooth sharp brave cheap dirty fresh huge loud rich soft strange
tall weak young warm""".split()

# (base form, past tense)
TRANSITIVE = [("catch", "caught"), ("push", "pushed"), ("chase", "chased"), ("wash", "washed"),
              ("judge", "judged"), ("bend", "bent"), ("touch", "touched"), ("carry", "carried"),
              ("follow", "followed"), ("watch", "watched"), ("shake", "shook"), ("teach", "taught"),
              ("fetch", "fetched"), ("paint", "painted"), ("break", "broke"), ("taste", "tasted"),
              ("visit", "visited"), ("measure", "measured"), ("borrow", "borrowed"), ("lift", "lifted")]

INTRANSITIVE = ["slept", "laughed", "vanished", "shivered", "danced", "whispered", "stumbled",
                "wandered", "jumped", "sneezed", "trembled", "fell"]

PREPOSITIONS = ["under", "beside", "behind", "through", "over", "against", "beyond", "near"]

QUESTIONS = ["Why", "How", "When", "Where"]


def sentence(rng):
    noun = lambda: rng.choice(NOUNS)
    adj = lambda: rng.choice(ADJECTIVES)
    base, past = rng.choice(TRANSITIVE)
    template = rng.randrange(5)
    if template == 0:
        return f"The {adj()} {noun()} {rng.choice(INTRANSITIVE)} {rng.choice(PREPOSITIONS)} the {adj()} {noun()}."
    if template == 1:
        return f"The {adj()} {noun()} {past} the {noun()}."
    if template == 2:
        return f"{base.capitalize()} the {noun()} and the {adj()} {noun()}."
    if template == 3:
        return f"{rng.choice(QUESTIONS)} does the {noun()} {base} the {adj()} {noun()}?"
    return f"The {noun()} that the {noun()} {past} {rng.choice(INTRANSITIVE)}."


def unpredictable(split, seed, count):
    rng = random.Random(seed)
    seen, rows = set(), []
    while len(rows) < count:
        text = sentence(rng)
        if text not in seen:
            seen.add(text)
            rows.append((f"sus-{split}-{len(rows) + 1:03d}", "sus", split, text))
    return rows


def harvard(path):
    """Unique sentences of the TSP table, keyed by list and number."""
    found = {}
    with open(path, newline="") as f:
        for recording, _speaker, text in csv.reader(f, delimiter="\t"):
            found.setdefault(recording[2:], text)
    return found


def main():
    sentences = harvard(sys.argv[1])
    with gzip.open(sys.argv[2], "rt") as f:
        known = {line.split("\t", 1)[0].lower() for line in f}
    rows = []
    splits = {"dev": range(1, 7), "held": range(61, 67), "locked": range(67, 73)}
    for split, lists in splits.items():
        for key, text in sorted(sentences.items()):
            lst, number = key.split("_")
            if int(lst) in lists:
                rows.append((f"harvard-{lst}-{number}", "harvard", split, text))
    for split, seed in {"dev": 101, "held": 202, "locked": 303}.items():
        rows.extend(unpredictable(split, seed, 60))
    words = {w.strip(".,?!").lower() for row in rows if row[1] == "sus" for w in row[3].split()}
    missing = sorted(words - known)
    if missing:
        sys.exit(f"not in the dictionary, which would test spelling rules instead: {missing}")
    with open("eval/corpus/en.tsv", "w", newline="") as f:
        writer = csv.writer(f, delimiter="\t", lineterminator="\n", quoting=csv.QUOTE_NONE, escapechar="\\")
        writer.writerows(rows)
    print(f"{len(rows)} sentences")


main()
