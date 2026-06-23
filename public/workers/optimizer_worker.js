/**
 * optimizer_worker.js (Optimized with Integer Linear Programming)
 * This web worker performs lineup optimization using the javascript-lp-solver library.
 * It replaces the stochastic simulated annealing algorithm with an exact, deterministic ILP solver.
 */

// Import the Linear Programming solver
importScripts("https://cdn.jsdelivr.net/npm/javascript-lp-solver/prod/solver.js");

// --- UTILITY FUNCTIONS ---

/**
 * Parses a time string (e.g., "MM:SS.ss" or "SS.ss") into seconds.
 * @param {string} timeStr The time string to parse. Returns Infinity for invalid/missing times.
 * @returns {number} The time in seconds.
 */
function parseTime(timeStr) {
    if (!timeStr || typeof timeStr !== 'string') return Infinity;
    const parts = timeStr.split(':');
    let seconds = 0;
    if (parts.length === 2) {
        seconds += parseFloat(parts[0]) * 60;
        seconds += parseFloat(parts[1]);
    } else {
        seconds += parseFloat(parts[0]);
    }
    return isNaN(seconds) ? Infinity : seconds;
}

/**
 * Calculates event score and security metric for the team.
 * Used for final score calculations and fallback checks.
 */
function calculateEventScore(teamSwimmers, opponentSwimmers, teamId, eventAgeGroup) {
    const allEntries = [
        ...teamSwimmers.map(s => ({
            swimmer: s,
            time: parseTime(s[0]),
            team: s[3],
            originalAgeGroup: s[4]
        })),
        ...opponentSwimmers.map(s => ({
            swimmer: s,
            time: parseTime(s[0]),
            team: s[3],
            originalAgeGroup: s[4] || eventAgeGroup
        }))
    ];
    allEntries.sort((a, b) => a.time - b.time);

    // Calculate scores
    let ourScore = 0;
    let theirScore = 0;
    const points = [5, 3, 1, 0, 0, 0];
    for (let i = 0; i < Math.min(6, allEntries.length); i++) {
        if (allEntries[i].team === teamId) {
            ourScore += points[i];
        } else {
            theirScore += points[i];
        }
    }

    // Calculate security (time gaps for teamId in top positions)
    let security = 0;
    for (let i = 0; i < Math.min(3, allEntries.length); i++) {
        if (allEntries[i].team === teamId) {
            let found = false;
            for (let j = i + 1; j < allEntries.length; j++) {
                if (allEntries[j].team !== teamId) {
                    security += allEntries[j].time - allEntries[i].time;
                    found = true;
                    break;
                }
            }
            if (!found) security += 10; // No opponent behind
        }
    }

    // Calculate penalty for non-scoring swim-ups
    let penalty = 0;
    for (let i = 0; i < allEntries.length; i++) {
        const entry = allEntries[i];
        if (entry.team === teamId && entry.originalAgeGroup !== eventAgeGroup) {
            if (i >= 3) { // Positions 4+ don't score
                penalty += 3;
            }
        }
    }

    return { ourScore, theirScore, security, penalty };
}

/**
 * Calculates total energy (score + security) for the lineup.
 */
function calculateTotalEnergy(teamLineup, opponentLineup, teamId) {
    let totalScore = 0;
    let totalSecurity = 0;
    let totalPenalty = 0;

    for (const ageGroup in teamLineup) {
        for (const stroke in teamLineup[ageGroup]) {
            const teamSwimmers = teamLineup[ageGroup][stroke] || [];
            const opponentSwimmers = opponentLineup[ageGroup]?.[stroke] || [];
            if (teamSwimmers.length === 0 && opponentSwimmers.length === 0) continue;

            const eventResult = calculateEventScore(teamSwimmers, opponentSwimmers, teamId, ageGroup);
            totalScore += eventResult.ourScore;
            totalSecurity += eventResult.security;
            totalPenalty += eventResult.penalty;
        }
    }

    const securityWeight = 1 / 601;
    return -(totalScore + securityWeight * totalSecurity - totalPenalty);
}

/**
 * Filters a pool of swimmers to find who is eligible for a specific event.
 */
