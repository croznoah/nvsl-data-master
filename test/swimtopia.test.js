import assert from "node:assert/strict";
import test from "node:test";
import {
    bearerValue,
    buildSwimtopiaProbePlan,
    getParklawnSwimtopiaLadder,
    getParklawnSwimmerHistory,
    normalizeMeetLabel,
    PARKLAWN_SWIMTOPIA_ORG_ID,
    probeSwimtopiaApi,
    redactToken,
    serializeParams,
    summarizeJsonApiPayload,
    swimtopiaApiFetch,
    swimtopiaPasswordLogin,
} from "../server/swimtopia.js";

function jsonResponse(body, init = {}) {
    return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "content-type": "application/json" },
    });
}

test("swimtopiaPasswordLogin posts OAuth password grant form data", async () => {
    let captured;
    const fetchImpl = async (url, options) => {
        captured = { url, options };
        return jsonResponse({
            access_token: "abc123",
            refresh_token: "refresh123",
            token_type: "Bearer",
        });
    };

    const token = await swimtopiaPasswordLogin({
        username: "coach@example.com",
        password: "secret",
        fetchImpl,
    });

    assert.equal(captured.url, "https://mobile-api.swimtopia.com/oauth/token");
    assert.equal(captured.options.method, "POST");
    assert.equal(captured.options.headers["Content-Type"], "application/x-www-form-urlencoded");
    assert.equal(captured.options.body.get("grant_type"), "password");
    assert.equal(captured.options.body.get("username"), "coach@example.com");
    assert.equal(captured.options.body.get("password"), "secret");
    assert.equal(token.access_token, "abc123");
});

test("swimtopiaPasswordLogin surfaces API errors", async () => {
    await assert.rejects(
        () => swimtopiaPasswordLogin({
            username: "coach@example.com",
            password: "bad",
            fetchImpl: async () => jsonResponse({ error_description: "Invalid credentials" }, { status: 401 }),
        }),
        /Invalid credentials/
    );
});

test("swimtopiaApiFetch applies bearer auth and serializes params", async () => {
    let captured;
    const fetchImpl = async (url, options) => {
        captured = { url: String(url), options };
        return jsonResponse({ data: [] });
    };

    await swimtopiaApiFetch("/mobile/historical-results", {
        token: "abc123",
        params: {
            "filter[best_times_only]": true,
            include: ["athlete", "swimMeet"],
        },
        fetchImpl,
    });

    assert.match(captured.url, /^https:\/\/mobile-api\.swimtopia\.com\/mobile\/historical-results\?/);
    assert.match(captured.url, /filter%5Bbest_times_only%5D=true/);
    assert.match(captured.url, /include=athlete/);
    assert.match(captured.url, /include=swimMeet/);
    assert.equal(captured.options.headers.Authorization, "Bearer abc123");
});

test("summarizeJsonApiPayload reports primary and included record shapes", () => {
    const summary = summarizeJsonApiPayload({
        data: [{
            type: "historical-results",
            id: "1",
            attributes: { distance: 50, officialTimeInt: 3012 },
            relationships: { athlete: { data: { type: "organization-users", id: "7" } } },
        }],
        included: [{ type: "organization-users", id: "7", attributes: { firstName: "Ava" } }],
    });

    assert.deepEqual(summary, {
        primaryCount: 1,
        includedCount: 1,
        types: {
            "historical-results": 1,
            "organization-users": 1,
        },
        firstRecord: {
            type: "historical-results",
            id: "1",
            attributeKeys: ["distance", "officialTimeInt"],
            relationshipKeys: ["athlete"],
        },
    });
});

test("probe plan includes organization-specific endpoints when requested", () => {
    const plan = buildSwimtopiaProbePlan({
        organizationId: "123",
        today: new Date("2026-06-23T12:00:00Z"),
    });

    assert.ok(plan.some((item) => item.path === "/mobile/organizations/123"));
    assert.ok(plan.some((item) => item.path === "/mobile/organizations/123/organization-users"));
    assert.ok(plan.some((item) => item.path === "/mobile/historical-results"));
    assert.ok(plan.find((item) => item.key === "swimMeets").params["filter[year]"] === 2026);
});

test("probe plan defaults to Parklawn's SwimTopia organization", () => {
    const plan = buildSwimtopiaProbePlan({ today: new Date("2026-06-23T12:00:00Z") });

    assert.equal(PARKLAWN_SWIMTOPIA_ORG_ID, "27626");
    assert.ok(plan.some((item) => item.path === "/mobile/organizations/27626"));
    assert.ok(plan.some((item) => item.path === "/mobile/organizations/27626/organization-users"));
});

test("probeSwimtopiaApi returns mixed success and failure summaries", async () => {
    const results = await probeSwimtopiaApi({
        token: "abc123",
        organizationId: "123",
        fetchImpl: async (url) => {
            if (String(url).includes("organization-users")) {
                return jsonResponse({ error: "Forbidden" }, { status: 403 });
            }
            return jsonResponse({ data: [{ type: "ok-records", id: "1" }] });
        },
    });

    assert.equal(results.some((result) => result.ok), true);
    assert.equal(results.some((result) => result.ok === false && result.status === 403), true);
});

