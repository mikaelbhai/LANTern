"""
Draws the Uno sprite sheet.

The reference art that started this is a style reference rather than a deck:
forty-two cells against the fifty-four distinct faces a deck actually has, with
three of the four colours missing most of their numbers. Reading the numerals
off it to label the cells would have meant guessing what each card was, and a
card the game thinks is a four when it is a seven is not a cosmetic problem.

So the deck is generated. The palette is sampled from that reference and the
layout follows it — coloured body, cream oval on the diagonal, big numeral in
the body colour, small one in the corners — but every face is correct because
it is constructed rather than recognised.

The output is a sheet rather than vectors because the screen wants one texture
and a background position, not fifty-four sets of geometry. Run it with:

    python scripts/build-uno-sheet.py

and it writes src/assets/uno.png. It is committed, so this only needs running
when the deck's look changes.
"""

from PIL import Image, ImageDraw
import os

# One card on a grid this size, then scaled up. Drawing at the pixel grid and
# enlarging with nearest-neighbour is what keeps the edges square; drawing big
# and shrinking would give soft, half-lit pixels and stop it being pixel art.
W, H = 26, 37
SCALE = 4

# Sampled from the reference sheet.
BODY = {
    "red": (150, 44, 48),
    "yellow": (176, 134, 40),
    "green": (74, 116, 78),
    "blue": (40, 52, 96),
}
WILD_BODY = (18, 18, 22)
OVAL = (240, 236, 226)
EDGE = (222, 226, 232)
INNER = (150, 160, 172)
NONE = (0, 0, 0, 0)

COLOURS = ["red", "yellow", "green", "blue"]
FACES = [str(n) for n in range(10)] + ["skip", "reverse", "draw2"]

# 5x7, the same shapes the playing-card deck uses.
DIGITS = {
    "0": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
    "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
    "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
}

# 3x5, for the corners.
SMALL = {
    "0": ["111", "101", "101", "101", "111"],
    "1": ["010", "110", "010", "010", "111"],
    "2": ["111", "001", "111", "100", "111"],
    "3": ["111", "001", "111", "001", "111"],
    "4": ["101", "101", "111", "001", "001"],
    "5": ["111", "100", "111", "001", "111"],
    "6": ["111", "100", "111", "101", "111"],
    "7": ["111", "001", "010", "010", "010"],
    "8": ["111", "101", "111", "101", "111"],
    "9": ["111", "101", "111", "001", "111"],
    "+": ["000", "010", "111", "010", "000"],
    "s": ["111", "101", "101", "101", "111"],
    "r": ["010", "111", "010", "111", "010"],
}


def stamp(px, rows, ox, oy, scale, colour):
    for y, row in enumerate(rows):
        for x, cell in enumerate(row):
            if cell != "1":
                continue
            for dy in range(scale):
                for dx in range(scale):
                    p = (ox + x * scale + dx, oy + y * scale + dy)
                    if 0 <= p[0] < W and 0 <= p[1] < H:
                        px[p] = colour


def card_base(body):
    """The card itself: a rounded body with a light double edge."""
    im = Image.new("RGBA", (W, H), NONE)
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, W - 1, H - 1], radius=3, fill=EDGE)
    d.rounded_rectangle([1, 1, W - 2, H - 2], radius=3, fill=INNER)
    d.rounded_rectangle([2, 2, W - 3, H - 3], radius=2, fill=body)
    return im


def oval(im, body):
    """The cream oval, leaning the way the reference does."""
    big = Image.new("RGBA", (W * 8, H * 8), NONE)
    d = ImageDraw.Draw(big)
    d.ellipse([5 * 8, 2 * 8, (W - 5) * 8, (H - 2) * 8], fill=OVAL)
    big = big.rotate(-20, resample=Image.NEAREST, center=(W * 4, H * 4))
    # Back to the pixel grid, so the edge is a staircase and not a gradient.
    small = big.resize((W, H), Image.NEAREST)
    im.alpha_composite(small)
    return im


# The symbols are drawn rather than typed out. At the size they need to be —
# as big as the numerals, or they are a smudge in the middle of the oval — a
# hand-authored bitmap is a hundred and seventy characters of ones and zeroes
# that nobody can read or correct.
SYM = 15