function getEligibleSwimmers(pool, lineup, ageGroup, stroke, teamId, homeTeamId) {
    const eventCounts = {};
    const swimmerStrokes = {};
    for (const ag in lineup) {
        for (const st in lineup[ag]) {
            for (const swimmer of lineup[ag][st]) {
                const name = swimmer[2];
                eventCounts[name] = (eventCounts[name] || 0) + 1;
                if (!swimmerStrokes[name]) swimmerStrokes[name] = {};
                if (!swimmerStrokes[name][ag]) swimmerStrokes[name][ag] = [];
                swimmerStrokes[name][ag].push(st);
            }
        }
    }

    return pool.filter(s => {
        const name = s.name;
        if (!s.times[stroke]) return false;
        if ((eventCounts[name] || 0) >= 2) return false;
        for (const ag in swimmerStrokes[name] || {}) {
            if ((swimmerStrokes[name][ag] || []).includes(stroke)) return false;
        }

        const isOwnGroup = s.originalAgeGroup === ageGroup;

        const isAllowedToSwimUp = (
            teamId === homeTeamId &&
            s.swimUpEvents &&
            s.swimUpEvents.includes(`${ageGroup}_${stroke}`)
        );

        return isOwnGroup || isAllowedToSwimUp;
    });
}

/**
 * Generates an initial "greedy" lineup.
 */
function generateGreedyLineup(teamSwimmers, allEvents, ageGroups, teamId, homeTeamId) {
    const lineup = {};
    for (const ageGroup of ageGroups) {
        lineup[ageGroup] = {};
        for (const stroke in allEvents[ageGroup]) {
            const availableForEvent = getEligibleSwimmers(teamSwimmers, lineup, ageGroup, stroke, teamId, homeTeamId)
                .sort((a, b) => parseTime(a.times[stroke]) - parseTime(b.times[stroke]));

            const swimmersForEvent = availableForEvent.slice(0, 3);
            lineup[ageGroup][stroke] = swimmersForEvent.map(swimmer => {
                return [swimmer.times[stroke], swimmer.age, swimmer.name, swimmer.team, swimmer.originalAgeGroup];
            });
        }
    }
    return lineup;
}

/**
 * Main optimization logic using javascript-lp-solver.
 * Formulates the swim meet assignment problem as an Integer Linear Program (ILP).
 */