test("token helpers normalize and redact bearer values", () => {
    assert.equal(bearerValue("abc"), "Bearer abc");
    assert.equal(bearerValue("Bearer abc"), "Bearer abc");
    assert.equal(redactToken("abcdefghijklmnopqrstuvwxyz"), "abcdefgh...[redacted]...uvwxyz");
});

test("serializeParams skips empty values", () => {
    assert.equal(
        serializeParams({ a: 1, b: "", c: null, d: undefined, e: ["x", "y"] }),
        "a=1&e=x&e=y"
    );
});

test("getParklawnSwimtopiaLadder normalizes roster, times, meet, and availability", async () => {
    const responses = new Map([
        ["/mobile/organizations/27626/organization-users", {
            data: [{
                type: "organizationUser",
                id: "athlete-1",
                attributes: {
                    bornOn: "2015-01-01",
                    firstName: "Ava",
                    lastName: "Lane",
                    gender: "F",
                    age: 11,
                    hasSwimHistory: true,
                },
            }],
            included: [{
                type: "athleteAffiliation",
                id: "aff-1",
                attributes: { isActive: true, isCurrent: true },
                relationships: {
                    organizationUser: { data: { type: "organizationUser", id: "athlete-1" } },
                },
            }],
            meta: { count: 1 },
        }],
        ["/mobile/organizations/27626/calendar-events", {
            data: [{
                type: "calendarEvent",
                id: "meet-1",
                attributes: {
                    name: "A Meet",
                    startAt: "2026-06-27T09:00:00.000-04:00",
                    startDate: "2026-06-27",
                    stiType: "SwimMeet",
                    stage: "pre-meet",
                },
            }],
            meta: { count: 1 },
        }],
        ["/mobile/swim-meets/meet-1/swim-absences", {
            data: [{
                type: "swimAbsence",
                id: "absence-1",
                attributes: { isAttending: false },
                relationships: {
                    athlete: { data: { type: "organizationUser", id: "athlete-1" } },
                },
            }],
            meta: { count: 1 },
        }],
        ["/mobile/organizations/27626/users/athlete-1/historical-results", {
            data: [
                {
                    type: "historicalResult",
                    id: "result-1",
                    attributes: {
                        completedOn: "2026-06-20",
                        distance: 50,
                        officialTimeInt: 3012,
                        strokeCode: 1,
                    },
                },
                {
                    type: "historicalResult",
                    id: "result-2",
                    attributes: {
                        completedOn: "2025-06-20",
                        distance: 25,
                        officialTimeInt: 1410,
                        strokeCode: 1,
                    },
                },
                {
                    type: "historicalResult",
                    id: "result-3",
                    attributes: {
                        completedOn: "2026-06-13",
                        distance: 25,
                        officialTimeInt: 1644,
                        strokeCode: 2,
                    },
                },
            ],
            meta: { count: 1 },
        }],
    ]);

    const payload = await getParklawnSwimtopiaLadder({
        token: "abc123",
        today: new Date("2026-06-23T12:00:00-04:00"),
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            const body = responses.get(parsed.pathname);
            assert.ok(body, `Unexpected path ${parsed.pathname}`);
            assert.equal(parsed.searchParams.get("page[offset]") || "0", "0");
            return jsonResponse(body);
        },
    });

    assert.equal(payload.meet.id, "meet-1");
    assert.deepEqual(payload.unavailable, ["avalane"]);
    assert.equal(payload.stats.athletes, 1);
    assert.equal(payload.stats.resultEntries, 2);
    assert.deepEqual(payload.ladder.Girls["11"].Freestyle["50"][0], [
        "30.12",
        "Ava Lane",
        11,
        "athlete-1",
        "2026-06-20",
        {},
        2026,
        "PL",
        false,
        "",
    ]);
    assert.equal(payload.ladder.Girls["11"].Freestyle["25"], undefined);
    assert.deepEqual(payload.ladder.Girls["11"].Backstroke["25"][0], [
        "16.44",
        "Ava Lane",
        11,
        "athlete-1",
        "2026-06-13",
        {},
        2026,
        "PL",
        false,
        "",
    ]);
});