def symbol_mask(kind):
    """One symbol as a mask on the pixel grid, drawn large and kept square."""
    m = Image.new("L", (SYM, SYM), 0)
    d = ImageDraw.Draw(m)

    if kind == "skip":
        # An octagon, not a circle: it is a stop sign, and at this size the
        # flat top edge is most of what tells the two apart.
        d.regular_polygon(
            (SYM // 2, SYM // 2, SYM // 2), n_sides=8, rotation=22, outline=255, width=2
        )
        d.line([3, SYM - 4, SYM - 4, 3], fill=255, width=2)
    elif kind == "reverse":
        # One arrow with a head at each end, on the diagonal. Two separate
        # arrows side by side read as the letter N at this size, which is what
        # the first attempt at this drew.
        d.line([2, SYM - 3, SYM - 3, 2], fill=255, width=2)
        d.line([SYM - 3, 2, SYM - 8, 2], fill=255, width=2)
        d.line([SYM - 3, 2, SYM - 3, 7], fill=255, width=2)
        d.line([2, SYM - 3, 7, SYM - 3], fill=255, width=2)
        d.line([2, SYM - 3, 2, SYM - 8], fill=255, width=2)
    elif kind == "draw2":
        # Two cards, one behind the other and offset the way the reference
        # stacks them.
        d.rectangle([0, 4, SYM - 7, SYM - 1], outline=255, width=2)
        d.rectangle([5, 0, SYM - 1, SYM - 6], fill=0, outline=255, width=2)
    return m


def mini_cards(im, ox, oy):
    """Four little cards fanned out, for the Wild Draw Four."""
    d = ImageDraw.Draw(im)
    order = ["blue", "red", "green", "yellow"]
    for n, name in enumerate(order):
        x = ox + n * 2
        y = oy + (n % 2) * 2
        d.rectangle([x, y, x + 4, y + 7], fill=BODY[name], outline=(20, 20, 24, 255))


def blit(im, mask, ox, oy, colour):
    """Paints a mask onto the card in one colour."""
    patch = Image.new("RGBA", mask.size, colour + (255,))
    im.paste(patch, (ox, oy), mask)


def quarters(im, ox, oy, size):
    """The four colours in a circle, for the wilds."""
    d = ImageDraw.Draw(im)
    box = [ox, oy, ox + size, oy + size]
    starts = [(180, 270), (270, 360), (0, 90), (90, 180)]
    for (a, b), name in zip(starts, ["red", "green", "yellow", "blue"]):
        d.pieslice(box, a, b, fill=BODY[name])


def corners(px, glyph, second=None):
    """The small marks in opposite corners, as the printed cards have them."""
    stamp(px, glyph, 2, 2, 1, OVAL)
    if second:
        stamp(px, second, 6, 2, 1, OVAL)
    flipped = [row[::-1] for row in reversed(glyph)]
    stamp(px, flipped, W - 5, H - 7, 1, OVAL)


def build_face(colour, face):
    body = BODY[colour]
    im = card_base(body)
    oval(im, body)
    px = im.load()

    if face.isdigit():
        stamp(px, DIGITS[face], 8, 15, 2, body)
        corners(px, SMALL[face])
    elif face in ("skip", "reverse", "draw2"):
        blit(im, symbol_mask(face), (W - SYM) // 2, 13, body)
        px = im.load()
        if face == "draw2":
            corners(px, SMALL["+"], SMALL["2"])
        else:
            corners(px, SMALL["s" if face == "skip" else "r"])
    return im


def build_wild(four):
    im = card_base(WILD_BODY)
    oval(im, WILD_BODY)
    # The plain Wild is the four colours in a circle; the Draw Four is four
    # cards, which is what the reference draws and what the card means.
    if four:
        mini_cards(im, (W - 12) // 2, 15)
    else:
        quarters(im, (W - 13) // 2, 14, 13)
    px = im.load()
    if four:
        corners(px, SMALL["+"], SMALL["4"])
    return im


def build_back():
    """The back: black, with the red oval the printed deck has."""
    im = card_base(WILD_BODY)
    oval(im, WILD_BODY)
    inner = Image.new("RGBA", (W * 8, H * 8), NONE)
    d = ImageDraw.Draw(inner)
    d.ellipse([7 * 8, 5 * 8, (W - 7) * 8, (H - 5) * 8], fill=BODY["red"])
    inner = inner.rotate(-20, resample=Image.NEAREST, center=(W * 4, H * 4))
    im.alpha_composite(inner.resize((W, H), Image.NEAREST))
    return im


def main():
    cols = len(FACES)
    rows = len(COLOURS) + 1
    sheet = Image.new("RGBA", (cols * W * SCALE, rows * H * SCALE), NONE)

    for r, colour in enumerate(COLOURS):
        for c, face in enumerate(FACES):
            card = build_face(colour, face).resize(
                (W * SCALE, H * SCALE), Image.NEAREST
            )
            sheet.paste(card, (c * W * SCALE, r * H * SCALE))

    # The wilds share the last row: plain, draw four, then the back.
    last = len(COLOURS) * H * SCALE
    for c, four in enumerate([False, True]):
        card = build_wild(four).resize((W * SCALE, H * SCALE), Image.NEAREST)
        sheet.paste(card, (c * W * SCALE, last))
    sheet.paste(build_back().resize((W * SCALE, H * SCALE), Image.NEAREST), (2 * W * SCALE, last))

    out = os.path.join("src", "assets", "uno.png")
    sheet.save(out, optimize=True)
    print(f"{out}  {sheet.size[0]}x{sheet.size[1]}  {os.path.getsize(out)} bytes")
    print(f"grid {cols} x {rows}, cell {W * SCALE} x {H * SCALE}")


if __name__ == "__main__":
    main()
