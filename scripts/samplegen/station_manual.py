"""`station-manual`: a seven-page user manual for an invented home weather station.

It is the sample of Pandion's "Manuals and guides" template, so the layout gives
each of that template's settings something to do:

* numbered headings four levels deep (1, 1.2, 1.2.1 and a few 2.2.1.1), each level
  bold and one size smaller than the one above, so `heading_hierarchy` can tell
  the levels apart;
* subsections that share a title or a sentence under different parents (two
  "Choosing the threshold", two battery sections that both start "This part
  takes"), so an answer only makes sense with its heading path;
* one ruled table of display settings, for `do_table_structure`;
* a running header and a "Page N of M" footer, which `content_layers: [body]`
  should leave out;
* one safety warning printed word for word at the foot of every page's body,
  which `dedupe_blocks` should keep only once.
"""

from __future__ import annotations

from scripts.samplegen.pdfwriter import Document, Page

NAME = "station-manual"

MARGIN = 72
TOP = 720

#: (font resource, size, leading, wrap width in characters)
TITLE = ("F2", 22, 28, 50)
H1 = ("F2", 17, 22, 60)
H2 = ("F2", 14, 19, 70)
H3 = ("F2", 13, 17, 76)
H4 = ("F2", 12, 16, 80)
BODY = ("F1", 11, 15, 88)
WARN = ("F1", 10, 13, 96)
FURNITURE = ("F1", 9, 11, 100)
CELL = ("F1", 10, 0, 0)
CELL_HEAD = ("F2", 10, 0, 0)

HEADER_TEXT = "Skylark WS-3 Home Weather Station: User Manual"

WARNING = (
    "WARNING: Never mount the outdoor sensor during a storm, and never climb a ladder "
    "in high wind. Keep the mounting pole at least 3 metres away from overhead power lines."
)

#: The settings table, header row first.
TABLE = [
    ["Setting", "Choices", "Default"],
    ["Temperature unit", "Celsius, Fahrenheit", "Celsius"],
    ["Wind speed unit", "km/h, m/s, mph, knots", "km/h"],
    ["Rain unit", "mm, inches", "mm"],
    ["Pressure unit", "hPa, inHg", "hPa"],
    ["Backlight", "Off, Low, High", "Low"],
    ["Time format", "12 hour, 24 hour", "24 hour"],
]
TABLE_COLS = [150, 180, 110]
TABLE_ROW_H = 20