test("getParklawnSwimmerHistory returns all SwimTopia history with meet labels", async () => {
    const responses = new Map([
        ["/mobile/organizations/27626/organization-users", {
            data: [{
                type: "organizationUser",
                id: "athlete-1",
                attributes: {
                    bornOn: "2015-01-01",
                    firstName: "Ava",
                    lastName: "Lane",
                    gender: "F",
                    age: 11,
                },
            }],
            included: [],
            meta: { count: 1 },
        }],
        ["/mobile/organizations/27626/users/athlete-1/historical-results", {
            data: [
                {
                    type: "historicalResult",
                    id: "result-1",
                    attributes: {
                        completedOn: "2026-06-20",
                        distance: 50,
                        officialTimeInt: 3012,
                        strokeCode: 1,
                        age: 11,
                    },
                    relationships: {
                        swimMeet: { data: { type: "swimMeet", id: "meet-1" } },
                    },
                },
                {
                    type: "historicalResult",
                    id: "result-2",
                    attributes: {
                        completedOn: "2026-06-13",
                        distance: 25,
                        officialTimeInt: 1644,
                        strokeCode: 2,
                        age: 11,
                    },
                    relationships: {
                        swimMeet: { data: { type: "swimMeet", id: "meet-2" } },
                    },
                },
                {
                    type: "historicalResult",
                    id: "result-3",
                    attributes: {
                        completedOn: "2026-07-18",
                        distance: 50,
                        officialTimeInt: 2966,
                        strokeCode: 1,
                        age: 11,
                    },
                    relationships: {
                        swimMeet: { data: { type: "swimMeet", id: "meet-3" } },
                    },
                },
                {
                    type: "historicalResult",
                    id: "result-4",
                    attributes: {
                        completedOn: "2025-06-13",
                        distance: 25,
                        officialTimeInt: 1410,
                        strokeCode: 1,
                        age: 10,
                    },
                    relationships: {
                        swimMeet: { data: { type: "swimMeet", id: "meet-4" } },
                    },
                },
            ],
            included: [
                { type: "swimMeet", id: "meet-1", attributes: { name: "A Meet at Ravensworth" } },
                { type: "swimMeet", id: "meet-2", attributes: { name: "Time Trials" } },
                { type: "swimMeet", id: "meet-3", attributes: { name: "Divisional Individual Championships" } },
                { type: "swimMeet", id: "meet-4", attributes: { name: "A-Meet Fox Hunt at Parklawn" } },
            ],
            meta: { count: 4 },
        }],
    ]);

    const payload = await getParklawnSwimmerHistory({
        token: "abc123",
        athleteId: "athlete-1",
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            const body = responses.get(parsed.pathname);
            assert.ok(body, `Unexpected path ${parsed.pathname}`);
            if (parsed.pathname.includes("historical-results")) {
                assert.equal(parsed.searchParams.has("filter[best_times_only]"), false);
                assert.match(parsed.searchParams.get("include"), /swimMeet/);
            }
            return jsonResponse(body);
        },
    });

    assert.equal(payload.swimmer.name, "Ava Lane");
    assert.equal(payload.stats.resultEntries, 3);
    assert.equal(payload.stats.rawResultEntries, 4);
    assert.deepEqual(payload.history.map((entry) => entry.meet), ["Divisionals", "A Meet", "Time Trials"]);
    assert.deepEqual(payload.history.map((entry) => entry.distance), [50, 50, 25]);
    assert.deepEqual(payload.history.map((entry) => entry.time), ["29.66", "30.12", "16.44"]);
});

test("getParklawnSwimmerHistory retries when meet include is unavailable", async () => {
    let historyRequests = 0;
    const payload = await getParklawnSwimmerHistory({
        token: "abc123",
        athleteId: "athlete-1",
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            if (parsed.pathname.endsWith("/organization-users")) {
                return jsonResponse({
                    data: [{
                        type: "organizationUser",
                        id: "athlete-1",
                        attributes: {
                            bornOn: "2015-01-01",
                            firstName: "Ava",
                            lastName: "Lane",
                            gender: "F",
                            age: 11,
                        },
                    }],
                    included: [],
                    meta: { count: 1 },
                });
            }

            historyRequests++;
            if (parsed.searchParams.has("include")) {
                return jsonResponse({ error: "Bad include" }, { status: 400 });
            }
            return jsonResponse({
                data: [{
                    type: "historicalResult",
                    id: "result-1",
                    attributes: {
                        completedOn: "2026-06-20",
                        distance: 50,
                        officialTimeInt: 3012,
                        strokeCode: 1,
                        meetName: "B Meet",
                    },
                }],
                included: [],
                meta: { count: 1 },
            });
        },
    });

    assert.equal(historyRequests, 2);
    assert.equal(payload.history[0].meet, "B Meet");
});

test("normalizeMeetLabel simplifies common Parklawn meet names", () => {
    assert.equal(normalizeMeetLabel("A Meet at Rolling Hills"), "A Meet");
    assert.equal(normalizeMeetLabel("A-Meet Fox Hunt at Parklawn"), "A Meet");
    assert.equal(normalizeMeetLabel("Home A Meet vs. Rolling Forest"), "A Meet");
    assert.equal(normalizeMeetLabel("NVSL A-Meet IC@PL"), "A Meet");
    assert.equal(normalizeMeetLabel("B meet at North Springfield"), "B Meet");
    assert.equal(normalizeMeetLabel("B-Meet SHRA at Parklawn"), "B Meet");
    assert.equal(normalizeMeetLabel("Divisional Individual Championships"), "Divisionals");
    assert.equal(normalizeMeetLabel("NVSL Div 15 Individual Championships"), "Divisionals");
    assert.equal(normalizeMeetLabel("Time Trials TT@PL"), "Time Trials");
    assert.equal(normalizeMeetLabel("Time Trials TT@PL 06-16-2018"), "Time Trials");
    assert.equal(normalizeMeetLabel("Relay Meet PL@SH"), "Relay Meet");
    assert.equal(normalizeMeetLabel("B-Meet FH/HH@PL"), "B Meet");
});
