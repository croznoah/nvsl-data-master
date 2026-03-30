/**
 * annealing_worker.js (More Competitive & Corrected Swim-Up)
 * This web worker performs a simulated annealing algorithm to determine the optimal swim meet lineup.
 * The logic has been updated to:
 * 1. Only allow the 'homeTeam' (PLP) to swim up, and only if explicitly flagged in the data.
 * 2. More aggressively re-optimize events with the fastest available swimmers.
 * 3. Sends a single, cumulative progress value back to the main thread.
 */

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
 * @param {Array} teamSwimmers - Team's swimmers in the event.
 * @param {Array} opponentSwimmers - Opponent's swimmers in the event.
 * @param {string} teamId - Team being optimized.
 * @returns {Object} Contains ourScore, theirScore, and security.
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
             originalAgeGroup: s[4] || eventAgeGroup  // Assume not swimming up if not provided
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
             // Only penalize if they wouldn't score in their natural group
             if (i >= 3) { // Positions 4+ don't score
                 // Big penalty - equivalent to 3 points (what they might score in natural group)
                 penalty += 3;
             }
         }
     }

     return { ourScore, theirScore, security, penalty };
 }


/**
 * Calculates total energy (score + security) for the lineup.
 * @param {Object} teamLineup - Team's lineup.
 * @param {Object} opponentLineup - Opponent's lineup.
 * @param {string} teamId - Team being optimized.
 * @returns {number} Negative combined score + security.
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

     // Combine score with security and penalty
     // Security weight: 1/601 ensures it only breaks ties
     // Penalty directly reduces score
     const securityWeight = 1 / 601;
     return -(totalScore + securityWeight * totalSecurity - totalPenalty);
 }

/**
 * Filters a pool of swimmers to find who is eligible for a specific event.
 * @param {Array} pool - The full list of swimmers for a team.
 * @param {Object} lineup - The current lineup being built (to check constraints).
 * @param {string} ageGroup - The age group of the event.
 * @param {string} stroke - The stroke of the event.
 * @param {string} teamId - The ID of the team being checked.
 * @param {string} homeTeamId - The ID of the home team, for the swim-up rule.
 * @returns {Array} A filtered list of eligible swimmers.
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
 * Creates a "neighbor" solution by re-optimizing a random event with the fastest available swimmers.
 * @param {Object} currentLineup - The current lineup solution.
 * @param {Array} swimmerPool - Array of full swimmer objects for the team, including all their times.
 * @param {Object} allEvents - The structure of all events in the meet.
 * @param {Array<string>} ageGroups - The list of age groups being considered.
 * @param {string} teamId - The ID of the team being optimized.
 * @param {string} homeTeamId - The ID of the home team, used for the swim-up rule.
 * @returns {Object} A new lineup object representing a neighboring state.
 */
 function getNeighbor(currentLineup, swimmerPool, allEvents, ageGroups, teamId, homeTeamId) {
     const newLineup = JSON.parse(JSON.stringify(currentLineup));
     const numEvents = ageGroups.length * Object.keys(allEvents[ageGroups[0]]).length;

     // Determine how many events to re-optimize (1, 2, or 3)
     const rand = Math.random();
     let eventsToOptimize = 1;
     if (rand < 0.7) eventsToOptimize = 1;
     else if (rand < 0.9) eventsToOptimize = 2;
     else eventsToOptimize = 3;

     // Select distinct random events to re-optimize
     const selectedEvents = new Set();
     while (selectedEvents.size < eventsToOptimize && selectedEvents.size < numEvents) {
         const ageGroup = ageGroups[Math.floor(Math.random() * ageGroups.length)];
         const stroke = Object.keys(allEvents[ageGroup])[Math.floor(Math.random() * Object.keys(allEvents[ageGroup]).length)];
         selectedEvents.add(JSON.stringify({ageGroup, stroke}));
     }

     // Clear selected events first to free up swimmers
     selectedEvents.forEach(eventStr => {
         const {ageGroup, stroke} = JSON.parse(eventStr);
         newLineup[ageGroup][stroke] = [];
     });

     // Reassign events in random order
     const shuffledEvents = Array.from(selectedEvents);
     for (let i = shuffledEvents.length - 1; i > 0; i--) {
         const j = Math.floor(Math.random() * (i + 1));
         [shuffledEvents[i], shuffledEvents[j]] = [shuffledEvents[j], shuffledEvents[i]];
     }

     shuffledEvents.forEach(eventStr => {
         const {ageGroup, stroke} = JSON.parse(eventStr);
         const eligible = getEligibleSwimmers(swimmerPool, newLineup, ageGroup, stroke, teamId, homeTeamId)
             .sort((a, b) => parseTime(a.times[stroke]) - parseTime(b.times[stroke]));

         // Take top 3 swimmers for this event
         newLineup[ageGroup][stroke] = eligible.slice(0, 3).map(swimmer =>
             // Store original age group as 5th element
             [swimmer.times[stroke], swimmer.age, swimmer.name, swimmer.team, swimmer.originalAgeGroup]
         );
     });

     return newLineup;
 }

