export const SWIMTOPIA_API_BASE = "https://mobile-api.swimtopia.com";
export const SWIMTOPIA_MOBILE_USER_AGENT = "SwimTopiaMobile/6.6.0";
export const PARKLAWN_SWIMTOPIA_ORG_ID = "27626";
export const PARKLAWN_TEAM_ABBR = "PL";

const STROKE_BY_CODE = {
    1: "Freestyle",
    6: "Freestyle",
    2: "Backstroke",
    12: "Backstroke",
    3: "Breaststroke",
    13: "Breaststroke",
    4: "Butterfly",
    14: "Butterfly",
};

const JSON_API_ACCEPT = "application/vnd.api+json";

function jsonHeaders(extra = {}) {
    return {
        "Accept": JSON_API_ACCEPT,
        "Content-Type": JSON_API_ACCEPT,
        "User-Agent": SWIMTOPIA_MOBILE_USER_AGENT,
        ...extra,
    };
}

function formHeaders(extra = {}) {
    return {
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": SWIMTOPIA_MOBILE_USER_AGENT,
        ...extra,
    };
}

export function bearerValue(value) {
    const token = String(value || "").trim();
    if (!token) return "";
    return token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`;
}

export function redactToken(token) {
    const value = String(token || "");
    if (value.length <= 14) return "[redacted]";
    return `${value.slice(0, 8)}...[redacted]...${value.slice(-6)}`;
}

async function parseResponseBody(response) {
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    if (!text) return null;
    if (contentType.includes("json")) {
        return JSON.parse(text);
    }
    return text;
}

export function serializeParams(params = {}) {
    const search = new URLSearchParams();
    for (const [key, rawValue] of Object.entries(params)) {
        if (rawValue === undefined || rawValue === null || rawValue === "") continue;
        if (Array.isArray(rawValue)) {
            for (const value of rawValue) {
                search.append(key, value);
            }
        } else {
            search.set(key, rawValue);
        }
    }
    return search.toString();
}

function secondsFromTimeInt(timeInt) {
    const value = Number(timeInt);
    return Number.isFinite(value) && value > 0 ? value / 100 : null;
}

function formatTimeInt(timeInt) {
    const seconds = secondsFromTimeInt(timeInt);
    if (seconds === null) return "";
    const centiseconds = Math.round(seconds * 100);
    const minutes = Math.floor(centiseconds / 6000);
    const remainingSeconds = Math.floor((centiseconds % 6000) / 100);
    const hundredths = centiseconds % 100;
    if (minutes > 0) {
        return `${minutes}:${String(remainingSeconds).padStart(2, "0")}.${String(hundredths).padStart(2, "0")}`;
    }
    return `${remainingSeconds}.${String(hundredths).padStart(2, "0")}`;
}

function parseTimeSeconds(timeString) {
    const parts = String(timeString || "").split(":").map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return Infinity;
    return parts.reverse().reduce((total, value, index) => total + value * Math.pow(60, index), 0);
}

function nameKey(name) {
    return String(name || "").toLowerCase().replace(/\s/g, "");
}

function athleteName(attributes = {}) {
    const firstName = attributes.preferredFirstName || attributes.firstName || "";
    const lastName = attributes.lastName || "";
    return `${firstName} ${lastName}`.trim();
}

function ladderGender(swimtopiaGender) {
    return swimtopiaGender === "F" ? "Girls" : "Boys";
}

export function swimtopiaSeasonAge(athlete, today = new Date()) {
    const attrs = athlete?.attributes || {};
    const bornOn = attrs.bornOn;
    if (bornOn) {
        const birthDate = new Date(`${bornOn}T00:00:00`);
        if (!Number.isNaN(birthDate.getTime())) {
            const seasonYear = today.getFullYear();
            const turnsThisYear = new Date(seasonYear, birthDate.getMonth(), birthDate.getDate());
            let age = seasonYear - birthDate.getFullYear();
            if (turnsThisYear >= new Date(seasonYear, 5, 1)) age--;
            return age;
        }
    }

    const age = Number(attrs.age);
    return Number.isFinite(age) ? age : null;
}

function isCurrentAthlete(user, affiliationsByUser, today = new Date()) {
    const attrs = user?.attributes || {};
    const age = swimtopiaSeasonAge(user, today);
    if (!attrs.bornOn || !Number.isFinite(age) || age < 5 || age > 18) return false;
    return (affiliationsByUser.get(user.id) || []).some((affiliation) =>
        affiliation.attributes?.isActive &&
        affiliation.attributes?.isCurrent &&
        affiliation.type === "athleteAffiliation"
    );
}

function addLadderEntry(ladder, athlete, result, today = new Date()) {
    const attrs = result.attributes || {};
    const stroke = STROKE_BY_CODE[Number(attrs.strokeCode)];
    const distance = Number(attrs.distance);
    const time = formatTimeInt(attrs.officialTimeInt);
    const age = swimtopiaSeasonAge(athlete, today);
    const gender = ladderGender(athlete.attributes.gender);
    const name = athleteName(athlete.attributes);
    const completedOn = attrs.completedOn || "";
    const entryYear = completedOn ? new Date(completedOn).getFullYear() : new Date().getFullYear();

    if (!stroke || ![25, 50].includes(distance) || !time || !name || !Number.isFinite(age)) return false;

    ladder[gender][age] ??= {};
    ladder[gender][age][stroke] ??= {};
    ladder[gender][age][stroke][distance] ??= [];

    const entries = ladder[gender][age][stroke][distance];
    const entry = [time, name, age, athlete.id, completedOn, {}, entryYear, PARKLAWN_TEAM_ABBR, false, ""];
    const existingIndex = entries.findIndex((item) => nameKey(item[1]) === nameKey(name));

    if (existingIndex === -1) {
        entries.push(entry);
        return true;
    }

    if (secondsFromTimeInt(attrs.officialTimeInt) < parseTimeSeconds(entries[existingIndex][0])) {
        entries[existingIndex] = entry;
    }
    return false;
}

function recordRelationshipId(record, names) {
    for (const name of names) {
        const id = record.relationships?.[name]?.data?.id;
        if (id) return id;
    }
    return null;
}

function meetLabel(meet) {
    const attrs = meet?.attributes || {};
    return attrs.name || attrs.title || attrs.label || "";
}

export function normalizeMeetLabel(label) {
    const value = String(label || "").trim();
    if (!value) return "";

    const cleaned = value
        .replace(/\s+\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/g, "")
        .replace(/\s+\b[A-Z]{1,5}(?:\/[A-Z]{1,5})?@[A-Z]{1,5}\b$/gi, "")
        .trim();
    const normalized = cleaned.toLowerCase();
    if (normalized.includes("divisional") || /(^|\s)div\s*\d*\s+individual championships?/.test(normalized)) {
        return "Divisionals";
    }
    if (/\ba[\s-]*meet\b/.test(normalized) || /\bnvsl\s+a[\s-]*meet\b/.test(normalized) || /\bhome\s+a\s+meet\b/.test(normalized) || /\baway\s+a[\s-]*meet\b/.test(normalized)) {
        return "A Meet";
    }
    if (/\bb[\s-]*meet\b/.test(normalized)) {
        return "B Meet";
    }
    return cleaned || value;
}

function resultMeetLabel(result, includedById) {
    const attrs = result.attributes || {};
    const directLabel = attrs.meetName || attrs.swimMeetName || attrs.eventName || attrs.meetTitle || "";
    if (directLabel) return normalizeMeetLabel(directLabel);

    const meetId = recordRelationshipId(result, ["swimMeet", "meet", "calendarEvent", "event"]);
    return normalizeMeetLabel(meetLabel(includedById.get(meetId)));
}

function resultAge(result, athlete) {
    const attrs = result.attributes || {};
    const age = Number(attrs.age || attrs.swimmerAge || attrs.ageAtMeet);
    if (Number.isFinite(age)) return age;

    const completedOn = attrs.completedOn || "";
    const bornOn = athlete?.attributes?.bornOn || "";
    if (completedOn && bornOn) {
        const completedDate = new Date(completedOn);
        const bornDate = new Date(bornOn);
        let computedAge = completedDate.getFullYear() - bornDate.getFullYear();
        const birthdayThisYear = new Date(completedDate.getFullYear(), bornDate.getMonth(), bornDate.getDate());
        if (completedDate < birthdayThisYear) computedAge--;
        if (Number.isFinite(computedAge)) return computedAge;
    }

    const currentAge = Number(athlete?.attributes?.age);
    if (Number.isFinite(currentAge)) return currentAge;
    return null;
}

function highestDistanceResultsByStroke(results) {
    const highestDistanceByStroke = new Map();
    for (const result of results || []) {
        const stroke = STROKE_BY_CODE[Number(result.attributes?.strokeCode)];
        const distance = Number(result.attributes?.distance);
        if (!stroke || ![25, 50].includes(distance)) continue;
        highestDistanceByStroke.set(stroke, Math.max(highestDistanceByStroke.get(stroke) || 0, distance));
    }
    return (results || []).filter((result) => {
        const stroke = STROKE_BY_CODE[Number(result.attributes?.strokeCode)];
        const distance = Number(result.attributes?.distance);
        return stroke && distance === highestDistanceByStroke.get(stroke);
    });
}

async function paginatedSwimtopiaFetch(pathname, {
    token,
    params = {},
    limit = 100,
    fetchImpl = fetch,
} = {}) {
    const data = [];
    const included = [];
    let meta = null;

    for (let offset = 0; ; offset += limit) {
        const payload = await swimtopiaApiFetch(pathname, {
            token,
            params: {
                ...params,
                "page[offset]": offset,
                "page[limit]": limit,
            },
            fetchImpl,
        });
        const pageData = Array.isArray(payload.data) ? payload.data : (payload.data ? [payload.data] : []);
        data.push(...pageData);
        if (Array.isArray(payload.included)) included.push(...payload.included);
        meta = payload.meta || meta;

        if (pageData.length < limit || data.length >= (payload.meta?.count || Infinity)) {
            break;
        }
    }

    return { data, included, meta };
}

function pickUpcomingMeet(events, today = new Date()) {
    const startOfToday = new Date(today);
    startOfToday.setHours(0, 0, 0, 0);
    return events
        .filter((event) => event.attributes?.stiType === "SwimMeet")
        .filter((event) => new Date(event.attributes.startAt || event.attributes.startDate) >= startOfToday)
        .sort((a, b) => new Date(a.attributes.startAt || a.attributes.startDate) - new Date(b.attributes.startAt || b.attributes.startDate))[0] || null;
}

async function mapLimit(items, limit, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await mapper(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

// Simple in-memory cache for SwimTopia roster
let cachedRoster = null;
let cachedRosterTime = 0;
const ROSTER_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// Simple in-memory cache for Swimmer Histories
const swimmerHistoryCache = new Map();
const HISTORY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export function clearSwimtopiaCache() {
    cachedRoster = null;
    cachedRosterTime = 0;
    swimmerHistoryCache.clear();
}

export async function getParklawnSwimtopiaLadder({
    token,
    today = new Date(),
    fetchImpl = fetch,
} = {}) {
    // Clear cache to ensure we get fresh data when manually importing/refreshing the ladder
    if (fetchImpl === fetch) {
        clearSwimtopiaCache();
    }

    const roster = await paginatedSwimtopiaFetch(`/mobile/organizations/${PARKLAWN_SWIMTOPIA_ORG_ID}/organization-users`, {
        token,
        params: { include: "affiliations" },
        fetchImpl,
    });

    if (fetchImpl === fetch) {
        cachedRoster = roster;
        cachedRosterTime = Date.now();
    }

    const affiliationsByUser = new Map();
    for (const affiliation of roster.included.filter((record) => record.type === "athleteAffiliation")) {
        const userId = affiliation.relationships?.organizationUser?.data?.id;
        if (!userId) continue;
        if (!affiliationsByUser.has(userId)) affiliationsByUser.set(userId, []);
        affiliationsByUser.get(userId).push(affiliation);
    }

    const athletes = roster.data.filter((user) => isCurrentAthlete(user, affiliationsByUser, today));
    const athleteById = new Map(athletes.map((athlete) => [athlete.id, athlete]));

    const events = await paginatedSwimtopiaFetch(`/mobile/organizations/${PARKLAWN_SWIMTOPIA_ORG_ID}/calendar-events`, {
        token,
        fetchImpl,
    });
    const upcomingMeet = pickUpcomingMeet(events.data, today);

    const absences = upcomingMeet
        ? await paginatedSwimtopiaFetch(`/mobile/swim-meets/${upcomingMeet.id}/swim-absences`, { token, fetchImpl })
        : { data: [] };

    const unavailable = [];
    for (const absence of absences.data) {
        if (absence.attributes?.isAttending !== false) continue;
        const athleteId = absence.relationships?.athlete?.data?.id;
        const athlete = athleteById.get(athleteId);
        if (athlete) unavailable.push(nameKey(athleteName(athlete.attributes)));
    }

    const ladder = { Boys: {}, Girls: {} };
    let resultCount = 0;
    await mapLimit(athletes.filter((athlete) => athlete.attributes?.hasSwimHistory), 8, async (athlete) => {
        const results = await swimtopiaApiFetch(
            `/mobile/organizations/${PARKLAWN_SWIMTOPIA_ORG_ID}/users/${athlete.id}/historical-results`,
            {
                token,
                params: { "filter[best_times_only]": true },
                fetchImpl,
            }
        );
        for (const result of highestDistanceResultsByStroke(results.data || [])) {
            if (addLadderEntry(ladder, athlete, result, today)) resultCount++;
        }
    });

    const importedAt = new Date();
    ladder.Date = `${String(importedAt.getMonth() + 1).padStart(2, "0")}-${String(importedAt.getDate()).padStart(2, "0")}-${importedAt.getFullYear()}`;

    return {
        ladder,
        unavailable,
        meet: upcomingMeet ? {
            id: upcomingMeet.id,
            name: upcomingMeet.attributes?.name,
            startAt: upcomingMeet.attributes?.startAt,
            startDate: upcomingMeet.attributes?.startDate,
            stage: upcomingMeet.attributes?.stage,
        } : null,
        stats: {
            athletes: athletes.length,
            swimmersWithHistory: athletes.filter((athlete) => athlete.attributes?.hasSwimHistory).length,
            resultEntries: resultCount,
            unavailable: unavailable.length,
        },
    };
}

export async function getParklawnSwimmerHistory({
    token,
    athleteId,
    fetchImpl = fetch,
} = {}) {
    if (!athleteId) {
        const error = new Error("A Parklawn SwimTopia athlete id is required.");
        error.status = 400;
        throw error;
    }

    const now = Date.now();
    if (fetchImpl === fetch) {
        const cached = swimmerHistoryCache.get(String(athleteId));
        if (cached && (now - cached.timestamp) < HISTORY_CACHE_TTL) {
            return cached.payload;
        }
    }

    let roster;
    if (fetchImpl === fetch && cachedRoster && (now - cachedRosterTime) < ROSTER_CACHE_TTL) {
        roster = cachedRoster;
    } else {
        roster = await paginatedSwimtopiaFetch(`/mobile/organizations/${PARKLAWN_SWIMTOPIA_ORG_ID}/organization-users`, {
            token,
            params: { include: "affiliations" },
            fetchImpl,
        });
        if (fetchImpl === fetch) {
            cachedRoster = roster;
            cachedRosterTime = now;
        }
    }

    const athlete = roster.data.find((user) => String(user.id) === String(athleteId));
    if (!athlete) {
        const error = new Error("That swimmer was not found in the Parklawn SwimTopia roster.");
        error.status = 404;
        throw error;
    }

    let payload;
    try {
        payload = await paginatedSwimtopiaFetch(
            `/mobile/organizations/${PARKLAWN_SWIMTOPIA_ORG_ID}/users/${athleteId}/historical-results`,
            {
                token,
                params: { include: "swimMeet" },
                fetchImpl,
            }
        );
    } catch (error) {
        payload = await paginatedSwimtopiaFetch(
            `/mobile/organizations/${PARKLAWN_SWIMTOPIA_ORG_ID}/users/${athleteId}/historical-results`,
            {
                token,
                fetchImpl,
            }
        );
    }

    const includedById = new Map(payload.included.map((record) => [record.id, record]));
    const history = [];
    for (const result of payload.data || []) {
        const attrs = result.attributes || {};
        const stroke = STROKE_BY_CODE[Number(attrs.strokeCode)];
        const distance = Number(attrs.distance);
        const time = formatTimeInt(attrs.officialTimeInt);
        const completedOn = attrs.completedOn || "";
        const age = resultAge(result, athlete);
        if (!stroke || ![25, 50].includes(distance) || !time || !completedOn) continue;

        history.push({
            id: result.id,
            time,
            seconds: secondsFromTimeInt(attrs.officialTimeInt),
            date: completedOn,
            year: new Date(completedOn).getFullYear(),
            stroke,
            distance,
            age,
            team: PARKLAWN_TEAM_ABBR,
            meet: resultMeetLabel(result, includedById),
        });
    }

    const highestDistanceByStroke = new Map();
    for (const entry of history) {
        highestDistanceByStroke.set(entry.stroke, Math.max(highestDistanceByStroke.get(entry.stroke) || 0, entry.distance));
    }
    const filteredHistory = history.filter((entry) => entry.distance === highestDistanceByStroke.get(entry.stroke));

    filteredHistory.sort((a, b) => {
        const dateDiff = new Date(b.date) - new Date(a.date);
        if (dateDiff !== 0) return dateDiff;
        if (a.stroke !== b.stroke) return a.stroke.localeCompare(b.stroke);
        return a.seconds - b.seconds;
    });

    const result = {
        swimmer: {
            id: athlete.id,
            name: athleteName(athlete.attributes),
            age: Number(athlete.attributes?.age) || null,
            gender: ladderGender(athlete.attributes?.gender).replace(/s$/, ""),
        },
        history: filteredHistory,
        stats: {
            resultEntries: filteredHistory.length,
            rawResultEntries: history.length,
        },
    };

    if (fetchImpl === fetch) {
        swimmerHistoryCache.set(String(athleteId), {
            payload: result,
            timestamp: now,
        });
    }

    return result;
}

export async function swimtopiaPasswordLogin({ username, password, fetchImpl = fetch } = {}) {
    if (!username || !password) {
        const error = new Error("Username and password are required.");
        error.status = 400;
        throw error;
    }

    const body = new URLSearchParams({
        grant_type: "password",
        username,
        password,
    });

    const response = await fetchImpl(`${SWIMTOPIA_API_BASE}/oauth/token`, {
        method: "POST",
        headers: formHeaders(),
        body,
    });
    const payload = await parseResponseBody(response);

    if (!response.ok) {
        const message = typeof payload === "object"
            ? (payload.error_description || payload.error || "SwimTopia login failed.")
            : String(payload || "SwimTopia login failed.");
        const error = new Error(message);
        error.status = response.status;
        error.payload = payload;
        throw error;
    }

    return payload;
}

export async function swimtopiaApiFetch(pathname, {
    token,
    params,
    method = "GET",
    body,
    fetchImpl = fetch,
} = {}) {
    if (!token) {
        const error = new Error("A SwimTopia bearer token is required.");
        error.status = 401;
        throw error;
    }

    const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
    const url = new URL(normalizedPath, SWIMTOPIA_API_BASE);
    const query = serializeParams(params);
    if (query) url.search = query;

    const response = await fetchImpl(url, {
        method,
        headers: jsonHeaders({
            "Authorization": bearerValue(token),
        }),
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await parseResponseBody(response);

    if (!response.ok) {
        const error = new Error(`SwimTopia API returned ${response.status} for ${normalizedPath}.`);
        error.status = response.status;
        error.payload = payload;
        throw error;
    }

    return payload;
}

export function summarizeJsonApiPayload(payload) {
    const data = payload?.data;
    const included = payload?.included;
    const records = Array.isArray(data) ? data : (data ? [data] : []);
    const includedRecords = Array.isArray(included) ? included : [];
    const types = {};

    for (const record of [...records, ...includedRecords]) {
        if (!record?.type) continue;
        types[record.type] = (types[record.type] || 0) + 1;
    }

    return {
        primaryCount: records.length,
        includedCount: includedRecords.length,
        types,
        firstRecord: records[0] ? {
            type: records[0].type,
            id: records[0].id,
            attributeKeys: Object.keys(records[0].attributes || {}),
            relationshipKeys: Object.keys(records[0].relationships || {}),
        } : null,
    };
}

export function buildSwimtopiaProbePlan({
    organizationId = PARKLAWN_SWIMTOPIA_ORG_ID,
    today = new Date(),
} = {}) {
    const year = today.getFullYear();
    const plan = [
        {
            key: "organizations",
            label: "Organizations visible to this coach",
            path: "/mobile/organizations",
            params: {},
        },
        {
            key: "swimMeets",
            label: "Upcoming/recent meets",
            path: "/mobile/swim-meets",
            params: {
                "filter[year]": year,
                include: "organization,swimSessions,swimTeams,nirvanaMeet",
            },
        },
        {
            key: "historicalResults",
            label: "Best times visible to this coach",
            path: "/mobile/historical-results",
            params: {
                "filter[best_times_only]": true,
            },
        },
    ];

    if (organizationId) {
        plan.splice(1, 0, {
            key: "organization",
            label: `Organization ${organizationId}`,
            path: `/mobile/organizations/${organizationId}`,
            params: {
                include: "organizationUsers,calendarEvents",
            },
        });
        plan.splice(2, 0, {
            key: "organizationUsers",
            label: `Organization ${organizationId} roster/users`,
            path: `/mobile/organizations/${organizationId}/organization-users`,
            params: {},
        });
    }

    return plan;
}

export async function probeSwimtopiaApi({
    token,
    organizationId = PARKLAWN_SWIMTOPIA_ORG_ID,
    fetchImpl = fetch,
} = {}) {
    const results = [];

    for (const item of buildSwimtopiaProbePlan({ organizationId })) {
        try {
            const payload = await swimtopiaApiFetch(item.path, {
                token,
                params: item.params,
                fetchImpl,
            });
            results.push({
                ...item,
                ok: true,
                summary: summarizeJsonApiPayload(payload),
            });
        } catch (error) {
            results.push({
                ...item,
                ok: false,
                status: error.status || 500,
                error: error.message,
                payload: typeof error.payload === "string" ? error.payload.slice(0, 500) : error.payload,
            });
        }
    }

    return results;
}