#: Each page is a list of (style, text) blocks in reading order; style None is the table.
PAGES: list[list[tuple[tuple | None, str]]] = [
    [
        (TITLE, "Skylark WS-3 Home Weather Station"),
        (
            BODY,
            "This manual explains how to set up, use and look after the Skylark WS-3. The "
            "station has an outdoor sensor that measures temperature, humidity, wind and rain, "
            "and an indoor display that shows the readings and sounds the alarms. Read each "
            "section before you start, and keep the manual near the display.",
        ),
        (H1, "1 Getting started"),
        (H2, "1.1 What is in the box"),
        (
            BODY,
            "The box holds the outdoor sensor, the indoor display, a mounting pole in two parts, "
            "four screws with wall plugs, a set of bird spikes, a USB cable and a small brush for "
            "the rain funnel. Batteries are not included.",
        ),
        (H2, "1.2 Choosing a place"),
        (
            BODY,
            "Where you put the two parts decides how good the readings are and how well they "
            "talk to each other. Choose both places before you drill any holes.",
        ),
        (H3, "1.2.1 Outdoor sensor"),
        (
            BODY,
            "Mount the outdoor sensor at least 1.5 metres above the ground, on a pole or post "
            "away from walls and trees. A wall that faces the sun warms the air around it and "
            "makes the temperature read high, and a tree shelters the wind cups.",
        ),
        (H3, "1.2.2 Indoor display"),
        (
            BODY,
            "Place the indoor display within 100 metres of the sensor in open air, or within "
            "30 metres when there are walls between them. Keep it at least one metre away from "
            "a television, a microwave oven or a wireless router, which can block the signal.",
        ),
    ],
    [
        (H1, "2 Setting up"),
        (H2, "2.1 Pairing the sensor"),
        (H3, "2.1.1 First pairing"),
        (
            BODY,
            "Put the batteries in the outdoor sensor first and in the display second. The "
            "display searches for three minutes and shows a steady aerial symbol when it has "
            "found the sensor.",
        ),
        (H3, "2.1.2 Adding a second sensor"),
        (
            BODY,
            "Press and hold the CHANNEL button on the display for five seconds until the channel "
            "number flashes, then press the small RESET button inside the battery cover of the "
            "new sensor. The display gives it the next free channel, up to channel 3.",
        ),
        (H2, "2.2 Setting the alarms"),
        (
            BODY,
            "Each alarm watches one reading and sounds when that reading crosses its threshold. "
            "Press ALARM to choose an alarm, then press the up and down buttons to change its "
            "threshold.",
        ),
        (H3, "2.2.1 Frost alarm"),
        (
            BODY,
            "This alarm sounds when the outdoor temperature falls to the threshold or below.",
        ),
        (H4, "2.2.1.1 Choosing the threshold"),
        (
            BODY,
            "For most gardens, set this threshold to 4, which leaves you time to cover young "
            "plants before the night gets any colder. A higher value sounds the alarm on many "
            "nights that turn out to be mild.",
        ),
    ],
    [
        (H3, "2.2.2 Wind alarm"),
        (
            BODY,
            "This alarm watches the strongest gust in the last ten minutes, counted on the "
            "Beaufort scale from 0 to 12. A flag symbol shows while it is on.",
        ),
        (H4, "2.2.2.1 Choosing the threshold"),
        (
            BODY,
            "For most homes, set this threshold to 4, which leaves you time to bring in light "
            "garden furniture before the weather gets any worse. A lower value sounds the alarm "
            "on most breezy afternoons.",
        ),
        (H1, "3 Display settings"),
        (
            BODY,
            "The table below lists the settings you can change from the display. Hold the SET "
            "button for three seconds to open the settings, then press SET again to move to the "
            "next one.",
        ),
        (None, "table"),
        (
            BODY,
            "Your choices are kept when you change the batteries in the display, but a reset "
            "brings back the defaults shown in the table.",
        ),
    ],
    [
        (H2, "3.1 Calibrating the readings"),
        (
            BODY,
            "The station is checked before it leaves the factory, but your site may still differ "
            "a little from a nearby weather report. Two readings can be adjusted.",
        ),
        (H3, "3.1.1 Pressure"),
        (
            BODY,
            "To match your local weather report, open the settings, go to Pressure offset, and "
            "add or take away up to 20 hPa. The station then adds the same offset to every "
            "pressure reading it shows.",
        ),
        (H3, "3.1.2 Rain"),
        (
            BODY,
            "If the rain total reads too low next to a standard rain gauge, first check that the "
            "funnel is level. The rain factor can be set from 0.8 to 1.2 in steps of 0.05, and "
            "every rain reading is multiplied by it.",
        ),
        (H1, "4 Care and maintenance"),
        (H2, "4.1 Cleaning"),
        (H3, "4.1.1 Rain funnel"),
        (
            BODY,
            "Clean it once a month in autumn, when falling leaves can block it. Lift it off, "
            "brush out the mesh with the brush from the box, and rinse it in clean water "
            "before you put it back.",
        ),
        (H3, "4.1.2 Solar panel"),
        (
            BODY,
            "Wipe it with a damp cloth every three months. It powers a small fan that keeps air "
            "moving past the temperature probe, so a dirty panel makes the temperature read high "
            "on sunny days.",
        ),
    ],
    [
        (H2, "4.2 Batteries"),
        (H3, "4.2.1 Outdoor sensor"),
        (
            BODY,
            "This part takes two AA lithium batteries, which keep working down to minus 20 "
            "degrees Celsius. Ordinary alkaline batteries stop working well below freezing.",
        ),
        (H4, "4.2.1.1 Changing them in winter"),
        (
            BODY,
            "Bring the sensor indoors for an hour before you open it, so that no damp, cold air "
            "is sealed inside with the new batteries. Close the cover firmly before you take it "
            "back outside.",
        ),
        (H3, "4.2.2 Indoor display"),
        (
            BODY,
            "This part takes three AAA alkaline batteries, or it can run from the USB cable in "
            "the box. A battery symbol shows when about two weeks of power are left.",
        ),
    ],
    [
        (H1, "5 Troubleshooting"),
        (H2, "5.1 No reading from the sensor"),
        (H3, "5.1.1 Dashes on the display"),
        (
            BODY,
            "Dashes in place of a reading mean the display has lost the sensor for more than "
            "fifteen minutes. Move the display closer to the sensor, then hold the down button "
            "for three seconds to search again.",
        ),
        (H3, "5.1.2 Readings stop on cold nights"),
        (
            BODY,
            "If the readings stop on the coldest nights and come back in the morning, the sensor "
            "probably holds alkaline batteries. Replace them with lithium batteries, as section "
            "4.2.1 describes.",
        ),
        (H2, "5.2 Wrong readings"),
        (H3, "5.2.1 Temperature too high"),
        (
            BODY,
            "A temperature that reads several degrees too high on sunny afternoons usually means "
            "the sensor gets direct sun or heat from a wall. Move it into open air, and check that "
            "the solar fan turns.",
        ),
        (H3, "5.2.2 Rain total too high"),
        (
            BODY,
            "A rain total that grows on dry days usually comes from birds landing on the funnel "
            "or from wind shaking the post. Fit the bird spikes from the box, and make sure the "
            "post does not move.",
        ),
        (H2, "5.3 Resetting the station"),
        (
            BODY,
            "Take the batteries out of both parts, wait one minute, then put them back in the "
            "sensor first. A reset clears the rain total and the highest and lowest readings, "
            "and it brings back every default in the settings table.",
        ),
    ],
    [
        (H1, "6 Specifications and warranty"),
        (H2, "6.1 Specifications"),
        (H3, "6.1.1 Measuring ranges"),
        (
            BODY,
            "The outdoor sensor measures temperature from minus 40 to 60 degrees Celsius, "
            "humidity from 1 to 99 percent, and wind speed up to 180 kilometres an hour.",
        ),
        (H3, "6.1.2 Radio"),
        (
            BODY,
            "The sensor sends a new set of readings every 48 seconds on the 868 MHz band, "
            "which passes through walls better than the 2.4 GHz band used by most routers.",
        ),
        (H2, "6.2 Warranty"),
        (
            BODY,
            "The Skylark WS-3 has a two-year warranty from the date of purchase. Keep your "
            "receipt, because the warranty does not cover a station without proof of when it "
            "was bought.",
        ),
        (
            BODY,
            "The warranty does not cover damage from lightning, from a fall, or from water that "
            "got in because the battery cover was left open.",
        ),
    ],
]


def _page(blocks: list[tuple[tuple | None, str]], number: int, total: int) -> Page:
    page = Page()
    y = TOP
    for style, text in blocks:
        if style is None:
            y = page.cell_grid(MARGIN, y, TABLE_COLS, TABLE_ROW_H, TABLE, CELL, CELL_HEAD) - 14
            continue
        if style[0] == "F2" and y != TOP:
            y -= 8  # extra space above a heading
        y = page.wrap(style, text, MARGIN, y)
        y -= 9  # paragraph gap
    y = page.wrap(WARN, WARNING, MARGIN, y - 10)
    if y < 70:
        raise ValueError(f"page {number} overflows into the footer")
    font, size, _, _ = FURNITURE
    page.text(font, size, MARGIN, 760, HEADER_TEXT)
    page.text(font, size, MARGIN, 40, f"Page {number} of {total}")
    return page


def build() -> bytes:
    total = len(PAGES)
    return Document([_page(blocks, n, total) for n, blocks in enumerate(PAGES, start=1)]).build()