function optimizeLineup({ swimmerPool, opponentLineup, allEvents, ageGroups, teamId, homeTeamId }) {
    // 1. Map swimmers and events to unique indices to keep variable names clean and safe
    const swimmersMap = {};
    const swimmersList = [];
    swimmerPool.forEach((swimmer, idx) => {
        swimmersMap[idx] = swimmer;
        swimmersList.push({ id: idx, swimmer });
    });

    const eventsList = [];
    const eventsMap = {};
    let eventIdx = 0;
    for (const ageGroup of ageGroups) {
        for (const stroke in allEvents[ageGroup]) {
            eventsMap[eventIdx] = { ageGroup, stroke };
            eventsList.push({ id: eventIdx, ageGroup, stroke });
            eventIdx++;
        }
    }

    // 2. Initialize the LP model object
    const model = {
        optimize: "objective",
        opType: "max",
        constraints: {},
        variables: {},
        ints: {}
    };

    const securityWeight = 1 / 601;

    // Safe parser that maps Infinity (like NT) to a large finite number (99999) to prevent LP solver errors
    const parseTimeSafe = (timeStr) => {
        const t = parseTime(timeStr);
        return t === Infinity ? 99999 : t;
    };

    // Helper to get opponent times sorted ascending
    const getOpponentTimes = (ageGroup, stroke) => {
        const opponentSwimmers = opponentLineup[ageGroup]?.[stroke] || [];
        return opponentSwimmers.map(s => parseTimeSafe(s[0])).sort((a, b) => a - b);
    };

    // 3. Define decision variables and constraints
    // y_sIdx_eIdx_role: swimmer `sIdx` swims event `eIdx` in `role` (1 = fastest, 2 = second, 3 = third)
    eventsList.forEach(event => {
        const { id: eIdx, ageGroup, stroke } = event;
        const oppTimes = getOpponentTimes(ageGroup, stroke);

        // Filter swimmers eligible for this specific event
        const eligibleSwimmers = swimmersList.filter(item => {
            const s = item.swimmer;
            if (!s.times[stroke]) return false;

            const isOwnGroup = s.originalAgeGroup === ageGroup;
            const isAllowedToSwimUp = (
                teamId === homeTeamId &&
                s.swimUpEvents &&
                s.swimUpEvents.includes(`${ageGroup}_${stroke}`)
            );
            return isOwnGroup || isAllowedToSwimUp;
        });

        // Pre-sort eligible swimmers by time to safely apply pairwise order constraints
        eligibleSwimmers.sort((a, b) => parseTimeSafe(a.swimmer.times[stroke]) - parseTimeSafe(b.swimmer.times[stroke]));

        eligibleSwimmers.forEach(item => {
            const sIdx = item.id;
            const swimmer = item.swimmer;
            const t_s = parseTimeSafe(swimmer.times[stroke]);

            // c = number of opponent swimmers faster than our swimmer
            let c = 0;
            for (const t_opp of oppTimes) {
                if (t_opp < t_s) c++;
            }

            // Find gap to the next slower opponent swimmer (for security calculation)
            let gap = 10;
            for (const t_opp of oppTimes) {
                if (t_opp > t_s && t_opp < 9999) {
                    gap = t_opp - t_s;
                    break;
                }
            }

            // A swimmer can occupy Role 1, Role 2, or Role 3 in an event
            for (let role = 1; role <= 3; role++) {
                const varName = `y_${sIdx}_${eIdx}_${role}`;
                const overallRank = c + role - 1;

                // Points: 1st place = 5, 2nd place = 3, 3rd place = 1, others = 0
                let points = 0;
                if (overallRank === 0) points = 5;
                else if (overallRank === 1) points = 3;
                else if (overallRank === 2) points = 1;

                // Security value: only contributes if placing in top 3 overall
                const securityVal = (overallRank < 3) ? gap : 0;

                // Penalty: 3 points if swimming up and not placing/scoring in top 3 overall
                const penaltyVal = (swimmer.originalAgeGroup !== ageGroup && overallRank >= 3) ? 3 : 0;

                // Tiny reward to ensure lanes are filled even if swimmers earn 0 points
                const participationReward = 2e-6;
                // Exceedingly tiny tie-breaker to prefer faster swimmers in the same point bracket
                const speedTieBreaker = -1e-8 * Math.min(t_s, 120);

                const objCoeff = points + securityWeight * securityVal - penaltyVal + participationReward + speedTieBreaker;

                // Add to model variables
                model.variables[varName] = {
                    objective: objCoeff
                };
                model.ints[varName] = 1;

                // Constraint: Binary variable (must be <= 1)
                const binaryLimitName = `bin_${varName}`;
                model.constraints[binaryLimitName] = { max: 1 };
                model.variables[varName][binaryLimitName] = 1;

                // Constraint: At most one swimmer per role in each event: sum_{s} y_{s, e, r} <= 1
                const roleLimitName = `role_limit_e${eIdx}_r${role}`;
                if (!model.constraints[roleLimitName]) {
                    model.constraints[roleLimitName] = { max: 1 };
                }
                model.variables[varName][roleLimitName] = 1;

                // Constraint: At most one role per swimmer in each event: sum_{r} y_{s, e, r} <= 1
                const swimmerEventLimitName = `swimmer_event_limit_s${sIdx}_e${eIdx}`;
                if (!model.constraints[swimmerEventLimitName]) {
                    model.constraints[swimmerEventLimitName] = { max: 1 };
                }
                model.variables[varName][swimmerEventLimitName] = 1;

                // Constraint: At most 2 events per swimmer: sum_{e, r} y_{s, e, r} <= 2
                const swimmerLimitName = `swimmer_total_limit_s${sIdx}`;
                if (!model.constraints[swimmerLimitName]) {
                    model.constraints[swimmerLimitName] = { max: 2 };
                }
                model.variables[varName][swimmerLimitName] = 1;

                // Constraint: Order filling. Ensure roles are filled in order (Role 1 -> Role 2 -> Role 3)
                // Enforced via:
                // sum_{s} y_{s, e, 1} - sum_{s} y_{s, e, 2} >= 0
                // sum_{s} y_{s, e, 2} - sum_{s} y_{s, e, 3} >= 0
                if (role === 1) {
                    const order12Name = `order_e${eIdx}_r12`;
                    if (!model.constraints[order12Name]) {
                        model.constraints[order12Name] = { min: 0 };
                    }
                    model.variables[varName][order12Name] = 1;
                } else if (role === 2) {
                    const order12Name = `order_e${eIdx}_r12`;
                    if (!model.constraints[order12Name]) {
                        model.constraints[order12Name] = { min: 0 };
                    }
                    model.variables[varName][order12Name] = -1;

                    const order23Name = `order_e${eIdx}_r23`;
                    if (!model.constraints[order23Name]) {
                        model.constraints[order23Name] = { min: 0 };
                    }
                    model.variables[varName][order23Name] = 1;
                } else if (role === 3) {
                    const order23Name = `order_e${eIdx}_r23`;
                    if (!model.constraints[order23Name]) {
                        model.constraints[order23Name] = { min: 0 };
                    }
                    model.variables[varName][order23Name] = -1;
                }
            }
        });

        // 4. Pairwise sorting constraints:
        // Since eligibleSwimmers is pre-sorted by time (ascending):
        // If i < j, swimmer i is faster than swimmer j.
        // Therefore, swimmer j (slower) cannot occupy a faster role than swimmer i.
        // - y_{sb, e, 1} + y_{sa, e, 2} <= 1
        // - y_{sb, e, 2} + y_{sa, e, 3} <= 1
        // - y_{sb, e, 1} + y_{sa, e, 3} <= 1
        for (let i = 0; i < eligibleSwimmers.length; i++) {
            for (let j = i + 1; j < eligibleSwimmers.length; j++) {
                const sIdx_a = eligibleSwimmers[i].id; // faster swimmer
                const sIdx_b = eligibleSwimmers[j].id; // slower swimmer

                const pair12Name = `pair_e${eIdx}_sa${sIdx_a}_sb${sIdx_b}_r12`;
                model.constraints[pair12Name] = { max: 1 };
                model.variables[`y_${sIdx_b}_${eIdx}_1`][pair12Name] = 1;
                model.variables[`y_${sIdx_a}_${eIdx}_2`][pair12Name] = 1;

                const pair23Name = `pair_e${eIdx}_sa${sIdx_a}_sb${sIdx_b}_r23`;
                model.constraints[pair23Name] = { max: 1 };
                model.variables[`y_${sIdx_b}_${eIdx}_2`][pair23Name] = 1;
                model.variables[`y_${sIdx_a}_${eIdx}_3`][pair23Name] = 1;

                const pair13Name = `pair_e${eIdx}_sa${sIdx_a}_sb${sIdx_b}_r13`;
                model.constraints[pair13Name] = { max: 1 };
                model.variables[`y_${sIdx_b}_${eIdx}_1`][pair13Name] = 1;
                model.variables[`y_${sIdx_a}_${eIdx}_3`][pair13Name] = 1;
            }
        }
    });

    // 5. Solve the optimization model
    const solution = solver.Solve(model);

    // Initialize clean empty lineup
    const optimizedLineup = {};
    for (const ageGroup of ageGroups) {
        optimizedLineup[ageGroup] = {};
        for (const stroke in allEvents[ageGroup]) {
            optimizedLineup[ageGroup][stroke] = [];
        }
    }

    // Fallback if model is infeasible
    if (!solution.feasible) {
        console.warn(`[${teamId}] ILP solver returned infeasible! Falling back to greedy initialization.`);
        return generateGreedyLineup(swimmerPool, allEvents, ageGroups, teamId, homeTeamId);
    }

    // 6. Map active decision variables back to lineup arrays
    Object.keys(solution).forEach(varName => {
        if (varName.startsWith('y_') && solution[varName] > 0.5) {
            const parts = varName.split('_');
            const sIdx = parseInt(parts[1], 10);
            const eIdx = parseInt(parts[2], 10);
            const role = parseInt(parts[3], 10);

            const swimmer = swimmersMap[sIdx];
            const event = eventsMap[eIdx];

            const swimmerArr = [
                swimmer.times[event.stroke],
                swimmer.age,
                swimmer.name,
                swimmer.team,
                swimmer.originalAgeGroup
            ];

            // Assign to role index (role 1 = index 0, role 2 = index 1, role 3 = index 2)
            optimizedLineup[event.ageGroup][event.stroke][role - 1] = swimmerArr;
        }
    });

    // Remove any empty slots and ensure array is compact
    for (const ageGroup of ageGroups) {
        for (const stroke in allEvents[ageGroup]) {
            optimizedLineup[ageGroup][stroke] = optimizedLineup[ageGroup][stroke].filter(s => s !== undefined);
        }
    }

    console.log(`%c[${teamId}] Final Best Score for this run: ${solution.result}`, 'color: green;');
    return optimizedLineup;
}