/**
 * Generates an initial "greedy" lineup by picking the fastest available swimmers.
 * @param {Array} teamSwimmers - Array of full swimmer objects for the team.
 * @param {Object} allEvents - The structure of all events in the meet.
 * @param {Array<string>} ageGroups - The list of age groups being considered.
 * @param {string} teamId - The ID of the team being generated.
 * @param {string} homeTeamId - The ID of the home team, used for the swim-up rule.
 * @returns {Object} The initial greedy lineup.
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
                // Store original age group as 5th element
                return [swimmer.times[stroke], swimmer.age, swimmer.name, swimmer.team, swimmer.originalAgeGroup];
            });
        }
    }
    return lineup;
}

// --- MAIN ANNEALING LOGIC ---
function runAnnealing({ swimmerPool, opponentLineup, allEvents, ageGroups, teamId, homeTeamId }) {
    let temp = 50000;
    const coolingRate = 0.9992;
    const maxIterations = 80000;

    let currentSolution = generateGreedyLineup(swimmerPool, allEvents, ageGroups, teamId, homeTeamId);
    let currentEnergy = calculateTotalEnergy(currentSolution, opponentLineup, teamId);

    let bestSolution = JSON.parse(JSON.stringify(currentSolution));
    let bestEnergy = currentEnergy;

    for (let i = 0; i < maxIterations; i++) {
        const newSolution = getNeighbor(currentSolution, swimmerPool, allEvents, ageGroups, teamId, homeTeamId);
        const newEnergy = calculateTotalEnergy(newSolution, opponentLineup, teamId);

        const acceptanceProb = Math.exp((currentEnergy - newEnergy) / temp);

        if (acceptanceProb > Math.random()) {
            currentSolution = newSolution;
            currentEnergy = newEnergy;
        }

        if (newEnergy < bestEnergy) {
            bestSolution = newSolution;
            bestEnergy = newEnergy;
        }

        temp *= coolingRate;
    }

    console.log(`%c[${teamId}] Final Best Score for this run: ${-bestEnergy}`, 'color: yellow;');
    return bestSolution;
}

// Global scope for age groups to be accessible by helpers
const age_groups = {
    "8 & Under": { id: 1, ages: [5, 6, 7, 8] }, "9-10": { id: 2, ages: [9, 10] },
    "11-12": { id: 3, ages: [11, 12] }, "13-14": { id: 4, ages: [13, 14] },
    "15-18": { id: 5, ages: [15, 16, 17, 18] }
};

// --- WORKER MESSAGE HANDLER ---
self.onmessage = function(e) {
    const { swimmerDB, homeTeam, awayTeam, iterations, groups } = e.data;

    // *** NEW: Progress Calculation Setup ***
    const totalSteps = 1 + (iterations * 2); // 1 initial home team run + 2 runs per iteration
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

    let homeBestLineup = runAnnealing({
        swimmerPool: homeSwimmerPool, opponentLineup: opponentBestLineup,
        allEvents, ageGroups: groups, teamId: homeTeam, homeTeamId: homeTeam
    });
    completedSteps++;
    postMessage({ type: 'progress', progress: completedSteps / totalSteps });


    for (let i = 0; i < iterations; i++) {
        postMessage({ type: 'status', message: `Cycle ${i + 1}/${iterations}: Optimizing for ${awayTeam}...` });
        opponentBestLineup = runAnnealing({
            swimmerPool: awaySwimmerPool, opponentLineup: homeBestLineup,
            allEvents, ageGroups: groups, teamId: awayTeam, homeTeamId: homeTeam
        });
        completedSteps++;
        postMessage({ type: 'progress', progress: completedSteps / totalSteps });

        postMessage({ type: 'status', message: `Cycle ${i + 1}/${iterations}: Optimizing for ${homeTeam}...` });
        homeBestLineup = runAnnealing({
            swimmerPool: homeSwimmerPool, opponentLineup: opponentBestLineup,
            allEvents, ageGroups: groups, teamId: homeTeam, homeTeamId: homeTeam
        });
        completedSteps++;
        postMessage({ type: 'progress', progress: completedSteps / totalSteps });
    }

    // In the worker message handler (final scoring):
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
