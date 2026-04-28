import type {
	GameResults,
	PlayoffSeriesTeam,
	WeeklyTournamentSeries,
} from "../../../common/types.ts";
import { shuffle } from "../../../common/random.ts";
import getWinner from "../../../common/getWinner.ts";
import { g, helpers } from "../../util/index.ts";
import { league } from "../index.ts";
import setSchedule from "./setSchedule.ts";

type TeamForWeeklyTournament = {
	tid: number;
	seasonAttrs: {
		cid: number;
	};
};

const makeSeeds = (teams: TeamForWeeklyTournament[]): PlayoffSeriesTeam[] => {
	// MVP: seed in the input order. Caller is responsible for deterministic ordering.
	return teams.map((t, i) => ({
		tid: t.tid,
		cid: t.seasonAttrs.cid,
		seed: i + 1,
		won: 0,
		pts: undefined,
	}));
};

const selectEntrants = (
	teams: TeamForWeeklyTournament[],
	week: number,
): TeamForWeeklyTournament[] => {
	// MVP: pick 16 random active teams, but deterministically for a given league/season/week.
	// This avoids needing standings data, while still producing stable results on reload/resim.
	const seed =
		(g.get("lid") ?? 0) * 1000000 + g.get("season") * 1000 + Math.max(0, week);

	const shuffled = [...teams];
	shuffle(shuffled, seed);

	// If there are fewer than 16 teams (edge cases), just use all of them.
	return shuffled.slice(0, Math.min(16, shuffled.length));
};

// Standard bracket pairing: 1 vs N, 2 vs N-1, etc. Extra top seeds can get byes (away undefined).
const makeFirstRound = (seeded: PlayoffSeriesTeam[]) => {
	const teams = [...seeded].sort((a, b) => a.seed - b.seed);
	const matchups: { home: PlayoffSeriesTeam; away?: PlayoffSeriesTeam }[] = [];

	while (teams.length > 0) {
		const home = teams.shift()!;
		const away = teams.pop();
		matchups.push({
			home,
			away,
		});
	}

	return matchups;
};

const numRounds = (numTeams: number) => {
	return Math.ceil(Math.log2(Math.max(1, numTeams)));
};

const initSeries = (
	seeded: PlayoffSeriesTeam[],
): WeeklyTournamentSeries["series"] => {
	const rounds = numRounds(seeded.length);
	const series: WeeklyTournamentSeries["series"] = [];

	series[0] = makeFirstRound(seeded);
	for (let r = 1; r < rounds; r++) {
		// Preallocate correct length with placeholders. These get filled as teams advance.
		series[r] = Array(Math.ceil(series[r - 1]!.length / 2)).fill({
			home: {
				tid: -1,
				cid: -1,
				seed: 0,
				won: 0,
				pts: undefined,
			},
		});
	}

	return series;
};

export const startWeek = async (
	teams: TeamForWeeklyTournament[],
	week: number,
) => {
	const entrants = selectEntrants(teams, week);
	const seeded = makeSeeds(entrants);
	const state: WeeklyTournamentSeries = {
		season: g.get("season"),
		week,
		currentRound: 0,
		series: initSeries(seeded),
		complete: false,
	};

	// Persist state (not synced to UI unless added to gameAttributesSyncedToUi)
	await league.setGameAttributes({
		weeklyTournamentSeries: state,
	});

	// Schedule day 1: all matchups with 2 teams (no byes)
	const tids: [number, number][] = [];
	for (const matchup of state.series[0]!) {
		if (matchup.away) {
			tids.push([matchup.home.tid, matchup.away.tid]);
		}
	}

	console.log(
		"[weekly] startWeek week=",
		week,
		"entrants=",
		entrants.length,
		"games=",
		tids.length,
		"tids=",
		tids,
	);
	// setSchedule overwrites whatever is currently in the schedule store
	await setSchedule(tids);
};

