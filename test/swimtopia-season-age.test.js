import test from "node:test";
import assert from "node:assert/strict";

import { swimtopiaSeasonAge } from "../server/swimtopia.js";

const seasonDate = new Date("2026-06-27T12:00:00");

function athlete(bornOn, age = 99) {
    return {
        attributes: {
            bornOn,
            age,
        },
    };
}

test("uses June 1 as the SwimTopia season age cutoff", () => {
    assert.equal(swimtopiaSeasonAge(athlete("2013-05-31"), seasonDate), 13);
    assert.equal(swimtopiaSeasonAge(athlete("2013-06-01"), seasonDate), 12);
    assert.equal(swimtopiaSeasonAge(athlete("2013-06-14"), seasonDate), 12);
});

test("matches known Parklawn examples from SwimTopia roster", () => {
    assert.equal(swimtopiaSeasonAge(athlete("2013-06-14", 13), seasonDate), 12);
    assert.equal(swimtopiaSeasonAge(athlete("2007-07-17", 18), seasonDate), 18);
});

test("falls back to SwimTopia age when bornOn is missing or invalid", () => {
    assert.equal(swimtopiaSeasonAge(athlete(null, 11), seasonDate), 11);
    assert.equal(swimtopiaSeasonAge(athlete("not-a-date", 14), seasonDate), 14);
});