// Global scope for age groups
const age_groups = {
    "8 & Under": { id: 1, ages: [5, 6, 7, 8] }, "9-10": { id: 2, ages: [9, 10] },
    "11-12": { id: 3, ages: [11, 12] }, "13-14": { id: 4, ages: [13, 14] },
    "15-18": { id: 5, ages: [15, 16, 17, 18] }
};

// --- WORKER MESSAGE HANDLER ---
self.onmessage = function(e) {
    const { swimmerDB, homeTeam, awayTeam, iterations, groups } = e.data;

    // Progress Calculation Setup
    const totalSteps = 1 + (iterations * 2);
    let completedSteps = 0;

    const homeSwimmerPool = Object.values(swimmerDB[homeTeam]);
    const awaySwimmerPool = Object.values(swimmerDB[awayTeam]);

    const allEvents = {};
    for (const group of groups) {
        allEvents[group] = {};
        for(const stroke of ['Freestyle', 'Backstroke', 'Breaststroke', 'Butterfly']) {
             allEvents[group][stroke] = [];
        }
    }

    postMessage({ type: 'status', message: 'Generating initial lineups...' });
    let opponentBestLineup = generateGreedyLineup(awaySwimmerPool, allEvents, groups, awayTeam, homeTeam);

    let homeBestLineup = optimizeLineup({
        swimmerPool: homeSwimmerPool, opponentLineup: opponentBestLineup,
        allEvents, ageGroups: groups, teamId: homeTeam, homeTeamId: homeTeam
    });
    completedSteps++;
    postMessage({ type: 'progress', progress: completedSteps / totalSteps });

    for (let i = 0; i < iterations; i++) {
        postMessage({ type: 'status', message: `Cycle ${i + 1}/${iterations}: Optimizing for ${awayTeam}...` });
        opponentBestLineup = optimizeLineup({
            swimmerPool: awaySwimmerPool, opponentLineup: homeBestLineup,
            allEvents, ageGroups: groups, teamId: awayTeam, homeTeamId: homeTeam
        });
        completedSteps++;
        postMessage({ type: 'progress', progress: completedSteps / totalSteps });

        postMessage({ type: 'status', message: `Cycle ${i + 1}/${iterations}: Optimizing for ${homeTeam}...` });
        homeBestLineup = optimizeLineup({
            swimmerPool: homeSwimmerPool, opponentLineup: opponentBestLineup,
            allEvents, ageGroups: groups, teamId: homeTeam, homeTeamId: homeTeam
        });
        completedSteps++;
        postMessage({ type: 'progress', progress: completedSteps / totalSteps });
    }

    // Final scoring
    let plpFinalScore = 0;
    let fxFinalScore = 0;
    for (const ageGroup of groups) {
        for (const stroke in allEvents[ageGroup]) {
            const eventResult = calculateEventScore(
                homeBestLineup[ageGroup]?.[stroke] || [],
                opponentBestLineup[ageGroup]?.[stroke] || [],
                homeTeam,
                ageGroup
            );
            plpFinalScore += eventResult.ourScore;
            fxFinalScore += eventResult.theirScore;
        }
    }

    const finalLineups = {
        [homeTeam]: { ...homeBestLineup, score: plpFinalScore },
        [awayTeam]: { ...opponentBestLineup, score: fxFinalScore },
    };

    postMessage({ type: 'done', lineups: finalLineups });
};