// Called after each day's game results in "tennis" mode, analogous to updatePlayoffSeries.
// Updates home.won / away.won and tracks gids on the matching matchup.
export const updateWeeklyTournamentSeries = async (results: GameResults) => {
	const state = helpers.deepCopy(g.get("weeklyTournamentSeries"));
	if (!state || state.complete) return;

	const matchups = state.series[state.currentRound];
	if (!matchups) return;

	for (const result of results) {
		const tid0 = result.team[0].id;
		const tid1 = result.team[1].id;

		const matchup = matchups.find(
			(m) =>
				m.away &&
				((m.home.tid === tid0 && m.away.tid === tid1) ||
					(m.home.tid === tid1 && m.away.tid === tid0)),
		);
		if (!matchup || !matchup.away) continue;

		const { home, away } = matchup;
		if (home.pts === undefined) home.pts = 0;
		if (away.pts === undefined) away.pts = 0;

		const winner = getWinner([result.team[0].stat, result.team[1].stat]);

		if (home.tid === tid0) {
			home.pts += result.team[0].stat.pts;
			away.pts += result.team[1].stat.pts;
			if (winner === 0) home.won += 1;
			else away.won += 1;
		} else {
			away.pts += result.team[0].stat.pts;
			home.pts += result.team[1].stat.pts;
			if (winner === 0) away.won += 1;
			else home.won += 1;
		}

		if (matchup.gids === undefined) matchup.gids = [];
		matchup.gids.push(result.gid);
	}

	await league.setGameAttributes({ weeklyTournamentSeries: state });
};

// Called from cbNoGames when the schedule empties during a weekly tournament week.
// Mirrors newSchedulePlayoffsDay: advances the bracket if the round is done, or
// reschedules any remaining games if the round is still in progress.
// Returns true if the entire tournament week is complete.
export const advanceRound = async (): Promise<boolean> => {
	const state = helpers.deepCopy(g.get("weeklyTournamentSeries"));
	if (!state || state.complete) return true;

	const rnd = state.currentRound;
	const matchups = state.series[rnd];
	if (!matchups) return true;

	console.log(
		"[weekly] advanceRound: rnd=",
		rnd,
		"matchups=",
		matchups.map((m) => ({
			home: m.home.tid,
			homeWon: m.home.won,
			away: m.away?.tid,
			awayWon: m.away?.won,
		})),
	);

	// Collect any matchups whose game hasn't been played yet (won counts still 0).
	const tids: [number, number][] = [];
	for (const matchup of matchups) {
		if (!matchup.away) continue; // bye — auto-advanced
		if (matchup.home.won === 0 && matchup.away.won === 0) {
			tids.push([matchup.home.tid, matchup.away.tid]);
		}
	}

	// Round complete — determine winners.
	const winners: PlayoffSeriesTeam[] = [];
	for (const matchup of matchups) {
		const winner =
			!matchup.away || matchup.home.won > matchup.away.won
				? helpers.deepCopy(matchup.home)
				: helpers.deepCopy(matchup.away);
		winners.push(winner);
	}

	// Final round — tournament week is over.
	if (rnd === state.series.length - 1) {
		state.complete = true;
		state.championTid = winners[0]!.tid;
		await league.setGameAttributes({ weeklyTournamentSeries: state });
		return true;
	}

	// Populate next round matchups with winners, reset per-round stats.
	for (let i = 0; i < winners.length; i += 2) {
		const team1 = winners[i]!;
		const team2 = winners[i + 1];

		const lowerSeedHome = !team2 || team1.seed <= team2.seed;
		const home = lowerSeedHome ? team1 : team2!;
		const away = lowerSeedHome ? team2 : team1;

		state.series[rnd + 1]![Math.floor(i / 2)] = {
			home: { ...home, won: 0, pts: undefined },
			...(away ? { away: { ...away, won: 0, pts: undefined } } : {}),
		};
	}

	state.currentRound = rnd + 1;
	await league.setGameAttributes({ weeklyTournamentSeries: state });

	// Schedule next round's games and wait for cbNoGames to drive the following round.
	const nextTids: [number, number][] = state.series[rnd + 1]!.filter(
		(m) => m.away,
	).map((m) => [m.home.tid, m.away!.tid]);
	console.log("[weekly] advanceRound: scheduling next round tids=", nextTids);
	await setSchedule(nextTids);
	return false;
};

export const startWeek1 = async (teams: TeamForWeeklyTournament[]) => {
	await startWeek(teams, 1);
};
